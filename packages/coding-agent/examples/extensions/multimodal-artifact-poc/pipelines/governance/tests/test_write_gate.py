"""WriteGate tests — the enforced write boundary.

Proves the governance invariants are mechanical, not optional:
- arbitrary target / missing approval → PermissionError (write impossible)
- sealed approval (design → review → approve → seal) enables ODS/DWD writes
- dws/ads targets additionally require an approved CDXR feature-promotion
  review before any write
- batch run with a gate refuses without approvals; bypass() is test-only
"""
import json
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.common.write_gate import WriteGate  # noqa: E402
from pipelines.governance.coordinator import GovernanceCoordinator  # noqa: E402
from pipelines.governance.flow import GovernancePhase1  # noqa: E402
from pipelines.governance.event_store import EventStore  # noqa: E402
from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.schema_designer import SchemaDesigner  # noqa: E402
from pipelines.tests.helpers import TestOnlyWriteGate  # noqa: E402


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


class _On:
    def is_effective(self, _fid):  # type: ignore[no-untyped-def]
        return True


def _placement_approve(repo, target: str) -> None:
    """Gate 3: a placement plan for the target must be operator-approved."""
    from pipelines.governance.placement import PlacementGovernance
    layer = target.split(".", 1)[0].upper()
    plan = {
        "placementPlanId": f"pp_{uuid.uuid4().hex[:12]}", "version": 1,
        "sourceDataset": "source", "targetLayer": layer,
        "targetSchemaRef": "schema-spec:latest",
        "targetDataset": target, "rationale": "e2e placement",
        "grainDetail": "one row per unit" if layer != "ODS" else "",
        "derivation": "RAW" if layer == "ODS" else "DERIVED",
        "primaryKey": ["id"] if layer != "ODS" else [],
        "partitioning": [], "writeMode": "APPEND",
        "schemaEvolutionPolicy": "ADDITIVE", "retentionPolicy": "default",
        "backfillRequired": False, "affectedDownstream": [],
        "qualityGateRefs": [], "assumptions": [], "risks": [],
        "status": "DRAFT",
    }
    pg = PlacementGovernance(repo)
    proposed = pg.propose(plan)
    pg.approve(proposed["placementPlanId"], os_actor="tester")


def _profile() -> dict:
    return {
        "datasetId": "source.apps", "schemaHash": "sha256:abc", "rowCount": 100,
        "fields": [{"name": "id", "type": "string"}, {"name": "val", "type": "double"}],
        "candidateKeys": [{"fields": ["id"], "fullScanVerified": True}],
        "candidateEventTimes": [],
        "sensitiveFieldCandidates": [],
        "nullRates": {}, "cardinality": {}, "partitionStats": {}, "fileStats": {},
    }


def _design_json(target: str) -> str:
    return json.dumps({
        "businessGranularity": "one row per entity",
        "primaryKey": ["id"], "businessKeys": ["id"], "timeFields": [],
        "fieldMappings": [
            {"sourceField": "id", "targetField": "id", "targetType": "string"},
            {"sourceField": "val", "targetField": "val", "targetType": "double"},
        ],
        "partitioning": [], "sensitiveFields": [],
        "executionMode": "BATCH", "executionBackend": "PYICEBERG_LOCAL",
        "updateMode": "APPEND", "timeSemantics": "PROCESSING_TIME",
        "assumptions": [], "risks": [],
    })


def _design_and_approve(repo, target: str) -> dict:
    """Full Gate-1 flow: agent design → review → APPROVE → seal. Returns
    the sealed approved-pipeline-spec (target -> pipelineSpecId)."""
    coord = GovernanceCoordinator(repo, EventStore(repo), resolver=_On())
    d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": _design_json(target)})
    r = coord.design_schema(_profile(), "usage", f"pipeline_{uuid.uuid4().hex[:6]}",
                            target, designer=d, run_id=f"run_{uuid.uuid4().hex[:8]}")
    assert r["ok"], r
    flow = GovernancePhase1(repo)
    review = flow.create_review_package(r["schemaSpec"], r["pipelineSpec"])
    approval = flow.approve(review["reviewId"], "APPROVE", os_actor="tester")
    sealed = flow.seal_approved(review["reviewId"], approval)
    _placement_approve(repo, target)
    return sealed


