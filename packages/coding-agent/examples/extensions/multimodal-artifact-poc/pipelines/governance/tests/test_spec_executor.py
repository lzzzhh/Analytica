"""Spec-driven execution tests — approval-bound writes only.

design -> review -> APPROVE -> seal -> execute_approved_spec -> write.
Any attempt to execute an unapproved spec (or a spec whose target has no
approved placement / CDXR) is refused by the gate.
"""
import json
import sys
import uuid
from pathlib import Path

import pyarrow as pa
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.batch.spec_executor import _apply_field_mappings, execute_approved_spec  # noqa: E402
from pipelines.common.write_gate import WriteGate  # noqa: E402
from pipelines.governance.coordinator import GovernanceCoordinator  # noqa: E402
from pipelines.governance.event_store import EventStore  # noqa: E402
from pipelines.governance.flow import GovernancePhase1  # noqa: E402
from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.schema_designer import SchemaDesigner  # noqa: E402
from pipelines.governance.placement import CONTROLLED_TARGETS, PlacementGovernance  # noqa: E402


class _On:
    def is_effective(self, _fid):  # type: ignore[no-untyped-def]
        return True


def _profile() -> dict:
    return {
        "datasetId": "source.apps", "schemaHash": "sha256:abc", "rowCount": 3,
        "fields": [{"name": "id", "type": "string"}, {"name": "amount", "type": "double"}],
        "candidateKeys": [{"fields": ["id"], "fullScanVerified": True}],
        "candidateEventTimes": [],
        "sensitiveFieldCandidates": [],
        "nullRates": {}, "cardinality": {}, "partitionStats": {}, "fileStats": {},
    }


def _design_json() -> str:
    return json.dumps({
        "businessGranularity": "one row per event",
        "primaryKey": ["id"], "businessKeys": [], "timeFields": [],
        "fieldMappings": [
            {"sourceField": "id", "targetField": "id", "targetType": "string"},
            {"sourceField": "amount", "targetField": "amount", "targetType": "double"},
        ],
        "partitioning": [], "sensitiveFields": [],
        "executionMode": "BATCH", "executionBackend": "PYICEBERG_LOCAL",
        "updateMode": "APPEND", "timeSemantics": "PROCESSING_TIME",
        "assumptions": [], "risks": [],
    })


def _seal_approved(repo, target: str) -> tuple[dict, dict]:
    coord = GovernanceCoordinator(repo, EventStore(repo), resolver=_On())
    d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": _design_json()})
    r = coord.design_schema(_profile(), "usage", f"pipeline_{uuid.uuid4().hex[:6]}",
                            target, designer=d, run_id=f"run_{uuid.uuid4().hex[:8]}")
    assert r["ok"], r
    flow = GovernancePhase1(repo)
    review = flow.create_review_package(r["schemaSpec"], r["pipelineSpec"])
    approval = flow.approve(review["reviewId"], "APPROVE", os_actor="tester")
    flow.seal_approved(review["reviewId"], approval)
    # Gate 3: placement approval
    pg = PlacementGovernance(repo)
    plan = {
        "placementPlanId": f"pp_{uuid.uuid4().hex[:12]}", "version": 1,
        "sourceDataset": "source", "targetLayer": target.split(".")[0].upper(),
        "targetDataset": target, "rationale": "test",
        "grainDetail": "one row per unit" if target.startswith("dwd") else "",
        "derivation": "RAW" if target.startswith("ods") else "DERIVED",
        "primaryKey": ["id"] if not target.startswith("ods") else [],
        "partitioning": [], "writeMode": "APPEND",
        "schemaEvolutionPolicy": "ADDITIVE", "retentionPolicy": "default",
        "backfillRequired": False, "affectedDownstream": [],
        "qualityGateRefs": [], "assumptions": [], "risks": [],
        "targetSchemaRef": "schema-spec:latest", "status": "DRAFT",
    }
    proposed = pg.propose(plan)
    pg.approve(proposed["placementPlanId"], os_actor="tester")
    return r["schemaSpec"], r["pipelineSpec"]


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


class TestFieldMappings:
    def test_rename_and_cast(self):
        tbl = pa.table({"src_id": pa.array(["1"], pa.string()),
                        "amount": pa.array([1.5], pa.float64())})
        out = _apply_field_mappings(tbl, [
            {"sourceField": "src_id", "targetField": "id", "targetType": "string"},
            {"sourceField": "amount", "targetField": "amount", "targetType": "double"},
        ])
        assert out.column_names == ["id", "amount"]
        assert pa.types.is_string(out.schema.field("id").type)


class TestExecuteApprovedSpec:
    def test_execute_with_full_governance(self, repo, tmp_path):
        schema_spec, pipeline_spec = _seal_approved(repo, "ods.streaming_events")
        from pipelines.common.config import open_catalog, ensure_namespaces
        catalog = open_catalog(tmp_path / "wh")
        ensure_namespaces(catalog)
        gate = WriteGate(repo)
        approval = repo.ledger()[0]  # any approval id is bound to the target
        # find the sealed approval id for this target
        approval_id = None
        for entry in repo.ledger():
            if entry["type"] == "approved-pipeline-spec":
                obj = repo.get("approved-pipeline-spec", entry["id"], entry["version"])
                if obj.content and pipeline_spec["specId"] == entry["id"]:
                    approval_id = obj.content["approvalId"]
        assert approval_id, "sealed approval missing"
        src = pa.table({"id": pa.array(["a", "b"], pa.string()),
                        "amount": pa.array([1.0, 2.0], pa.float64())})
        snap = execute_approved_spec(gate, catalog, pipeline_spec, schema_spec,
                                     src, approval_id)
        assert snap is not None
        assert catalog.table_exists("ods.streaming_events")
        # traceability: write-audit record bound to the approval
        audits = [e for e in repo.ledger() if e["type"] == "write-audit"]
        assert audits, "write-audit record missing"
        audit = repo.get("write-audit", audits[0]["id"], 1).content
        assert audit["approvalId"] == approval_id
        assert audit["target"] == "ods.streaming_events"

    def test_unapproved_spec_refused(self, repo, tmp_path):
        gate = WriteGate(repo)
        catalog = None  # gate must fail before any write
        schema_spec = {"fieldMappings": []}
        pipeline_spec = {"target": "ods.streaming_events"}
        with pytest.raises(PermissionError):
            execute_approved_spec(gate, catalog, pipeline_spec, schema_spec,
                                  pa.table({}), "approval_never_granted")
