"""Governance Phase 6 tests — status dashboard projection.

Coverage manifest feature (round2.pipeline_status_dashboard) is exercised
here and by experiments/e2e-governance-phase6.mts.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.event_store import EventStore  # noqa: E402
from pipelines.governance.state_reducer import StateReducer  # noqa: E402
from pipelines.governance.status_dashboard import StatusDashboard  # noqa: E402
from pipelines.governance.contracts import sha256_canonical  # noqa: E402


@pytest.fixture()
def store(tmp_path) -> EventStore:
    return EventStore(Repository(tmp_path / "gov-data"))


def _evt(seq, etype, run, payload=None):
    return {"eventId": f"evt_{run}_{seq:04d}_{etype.lower()[:10]}", "eventType": etype,
            "pipelineId": "p_1", "pipelineVersion": 1, "runId": run,
            "source": "PIPELINE_GOVERNANCE", "sequenceNumber": seq,
            "occurredAt": f"2026-08-02T00:00:{seq:02d}Z",
            "payloadHash": sha256_canonical(payload or {}), "payloadRef": None,
            "supersedesEventId": None, "payload": payload or {}}


def test_overview_reflects_real_snapshots(store):
    store.append(_evt(1, "RUN_CREATED", "run_a"))
    store.append(_evt(2, "RUN_STARTED", "run_a"))
    store.append(_evt(3, "FINDING_DETECTED", "run_a", {"findingId": "gf_1"}))
    store.append(_evt(1, "RUN_CREATED", "run_b"))
    d = StatusDashboard(StateReducer(store))
    rows = d.overview()
    by_run = {r["runId"]: r for r in rows}
    assert by_run["run_a"]["state"] == "ISSUE_DETECTED"
    assert by_run["run_a"]["openFindings"] == 1
    assert by_run["run_b"]["state"] == "QUEUED"  # RUN_CREATED → QUEUED
    assert len(rows) == 2


def test_severity_mapping(store):
    store.append(_evt(1, "RUN_CREATED", "run_f"))
    store.append(_evt(2, "RUN_FAILED", "run_f"))
    store.append(_evt(1, "RUN_CREATED", "run_o"))
    store.append(_evt(2, "RUN_STARTED", "run_o"))
    d = StatusDashboard(StateReducer(store))
    by_run = {r["runId"]: r for r in d.overview()}
    assert by_run["run_f"]["severity"] == "HIGH"
    assert by_run["run_o"]["severity"] == "INFO"


def test_model_text_is_compact(store):
    store.append(_evt(1, "RUN_CREATED", "run_m"))
    store.append(_evt(2, "RUN_STARTED", "run_m"))
    d = StatusDashboard(StateReducer(store))
    text = d.model_facing_summary()
    # state/refs only: no full snapshot JSON, no payload dumps
    assert "RUNNING" in text
    assert "snapshot" not in text.lower().replace("snapshotId", "")
    assert len(text) < 500


def test_ui_details_is_full_view(store):
    store.append(_evt(1, "RUN_CREATED", "run_u"))
    store.append(_evt(2, "RUN_STARTED", "run_u"))
    d = StatusDashboard(StateReducer(store))
    ui = d.ui_details()
    assert ui["dashboardType"] == "PIPELINE_GOVERNANCE"
    assert len(ui["rows"]) == 1


def test_agent_and_dashboard_same_snapshot(store):
    store.append(_evt(1, "RUN_CREATED", "run_s"))
    store.append(_evt(2, "RUN_STARTED", "run_s"))
    store.append(_evt(3, "PROCESSING_COMPLETED", "run_s"))
    reducer = StateReducer(store)
    d = StatusDashboard(reducer)
    snap = d.detail("run_s")["snapshot"]
    from pipelines.governance.agent_worker import build_context_package
    pkg = build_context_package(snap, ["evt_s_0001"])
    assert pkg["currentState"] == snap["state"] == "PROCESSING_COMPLETED"