class TestWriteGateEnforcement:
    def test_uncontrolled_target_refused(self, repo):
        gate = WriteGate(repo)
        with pytest.raises(PermissionError, match="not a controlled harness target"):
            gate.require_approved("ads.some_random_table")

    def test_controlled_but_no_approval_refused(self, repo):
        gate = WriteGate(repo)
        with pytest.raises(PermissionError, match="no sealed approval"):
            gate.require_approved("ods.streaming_events")

    def test_forged_seal_and_placement_fields_do_not_authorize(self, repo):
        repo.put("pipeline-spec", "forged", 1, {"target": "ods.streaming_events"})
        repo.put("approved-pipeline-spec", "forged", 1, {
            "approvalId": "forged_approval",
        })
        repo.put("placement-plan", "forged", 1, {
            "status": "APPROVED", "targetDataset": "ods.streaming_events",
        })

        with pytest.raises(PermissionError, match="no sealed approval"):
            WriteGate(repo).require_approved(
                "ods.streaming_events", approval_id="forged_approval")

    def test_ods_approval_enables_write(self, repo):
        sealed = _design_and_approve(repo, "ods.streaming_events")
        gate = WriteGate(repo)
        gate.require_approved("ods.streaming_events")  # must not raise
        # approval binding is checked too
        with pytest.raises(PermissionError, match="approvalId"):
            gate.require_approved("ods.streaming_events", approval_id="wrong-id")
        gate.require_approved("ods.streaming_events", approval_id=sealed["approvalId"])

    def test_tampered_seal_hash_invalidates_authorization(self, repo):
        sealed = _design_and_approve(repo, "ods.streaming_events")
        path = (repo.objects_dir / "approved-pipeline-spec" /
                f"{sealed['specId']}@{sealed['version']}.json")
        tampered = json.loads(path.read_text(encoding="utf-8"))
        tampered["pipelineSpecHash"] = "sha256:" + "0" * 64
        path.write_text(json.dumps(tampered), encoding="utf-8")

        with pytest.raises(PermissionError, match="no sealed approval"):
            WriteGate(repo).require_approved(
                "ods.streaming_events", approval_id=sealed["approvalId"])

    def test_dws_requires_cdxr_review(self, repo):
        _design_and_approve(repo, "dws.feature_values")
        gate = WriteGate(repo)
        # approval alone is not enough for dws/ads
        with pytest.raises(PermissionError, match="CDXR feature-promotion review"):
            gate.require_approved("dws.feature_values")
        # grant an approved CDXR review for the same dataset
        from pipelines.governance.cdxr_gate import CdxrPromotionGate
        cdxr = CdxrPromotionGate(repo, cdxr_caller=lambda _u: {
            "status": "ALLOW", "summary": "no leakage", "ruleFindings": []})
        review = cdxr.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values",
                                           {"purpose": "training"})
        cdxr.decide(review["reviewId"], "APPROVE", os_actor="tester")
        gate.require_approved("dws.feature_values")  # must not raise

    def test_other_dataset_cdxr_does_not_cover_target(self, repo):
        _design_and_approve(repo, "dws.feature_values")
        from pipelines.governance.cdxr_gate import CdxrPromotionGate
        cdxr = CdxrPromotionGate(repo, cdxr_caller=lambda _u: {
            "status": "ALLOW", "summary": "ok", "ruleFindings": []})
        review = cdxr.on_feature_candidate("pipeline_1", "run_1", "dws.prediction_points",
                                           {"purpose": "training"})
        cdxr.decide(review["reviewId"], "APPROVE", os_actor="tester")
        gate = WriteGate(repo)
        with pytest.raises(PermissionError, match="CDXR"):
            gate.require_approved("dws.feature_values")

    def test_publish_writes_through_gate(self, repo, tmp_path):
        """publish() runs the gate then writes via the stages path."""
        import pyarrow as pa
        from pipelines.common.config import open_catalog, ensure_namespaces
        sealed = _design_and_approve(repo, "ods.streaming_events")
        warehouse = tmp_path / "wh"
        catalog = open_catalog(warehouse)
        ensure_namespaces(catalog)
        gate = WriteGate(repo)
        tbl = pa.table({"k": pa.array([1], pa.int64())})
        snap = gate.publish(catalog, "ods.streaming_events", tbl,
                            approval_id=sealed["approvalId"])
        assert snap is not None
        assert catalog.table_exists("ods.streaming_events")


