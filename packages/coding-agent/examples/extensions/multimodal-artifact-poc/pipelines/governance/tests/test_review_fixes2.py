"""Governance review-fix regression tests — round 2.

Covers the P0/P1/P2 findings fixed after the static review:
  - EventStore: runId traversal / symlink escape / idempotency under
    concurrency / payloadHash mismatch / corruption + explicit tail repair
  - StateReducer: terminal states cannot be left by ordinary events; same
    sequence with a different eventId is a conflict
  - unified OperatorApproval: hash-bound decisions invalidate tampered
    objects across remediation, placement and CDXR
"""
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.contracts import sha256_canonical  # noqa: E402
from pipelines.governance.event_store import EventStore, IntegrityError  # noqa: E402
from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.state_reducer import StateReducer  # noqa: E402


@pytest.fixture()
def store(tmp_path) -> EventStore:
    return EventStore(Repository(tmp_path / "gov-data"))


def _evt(seq: int, etype: str, run: str = "run_1", payload: dict | None = None,
         ver: int = 1, event_id: str | None = None) -> dict:
    run_tag = run.replace("run_", "")
    return {
        "eventId": event_id or f"evt_{run_tag}_{seq:04d}_{etype.lower()[:12]}",
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
# EventStore: ID / path / payload integrity (P0/P1)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad_run", ["../escape", "a/b", "a\\b", "/abs/run",
                                     "", "..", "run with space", "x\x00y"])
def test_run_id_traversal_rejected(store, bad_run):
    evt = _evt(1, "RUN_CREATED", run="run_safe")
    evt["runId"] = bad_run
    with pytest.raises(ValueError):
        store.append(evt)


def test_run_id_symlink_escape_rejected(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "repo"
    r = Repository(root)
    s = EventStore(r)
    link = s.events_dir / "linked_run"
    link.mkdir(parents=True, exist_ok=True)
    link.rmdir()
    link.symlink_to(outside, target_is_directory=True)
    evt = _evt(1, "RUN_CREATED", run="linked_run")
    with pytest.raises(ValueError):
        s.append(evt)


def test_payload_hash_mismatch_rejected(store):
    evt = _evt(1, "RUN_CREATED")
    evt["payloadHash"] = sha256_canonical({"different": True})
    with pytest.raises(ValueError):
        store.append(evt)
    assert store.events_for_run("run_1") == []


def test_duplicate_event_id_rejected_under_concurrency(tmp_path):
    s = EventStore(Repository(tmp_path / "gov-data"))
    results: list[str] = []

    def writer():
        try:
            s.append(_evt(1, "RUN_CREATED", event_id="evt_race_0001"))
            results.append("ok")
        except ValueError:
            results.append("dup")

    threads = [threading.Thread(target=writer) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == ["dup", "dup", "dup", "ok"]
    assert len(s.events_for_run("run_1")) == 1


def test_mid_file_corruption_fails_hard(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "RUN_STARTED"))
    path = store.events_dir / "run_1" / "events.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines()
    lines.insert(1, "{corrupt mid")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    with pytest.raises(IntegrityError):
        store.events_for_run("run_1")
    # integrity scan also fails hard on mid-file corruption
    with pytest.raises(IntegrityError):
        store.integrity_scan()


def test_truncated_tail_reported_and_explicitly_repairable(store):
    store.append(_evt(1, "RUN_CREATED"))
    path = store.events_dir / "run_1" / "events.jsonl"
    with open(path, "a", encoding="utf-8") as f:
        f.write('{"eventId": "evt_trunc')
    issues = store.integrity_scan()
    assert any("TRUNCATED_EVENT_TAIL" in i for i in issues)
    # reads skip the truncated tail without crashing
    assert len(store.events_for_run("run_1")) == 1
    # explicit repair drops it
    store.repair_event_tail("run_1")
    assert not any("TRUNCATED_EVENT_TAIL" in i for i in store.integrity_scan())
    with pytest.raises(IntegrityError):
        store.repair_event_tail("run_1")  # nothing left to repair


def test_construction_creates_no_files(tmp_path):
    """Gating guarantee: constructing the store must not touch disk."""
    root = tmp_path / "empty"
    repo = Repository(root)
    s = EventStore(repo)
    assert not (root / "events").exists()
    assert s.events_for_run("nope") == []  # reads are safe on missing dirs


# ---------------------------------------------------------------------------
# StateReducer: terminal states + sequence conflicts (P1)
# ---------------------------------------------------------------------------

def test_terminal_state_not_left_by_ordinary_events(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "RUN_FAILED"))
    # late heartbeat / progress after FAILED must NOT resurrect the run
    store.append(_evt(3, "ENGINE_HEARTBEAT"))
    store.append(_evt(4, "PROGRESS_UPDATED"))
    snap = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert snap["state"] == "FAILED"


