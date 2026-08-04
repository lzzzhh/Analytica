"""Schema Designer tests — the DESIGN role of the Pipeline Governance Agent.

- deterministic profile in → injected LLM caller → validated SchemaSpec +
  PipelineSpec draft (Gate-1 reviewable)
- fabricated fields / invalid JSON / failed caller all fail loudly
- coordinator.design_schema persists specs, emits SCHEMA_DESIGNED and is
  feature-gated (round2.pipeline_schema_design)
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.coordinator import GovernanceCoordinator  # noqa: E402
from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.schema_designer import SchemaDesigner  # noqa: E402
from pipelines.governance.contracts import is_valid_contract  # noqa: E402


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


def _profile() -> dict:
    return {
        "datasetId": "source.application_events",
        "schemaHash": "sha256:abc",
        "rowCount": 1000,
        "fields": [
            {"name": "application_id", "type": "string"},
            {"name": "entity_id", "type": "string"},
            {"name": "event_time", "type": "timestamp"},
            {"name": "amount", "type": "double"},
        ],
        "candidateKeys": [{"fields": ["application_id"], "fullScanVerified": True}],
        "candidateEventTimes": ["event_time"],
        "sensitiveFieldCandidates": [],
        "nullRates": {"application_id": 0.0, "event_time": 0.02},
        "cardinality": {"application_id": 999, "event_time": 900},
        "sampleInfo": {"sampled": True, "sampleRows": 500, "totalRows": 1000},
    }


def _good_design_json() -> str:
    return json.dumps({
        "businessGranularity": "one row per loan application",
        "primaryKey": ["application_id"],
        "businessKeys": ["application_id", "entity_id"],
        "timeFields": ["event_time"],
        "fieldMappings": [
            {"sourceField": "application_id", "targetField": "application_id", "targetType": "string"},
            {"sourceField": "entity_id", "targetField": "entity_id", "targetType": "string"},
            {"sourceField": "event_time", "targetField": "event_time", "targetType": "timestamp"},
            {"sourceField": "amount", "targetField": "amount", "targetType": "double"},
        ],
        "partitioning": "event_time",
        "sensitiveFields": [],
        "executionMode": "BATCH",
        "executionBackend": "PYICEBERG_LOCAL",
        "updateMode": "APPEND",
        "timeSemantics": "PROCESSING_TIME",
        "assumptions": ["source is append-only"],
        "risks": ["schema drift in amount"],
    })


class TestSchemaDesigner:
    def test_good_design_produces_validated_specs(self):
        d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": _good_design_json()})
        r = d.design(_profile(), "loan risk model training", "pipeline_1",
                     "dwd.loan_applications")
        assert r["ok"], r
        assert r["repaired"] is False
        assert is_valid_contract("schema-spec", r["schemaSpec"])
        assert is_valid_contract("pipeline-spec", r["pipelineSpec"])
        assert r["schemaSpec"]["businessGranularity"] == "one row per loan application"
        assert r["schemaSpec"]["primaryKey"] == ["application_id"]
        assert r["pipelineSpec"]["steps"], "deterministic step skeleton present"
        assert r["pipelineSpec"]["executionBackend"] == "PYICEBERG_LOCAL"

    def test_fabricated_field_rejected(self):
        bad = json.loads(_good_design_json())
        bad["primaryKey"] = ["not_a_real_field"]  # not in profile fields
        d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": json.dumps(bad)})
        r = d.design(_profile(), "loan risk model training", "pipeline_1",
                     "dwd.loan_applications")
        assert not r["ok"]
        assert any(i.get("code") == "PRIMARY_KEY_NOT_MAPPED" for i in r.get("issues", []))

    def test_invalid_json_fails_loudly(self):
        d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": "not json at all"})
        r = d.design(_profile(), "usage", "pipeline_1", "dwd.x")
        assert not r["ok"]
        assert "not valid JSON" in r["error"]

    def test_caller_failure_propagates(self):
        d = SchemaDesigner(caller=lambda _p: {"ok": False, "text": "", "error": "llm down"})
        r = d.design(_profile(), "usage", "pipeline_1", "dwd.x")
        assert not r["ok"]
        assert "llm down" in r["error"]

    def test_repair_accepts_single_quote_defects(self):
        text = _good_design_json().replace('"businessGranularity"', "'businessGranularity'")
        d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": text})
        r = d.design(_profile(), "usage", "pipeline_1", "dwd.x")
        assert r["ok"], r
        assert r["repaired"] is True

    def test_no_caller_injected_fails(self):
        d = SchemaDesigner()
        r = d.design(_profile(), "usage", "pipeline_1", "dwd.x")
        assert not r["ok"]
        assert "no design caller injected" in r["error"]

    def test_profile_without_fields_refused(self):
        d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": _good_design_json()})
        r = d.design({"datasetId": "empty"}, "usage", "pipeline_1", "dwd.x")
        assert not r["ok"]
        assert "no fields" in r["error"]


class TestCoordinatorDesignSchema:
    def _coord(self, repo, resolver):
        from pipelines.governance.event_store import EventStore
        return GovernanceCoordinator(repo, EventStore(repo), resolver=resolver)

    class _On:
        def is_effective(self, _fid):  # type: ignore[no-untyped-def]
            return True

    class _Off:
        def is_effective(self, fid):  # type: ignore[no-untyped-def]
            return fid != "round2.pipeline_schema_design"

    def test_design_schema_emits_event(self, repo):
        c = self._coord(repo, self._On())
        d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": _good_design_json()})
        r = c.design_schema(_profile(), "usage", "pipeline_1", "dwd.loan_applications",
                            designer=d, run_id="run_1")
        assert r["ok"], r
        # design emits the event; spec persistence is owned by the review flow
        types = {e["eventType"] for e in c.store.events_for_run("run_1")}
        assert "SCHEMA_DESIGNED" in types

    def test_design_schema_gated_by_feature(self, repo):
        c = self._coord(repo, self._Off())
        with pytest.raises(RuntimeError, match="round2.pipeline_schema_design"):
            c.design_schema(_profile(), "usage", "pipeline_1", "dwd.x")
