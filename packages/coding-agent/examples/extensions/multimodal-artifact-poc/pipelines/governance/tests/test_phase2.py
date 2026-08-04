"""Governance Phase 2 tests — event store, state reducer, agent worker.

Coverage manifest features (round2.pipeline_event_store,
round2.pipeline_state_reducer, round2.pipeline_agent_worker) are exercised
here and by experiments/e2e-governance-phase2.mts.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.event_store import EventStore  # noqa: E402
from pipelines.governance.state_reducer import StateReducer  # noqa: E402
from pipelines.governance.agent_worker import AgentWorker, build_context_package  # noqa: E402
from pipelines.governance.contracts import is_valid_contract, sha256_canonical  # noqa: E402


@pytest.fixture()
def store(tmp_path) -> EventStore:
    return EventStore(Repository(tmp_path / "gov-data"))


def _evt(seq: int, etype: str, run: str = "run_1", payload: dict | None = None,
         ver: int = 1) -> dict:
    run_tag = run.replace("run_", "")
    return {
        "eventId": f"evt_{run_tag}_{seq:04d}_{etype.lower()[:12]}",
        "eventType": etype,
        "pipelineId": "pipeline_1",
        "pipelineVersion": ver,
        "runId": run,
        "source": "PIPELINE_GOVERNANCE",
        "sequenceNumber": seq,
        "occurredAt": f"2026-08-02T00:00:{seq:02d}Z",
        "payloadHash": sha256_canonical(payload or {}),
        "payloadRef": None,
        "supersedesEventId": None,
        "payload": payload or {},
    }


# ---------------------------------------------------------------------------
# event store
# ---------------------------------------------------------------------------

def test_event_append_and_replay(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "RUN_STARTED"))
    events = store.events_for_run("run_1")
    assert len(events) == 2
    assert [e["sequenceNumber"] for e in events] == [1, 2]


def test_duplicate_event_rejected(store):
    store.append(_evt(1, "RUN_CREATED"))
    with pytest.raises(ValueError):
        store.append(_evt(1, "RUN_CREATED"))  # same eventId


def test_invalid_event_rejected(store):
    bad = _evt(1, "RUN_CREATED")
    bad["eventId"] = "not-an-event-id"
    with pytest.raises(ValueError):
        store.append(bad)


# ---------------------------------------------------------------------------
# state reducer
# ---------------------------------------------------------------------------

def test_reducer_deterministic_progression(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "RUN_STARTED"))
    store.append(_evt(3, "FINDING_DETECTED", payload={"findingId": "gf_1"}))
    snap = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert snap["state"] == "ISSUE_DETECTED"
    assert snap["openFindingRefs"] == ["gf_1"]
    assert snap["latestEventId"].startswith("evt_")
    assert snap["lastSequenceNumber"] == 3
    # deterministic: re-reduce gives identical snapshot
    snap2 = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert snap == snap2


def test_reducer_ignores_stale_sequence(store):
    # out-of-order write: sequence 5 then sequence 3 (regression)
    store.append(_evt(5, "RUN_STARTED"))
    store.append(_evt(3, "RUN_CREATED"))
    snap = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    # the reducer applies only increasing sequences: 3 then 5
    assert snap["lastSequenceNumber"] == 5
    assert snap["state"] == "RUNNING"


def test_reducer_ignores_old_version_events(store):
    store.append(_evt(1, "RUN_CREATED", ver=1))
    store.append(_evt(2, "RUN_STARTED", ver=1))
    # a v1 event after a v2 event must not overwrite newer state
    store.append(_evt(3, "RUN_CREATED", ver=2))
    store.append(_evt(4, "RUN_STARTED", ver=2))
    store.append(_evt(5, "PROCESSING_COMPLETED", ver=2))
    store.append(_evt(6, "RUN_CREATED", ver=1))  # old version, seq > last
    snap = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert snap["state"] == "PROCESSING_COMPLETED"


def test_reducer_terminal_states(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "RUN_FAILED"))
    snap = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert snap["state"] == "FAILED"


def test_heartbeat_and_progress_do_not_change_state(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "RUN_STARTED"))
    store.append(_evt(3, "ENGINE_HEARTBEAT", payload={"deadline": "2026-08-02T01:00:00Z", "engine": "PYICEBERG_LOCAL"}))
    store.append(_evt(4, "PROGRESS_UPDATED", payload={"currentJob": 1, "currentStage": 2, "deadline": "2026-08-02T01:10:00Z"}))
    snap = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert snap["state"] == "RUNNING"
    assert snap["lastHeartbeatAt"] is not None
    assert snap["lastProgressAt"] is not None
    assert snap["currentStage"] == 2


def test_multi_pipeline_isolation(store):
    store.append(_evt(1, "RUN_CREATED", run="run_a"))
    store.append(_evt(1, "RUN_CREATED", run="run_b"))
    store.append(_evt(2, "RUN_STARTED", run="run_a"))
    store.append(_evt(2, "RUN_FAILED", run="run_b"))
    reducer = StateReducer(store)
    sa = reducer.reduce_run("run_a", "pipeline_1", 1)
    sb = reducer.reduce_run("run_b", "pipeline_1", 1)
    assert sa["state"] == "RUNNING"
    assert sb["state"] == "FAILED"
    snaps = reducer.all_snapshots()
    assert len(snaps) == 2


# ---------------------------------------------------------------------------
# agent worker
# ---------------------------------------------------------------------------

def test_worker_uses_context_package_not_full_history(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "RUN_STARTED"))
    store.append(_evt(3, "FINDING_DETECTED", payload={"findingId": "gf_1"}))
    seen_prompts = []

    def fake_caller(prompt: str) -> dict:
        seen_prompts.append(prompt)
        return {"ok": True, "text": '{"proposal": "repartition"}'}

    worker = AgentWorker(reducer=StateReducer(store), caller=fake_caller)
    result = worker.on_event(store.events_for_run("run_1")[-1], relevant_event_refs=[store.events_for_run("run_1")[-1]["eventId"]])
    assert result["ok"] is True
    assert result["result"] == {"proposal": "repartition"}  # parsed JSON payload
    assert result["repaired"] is False
    prompt = seen_prompts[0]
    assert "CONTEXT" in prompt
    # must NOT contain the full event history — only the bounded package
    assert "events.jsonl" not in prompt


def test_worker_rejects_non_trigger_events(store):
    """Only anomaly / phase-complete / approval events may trigger the worker."""
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "ENGINE_HEARTBEAT"))
    called = []
    worker = AgentWorker(reducer=StateReducer(store),
                         caller=lambda p: called.append(p) or {"ok": True, "text": "{}"})
    for evt in store.events_for_run("run_1"):
        res = worker.on_event(evt)
        assert res["ok"] is False, f"{evt['eventType']} must not trigger the worker"
        assert "not a worker trigger" in res["error"]
    assert len(called) == 0  # no trigger event existed → caller never invoked


def test_worker_triggers_only_on_whitelisted_events(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "RUN_STARTED"))
    store.append(_evt(3, "FINDING_DETECTED", payload={"findingId": "gf_1"}))
    called = []
    worker = AgentWorker(reducer=StateReducer(store),
                         caller=lambda p: called.append(p) or {"ok": True, "text": "{}"})
    for evt in store.events_for_run("run_1"):
        worker.on_event(evt)
    # only FINDING_DETECTED (an anomaly) triggered the caller
    assert len(called) == 1


def test_worker_repairs_common_json_defects_once(store):
    """Trailing commas / Python literals are repaired ONCE; garbage fails."""
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "FINDING_DETECTED", payload={"findingId": "gf_1"}))
    evt = store.events_for_run("run_1")[-1]
    worker = AgentWorker(reducer=StateReducer(store),
                         caller=lambda _p: {"ok": True, "text":
                            '{"action": "remediate", "findingRefs": ["gf_1"], '
                            '"blocking": True, "sla": None,}'})
    res = worker.on_event(evt)
    assert res["ok"] is True
    assert res["repaired"] is True
    assert res["result"]["blocking"] is True
    assert res["result"]["sla"] is None


def test_worker_fails_loudly_on_unparseable_output(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "FINDING_DETECTED", payload={"findingId": "gf_1"}))
    worker = AgentWorker(reducer=StateReducer(store),
                         caller=lambda _p: {"ok": True, "text": "sure, i'll look at it"})
    res = worker.on_event(store.events_for_run("run_1")[-1])
    assert res["ok"] is False
    assert "not valid JSON" in res["error"]
    # model text is never forwarded verbatim
    assert "sure, i'll look at it" not in res["error"]


def test_context_package_bounded_and_valid(store):
    snap = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    pkg = build_context_package(snap, [f"evt_{i:04d}" for i in range(200)])
    assert len(pkg["relevantEventRefs"]) <= 50  # bounded
    assert is_valid_contract("pipeline-context-package", pkg)
    # agent must never see full history or logs
    assert "payload" not in pkg
    assert "log" not in json.dumps(pkg).lower()


def test_worker_never_writes_state(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "FINDING_DETECTED", payload={"findingId": "gf_1"}))
    before = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    worker = AgentWorker(reducer=StateReducer(store),
                         caller=lambda _p: {"ok": True, "text": "{}"})
    worker.on_event(store.events_for_run("run_1")[-1])
    after = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert before == after  # worker did not mutate anything