def test_terminal_state_requires_reopen_event(store):
    store.append(_evt(1, "RUN_CREATED"))
    store.append(_evt(2, "RUN_BLOCKED"))
    snap = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert snap["state"] == "BLOCKED"
    # an explicit reopen restarts the run
    store.append(_evt(3, "RUN_REOPENED"))
    snap2 = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert snap2["state"] == "RUNNING"


def test_same_sequence_conflicting_event_id_raises(store):
    store.append(_evt(1, "RUN_CREATED", event_id="evt_a_0001"))
    # second event with the SAME sequence but a DIFFERENT eventId
    store.append(_evt(1, "RUN_STARTED", event_id="evt_b_0001"))
    with pytest.raises(ValueError):
        StateReducer(store).reduce_run("run_1", "pipeline_1", 1)


def test_pipeline_version_follows_events(store):
    store.append(_evt(1, "RUN_CREATED", ver=1))
    store.append(_evt(2, "RUN_STARTED", ver=1))
    store.append(_evt(3, "PROCESSING_COMPLETED", ver=2))
    snap = StateReducer(store).reduce_run("run_1", "pipeline_1", 1)
    assert snap["pipelineVersion"] == 2


# ---------------------------------------------------------------------------
# Unified OperatorApproval: hash-bound decisions (P1)
# ---------------------------------------------------------------------------

def test_approval_invalidated_when_object_tampered(tmp_path):
    from pipelines.governance.approval import OperatorApproval
    from pipelines.governance.placement import PlacementGovernance

    repo = Repository(tmp_path / "gov-data")
    g = PlacementGovernance(repo)
    plan = g.propose({
        "placementPlanId": "pp_tamper", "version": 1,
        "sourceDataset": "source.events", "targetLayer": "DWD",
        "targetDataset": "dwd.loan_application_detail",
        "rationale": "clean loan detail for downstream analysis",
        "grainDetail": "per loan application", "derivation": "RAW",
        "targetSchemaRef": "schema-spec:schema_001@1",
        "primaryKey": ["application_id"], "partitioning": ["event_time"],
        "writeMode": "INCREMENTAL", "schemaEvolutionPolicy": "ADDITIVE",
        "retentionPolicy": "90d", "backfillRequired": False,
        "affectedDownstream": [], "qualityGateRefs": [],
        "assumptions": [], "risks": [], "status": "DRAFT",
    })
    g.approve(plan["placementPlanId"], os_actor="op@h")
    # tamper with the stored APPROVED object behind the approval's back
    obj = repo.get("placement-plan", plan["placementPlanId"], 2)
    tampered = {**obj.content, "targetDataset": "ads.steal"}
    (repo.objects_dir / "placement-plan" / f"{plan['placementPlanId']}@2.json").write_text(
        json.dumps(tampered, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    with pytest.raises(ValueError):
        g.require_approved(plan["placementPlanId"])
    # untouched approval still validates
    repo2 = Repository(tmp_path / "gov2")
    g2 = PlacementGovernance(repo2)
    p2 = g2.propose({
        "placementPlanId": "pp_ok", "version": 1,
        "sourceDataset": "source.events", "targetLayer": "DWD",
        "targetDataset": "dwd.loan_application_detail",
        "rationale": "clean loan detail for downstream analysis",
        "grainDetail": "per loan application", "derivation": "RAW",
        "targetSchemaRef": "schema-spec:schema_001@1",
        "primaryKey": ["application_id"], "partitioning": ["event_time"],
        "writeMode": "INCREMENTAL", "schemaEvolutionPolicy": "ADDITIVE",
        "retentionPolicy": "90d", "backfillRequired": False,
        "affectedDownstream": [], "qualityGateRefs": [],
        "assumptions": [], "risks": [], "status": "DRAFT",
    })
    g2.approve(p2["placementPlanId"], os_actor="op@h")
    assert g2.require_approved(p2["placementPlanId"])["status"] == "APPROVED"


def test_approval_wrong_decision_rejected(tmp_path):
    from pipelines.governance.approval import OperatorApproval
    repo = Repository(tmp_path / "gov-data")
    ap = OperatorApproval(repo)
    ap.record("placement", "pp_x", "APPROVE", "op@h", sha256_canonical({"v": 1}))
    with pytest.raises(ValueError):
        ap.require_decision("placement", "pp_x", "REJECT", sha256_canonical({"v": 1}))
    ap.require_decision("placement", "pp_x", "APPROVE", sha256_canonical({"v": 1}))


def test_approval_kind_whitelist(tmp_path):
    from pipelines.governance.approval import OperatorApproval
    repo = Repository(tmp_path / "gov-data")
    ap = OperatorApproval(repo)
    with pytest.raises(ValueError):
        ap.record("warehouse_write", "x", "APPROVE", "op@h", "sha256:00")