class TestBatchGateIntegration:
    def test_run_batch_refuses_without_approval(self, tmp_path, repo):
        from pipelines.batch.run_batch import run_batch
        from pipelines.common.config import PipelineConfig
        cfg = PipelineConfig(root=tmp_path / "pt", mode="batch", profile="small")
        gate = WriteGate(repo)
        # batch targets are outside the governance CONTROLLED_TARGETS, so
        # the gate refuses regardless of which check fires first
        with pytest.raises(PermissionError, match="controlled harness target|sealed approval"):
            run_batch(cfg, gate=gate)

    def test_run_batch_uses_explicit_test_only_gate(self, tmp_path, repo):
        from pipelines.batch.run_batch import run_batch
        from pipelines.common.config import PipelineConfig
        cfg = PipelineConfig(root=tmp_path / "pt", mode="batch", profile="small")
        m = run_batch(cfg, gate=TestOnlyWriteGate())
        assert m.layers

    def test_standard_batch_writes_are_audited_and_idempotent(self, tmp_path, repo):
        from pipelines.batch.run_batch import TARGET_TABLES, run_batch
        from pipelines.common.config import PipelineConfig
        from pipelines.governance.cdxr_gate import CdxrPromotionGate

        for target in TARGET_TABLES:
            _design_and_approve(repo, target)
            if target.startswith(("dws.", "ads.")):
                cdxr = CdxrPromotionGate(repo, cdxr_caller=lambda _u: {
                    "status": "ALLOW", "summary": "test assessment",
                    "ruleFindings": [],
                })
                review = cdxr.on_feature_candidate(
                    "pipeline_test", "run_test", target, {"purpose": "evaluation"})
                cdxr.decide(review["reviewId"], "APPROVE", os_actor="tester")

        cfg = PipelineConfig(root=tmp_path / "audited", mode="batch", profile="small")
        gate = WriteGate(repo)
        first = run_batch(cfg, gate)
        second = run_batch(cfg, gate)

        first_snapshots = {record["table"]: record["snapshotId"]
                           for record in first.layers.values()}
        second_snapshots = {record["table"]: record["snapshotId"]
                            for record in second.layers.values()}
        assert first_snapshots == second_snapshots
        audits = [
            repo.get("write-audit", entry["id"], entry["version"]).content
            for entry in repo.ledger() if entry["type"] == "write-audit"
        ]
        committed = [audit for audit in audits if audit["status"] == "COMMITTED"]
        assert len(committed) == len(TARGET_TABLES)
        assert {audit["target"] for audit in committed} == set(TARGET_TABLES)
        assert all(audit["approvalId"] for audit in committed)
        assert all(audit["batchId"].startswith(f"batch_{cfg.run_id}:")
                   for audit in committed)

    def test_standard_streaming_writes_are_audited_and_idempotent(self, tmp_path, repo):
        from pipelines.common.config import PipelineConfig
        from pipelines.streaming.run_streaming import run_streaming

        _design_and_approve(repo, "ods.streaming_events")
        cfg = PipelineConfig(root=tmp_path / "stream-audited", mode="streaming", profile="small")
        gate = WriteGate(repo)
        first = run_streaming(cfg, gate)
        committed_after_first = [
            repo.get("write-audit", entry["id"], entry["version"]).content
            for entry in repo.ledger() if entry["type"] == "write-audit"
            and repo.get("write-audit", entry["id"], entry["version"]).content["status"] == "COMMITTED"
        ]
        second = run_streaming(cfg, gate)
        committed_after_second = [
            entry for entry in repo.ledger() if entry["type"] == "write-audit"
            and repo.get("write-audit", entry["id"], entry["version"]).content["status"] == "COMMITTED"
        ]

        assert first.success and second.success
        assert committed_after_first
        assert len(committed_after_second) == len(committed_after_first)
        assert all(audit["approvalId"] for audit in committed_after_first)
        assert all(audit["batchId"].startswith(f"stream_{cfg.run_id}_")
                   for audit in committed_after_first)
