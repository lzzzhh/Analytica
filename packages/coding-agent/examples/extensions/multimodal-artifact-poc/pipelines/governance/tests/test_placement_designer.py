"""Placement Designer + agent_interpret tests — the PLACEMENT and
INTERPRET roles of the Pipeline Governance Agent.

- good placement proposal → validated PlacementPlan (contract + layer rules)
- invalid layer / caller failure / bad JSON fail loudly
- coordinator.placement_design persists + emits; agent_interpret wakes the
  worker for trigger events only, gated by round2.pipeline_agent_worker
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.coordinator import GovernanceCoordinator  # noqa: E402
from pipelines.governance.event_store import EventStore  # noqa: E402
from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.placement_designer import PlacementDesigner  # noqa: E402
from pipelines.governance.contracts import is_valid_contract  # noqa: E402


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


def _profile() -> dict:
    return {
        "datasetId": "dwd.loan_applications",
        "schemaHash": "sha256:abc",
        "rowCount": 1000,
        "fields": [
            {"name": "application_id", "type": "string"},
            {"name": "amount", "type": "double"},
            {"name": "event_time", "type": "timestamp"},
        ],
        "candidateKeys": [{"fields": ["application_id"], "fullScanVerified": True}],
        "candidateEventTimes": ["event_time"],
        "sensitiveFieldCandidates": ["application_id"],
        "nullRates": {}, "cardinality": {}, "partitionStats": {}, "fileStats": {},
    }


def _good_placement_json() -> str:
    return json.dumps({
        "targetLayer": "DWS", "targetDataset": "dws.feature_values",
        "rationale": "aggregated risk features reused across models",
        "grainDetail": "one row per entity per day",
        "derivation": "aggregate of dwd loan detail",
        "primaryKey": ["application_id"],
        "partitioning": ["event_time"],
        "writeMode": "APPEND",
        "retentionPolicy": "90d",
        "backfillRequired": False,
        "affectedDownstream": ["ads.model_metrics"],
        "assumptions": ["source is daily"],
        "risks": ["grain drift"],
    })


class TestPlacementDesigner:
    def test_good_design_validates(self):
        d = PlacementDesigner(caller=lambda _p: {"ok": True, "text": _good_placement_json()})
        r = d.design(_profile(), "dwd.loan_applications", "model features")
        assert r["ok"], r
        assert is_valid_contract("placement-plan", r["plan"])
        assert r["plan"]["targetLayer"] == "DWS"
        assert r["plan"]["status"] == "DRAFT"

    def test_bad_layer_rejected(self):
        bad = json.loads(_good_placement_json())
        bad["targetLayer"] = "WEIRD"
        d = PlacementDesigner(caller=lambda _p: {"ok": True, "text": json.dumps(bad)})
        r = d.design(_profile(), "src", "usage")
        assert not r["ok"]

    def test_caller_failure(self):
        d = PlacementDesigner(caller=lambda _p: {"ok": False, "text": "", "error": "llm down"})
        r = d.design(_profile(), "src", "usage")
        assert not r["ok"]
        assert "llm down" in r["error"]

    def test_invalid_json(self):
        d = PlacementDesigner(caller=lambda _p: {"ok": True, "text": "nope"})
        r = d.design(_profile(), "src", "usage")
        assert not r["ok"]
        assert "not valid JSON" in r["error"]

    def test_no_caller_fails(self):
        d = PlacementDesigner()
        r = d.design(_profile(), "src", "usage")
        assert not r["ok"]
        assert "no placement caller injected" in r["error"]


class TestCoordinatorPlacementAndInterpret:
    class _On:
        def is_effective(self, _fid):  # type: ignore[no-untyped-def]
            return True

    class _Off:
        def is_effective(self, fid):  # type: ignore[no-untyped-def]
            return fid not in ("round2.pipeline_placement_governance",
                               "round2.pipeline_agent_worker")

    def _coord(self, repo, resolver):
        return GovernanceCoordinator(repo, EventStore(repo), resolver=resolver)

    def test_placement_design_persists_and_emits(self, repo):
        c = self._coord(repo, self._On())
        d = PlacementDesigner(caller=lambda _p: {"ok": True, "text": _good_placement_json()})
        r = c.placement_design(_profile(), "dwd.loan_applications", "model features", designer=d, run_id="run_1")
        assert r["ok"], r
        assert repo.get("placement-plan", r["plan"]["placementPlanId"], 1)
        types = {e["eventType"] for e in c.store.events_for_run("run_1")}
        assert "PLACEMENT_PROPOSED" in types

    def test_placement_design_gated(self, repo):
        c = self._coord(repo, self._Off())
        with pytest.raises(RuntimeError, match="round2.pipeline_placement_governance"):
            c.placement_design(_profile(), "src", "usage")

    def test_agent_interpret_trigger_event(self, repo):
        c = self._coord(repo, self._On())
        fake = {"ok": True, "text": json.dumps({"proposal": "repartition", "rationale": "skew"})}
        r = c.agent_interpret({"eventType": "WATCHDOG_ANOMALY", "pipelineId": "p_1",
                               "pipelineVersion": 1, "runId": "run_1", "eventId": "evt_1"},
                              caller=lambda _p: fake)
        assert r["ok"], r
        assert r["result"]["proposal"] == "repartition"

    def test_agent_interpret_refuses_non_trigger(self, repo):
        c = self._coord(repo, self._On())
        r = c.agent_interpret({"eventType": "PROGRESS_UPDATED", "pipelineId": "p_1",
                               "pipelineVersion": 1, "runId": "run_1", "eventId": "evt_1"},
                              caller=lambda _p: {"ok": True, "text": "{}"})
        assert not r["ok"]
        assert "not a worker trigger" in r["error"]

    def test_agent_interpret_gated(self, repo):
        c = self._coord(repo, self._Off())
        with pytest.raises(RuntimeError, match="round2.pipeline_agent_worker"):
            c.agent_interpret({"eventType": "WATCHDOG_ANOMALY", "pipelineId": "p_1",
                               "pipelineVersion": 1, "runId": "run_1", "eventId": "e"})
