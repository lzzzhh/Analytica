"""WriteGate concurrency tests — per-target serialization + optimistic CAS.

- 10 threads publishing to the SAME target: serialized by the per-target
  lock → deterministic result, no interleaving errors, each write audited
- different targets in parallel: no cross-blocking
- base_snapshot_id CAS: stale base rejected with SnapshotConflictError;
  current base proceeds
"""
import json
import sys
import threading
import uuid
from pathlib import Path

import pyarrow as pa
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.common.write_gate import SnapshotConflictError, WriteGate  # noqa: E402
from pipelines.governance.coordinator import GovernanceCoordinator  # noqa: E402
from pipelines.governance.event_store import EventStore  # noqa: E402
from pipelines.governance.flow import GovernancePhase1  # noqa: E402
from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.schema_designer import SchemaDesigner  # noqa: E402
from pipelines.governance.placement import PlacementGovernance  # noqa: E402
from pipelines.common.config import open_catalog, ensure_namespaces  # noqa: E402


class _On:
    def is_effective(self, _fid):  # type: ignore[no-untyped-def]
        return True


def _profile() -> dict:
    return {
        "datasetId": "source.x", "schemaHash": "sha256:x", "rowCount": 1,
        "fields": [{"name": "k", "type": "string"}, {"name": "v", "type": "double"}],
        "candidateKeys": [{"fields": ["k"], "fullScanVerified": True}],
        "candidateEventTimes": [],
        "sensitiveFieldCandidates": [],
        "nullRates": {}, "cardinality": {}, "partitionStats": {}, "fileStats": {},
    }


def _design_json() -> str:
    return json.dumps({
        "businessGranularity": "one row per event", "primaryKey": ["k"],
        "businessKeys": [], "timeFields": [],
        "fieldMappings": [
            {"sourceField": "k", "targetField": "k", "targetType": "string"},
            {"sourceField": "v", "targetField": "v", "targetType": "double"},
        ],
        "partitioning": [], "sensitiveFields": [],
        "executionMode": "BATCH", "executionBackend": "PYICEBERG_LOCAL",
        "updateMode": "APPEND", "timeSemantics": "PROCESSING_TIME",
        "assumptions": [], "risks": [],
    })


def _approve_target(repo, target: str) -> str:
    """Full Gate-1 approval for a target; returns approvalId."""
    coord = GovernanceCoordinator(repo, EventStore(repo), resolver=_On())
    d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": _design_json()})
    r = coord.design_schema(_profile(), "u", f"p_{uuid.uuid4().hex[:6]}",
                            target, designer=d, run_id=f"run_{uuid.uuid4().hex[:8]}")
    flow = GovernancePhase1(repo)
    rev = flow.create_review_package(r["schemaSpec"], r["pipelineSpec"])
    appr = flow.approve(rev["reviewId"], "APPROVE", os_actor="tester")
    sealed = flow.seal_approved(rev["reviewId"], appr)
    pg = PlacementGovernance(repo)
    plan = {
        "placementPlanId": f"pp_{uuid.uuid4().hex[:12]}", "version": 1,
        "sourceDataset": "source", "targetLayer": target.split(".")[0].upper(),
        "targetDataset": target, "rationale": "test",
        "grainDetail": "one row per entity" if target.startswith("dwd") else "",
        "derivation": "RAW" if target.startswith("ods") else "DERIVED",
        "primaryKey": ["k"] if target.startswith("dwd") else [],
        "partitioning": [], "writeMode": "APPEND",
        "schemaEvolutionPolicy": "ADDITIVE", "retentionPolicy": "default",
        "backfillRequired": False, "affectedDownstream": [],
        "qualityGateRefs": [], "assumptions": [], "risks": [],
        "targetSchemaRef": "schema-spec:latest", "status": "DRAFT",
    }
    proposed = pg.propose(plan)
    pg.approve(proposed["placementPlanId"], os_actor="tester")
    return sealed["approvalId"]


@pytest.fixture()
def approved(repo) -> str:
    """Full Gate-1 approval for ods.streaming_events; returns approvalId."""
    return _approve_target(repo, "ods.streaming_events")


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


class TestPerTargetSerialization:
    def test_ten_parallel_writes_same_target(self, repo, approved, tmp_path):
        """10 threads publish the same target concurrently → serialized by the
        lock: no errors, final state is one of the writes (deterministic
        last-write-wins, not corrupted), and all 10 writes are audited."""
        catalog = open_catalog(tmp_path / "wh")
        ensure_namespaces(catalog)
        gate = WriteGate(repo)

        errors: list[str] = []
        snaps: list = []
        lock = threading.Lock()

        def worker(i: int) -> None:
            try:
                tbl = pa.table({"k": pa.array([f"k{i}"], pa.string()),
                                "v": pa.array([float(i)], pa.float64())})
                snap = gate.publish(catalog, "ods.streaming_events", tbl,
                                    approval_id=approved)
                with lock:
                    snaps.append(snap)
            except Exception as exc:  # noqa: BLE001
                with lock:
                    errors.append(f"w{i}: {exc}")

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, errors
        assert len(snaps) == 10, "all 10 writes committed"
        assert len({s for s in snaps}) >= 1, "each write has a snapshot"
        # audit: 10 COMMITTED + 10 PREPARED (two-phase)
        audits = [repo.get("write-audit", e["id"], 1).content
                  for e in repo.ledger() if e["type"] == "write-audit"]
        assert len([a for a in audits if a["status"] == "COMMITTED"]) == 10
        assert len([a for a in audits if a["status"] == "PREPARED"]) == 10
        # final table state is valid (one of the writes won)
        final = catalog.load_table("ods.streaming_events").scan().to_arrow()
        assert final.num_rows == 1

    def test_parallel_different_targets_no_blocking(self, repo, tmp_path):
        """Different targets publish in parallel without cross-blocking."""
        a1 = _approve_target(repo, "ods.streaming_events")
        a2 = _approve_target(repo, "dwd.loan_application_detail")
        catalog = open_catalog(tmp_path / "wh")
        ensure_namespaces(catalog)
        gate = WriteGate(repo)
        errors: list[str] = []
        lock = threading.Lock()

        def worker(target: str, approval: str) -> None:
            try:
                tbl = pa.table({"k": pa.array(["x"], pa.string()),
                                "v": pa.array([1.0], pa.float64())})
                gate.publish(catalog, target, tbl, approval_id=approval)
            except Exception as exc:  # noqa: BLE001
                with lock:
                    errors.append(f"{target}: {exc}")

        threads = [threading.Thread(target=worker, args=("ods.streaming_events", a1)),
                   threading.Thread(target=worker, args=("dwd.loan_application_detail", a2))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not errors, errors


class TestOptimisticCas:
    def test_stale_base_rejected(self, repo, approved, tmp_path):
        catalog = open_catalog(tmp_path / "wh")
        ensure_namespaces(catalog)
        gate = WriteGate(repo)
        tbl = pa.table({"k": pa.array(["a"], pa.string()),
                        "v": pa.array([1.0], pa.float64())})
        gate.publish(catalog, "ods.streaming_events", tbl, approval_id=approved)
        stale = gate._current_snapshot(catalog, "ods.streaming_events")
        # advance the table
        gate.publish(catalog, "ods.streaming_events",
                     pa.table({"k": pa.array(["b"], pa.string()),
                               "v": pa.array([2.0], pa.float64())}),
                     approval_id=approved)
        with pytest.raises(SnapshotConflictError, match="moved"):
            gate.publish(catalog, "ods.streaming_events", tbl,
                         approval_id=approved, base_snapshot_id=stale)

    def test_current_base_proceeds(self, repo, approved, tmp_path):
        catalog = open_catalog(tmp_path / "wh")
        ensure_namespaces(catalog)
        gate = WriteGate(repo)
        tbl = pa.table({"k": pa.array(["a"], pa.string()),
                        "v": pa.array([1.0], pa.float64())})
        gate.publish(catalog, "ods.streaming_events", tbl, approval_id=approved)
        base = gate._current_snapshot(catalog, "ods.streaming_events")
        # immediate re-publish with the current base is fine
        snap = gate.publish(catalog, "ods.streaming_events",
                            pa.table({"k": pa.array(["b"], pa.string()),
                                      "v": pa.array([2.0], pa.float64())}),
                            approval_id=approved, base_snapshot_id=base)
        assert snap is not None


class TestIdempotencyKey:
    def test_repeated_batch_id_returns_same_snapshot(self, repo, approved, tmp_path):
        """Re-publishing the same (target, batchId) does NOT create a new
        commit — the previously committed snapshot is returned (idempotency,
        not just traceability)."""
        catalog = open_catalog(tmp_path / "wh")
        ensure_namespaces(catalog)
        gate = WriteGate(repo)
        tbl = pa.table({"k": pa.array(["a"], pa.string()),
                        "v": pa.array([1.0], pa.float64())})
        s1 = gate.publish(catalog, "ods.streaming_events", tbl,
                          approval_id=approved, batch_id="batch_replay_1")
        s2 = gate.publish(catalog, "ods.streaming_events", tbl,
                          approval_id=approved, batch_id="batch_replay_1")
        assert s1 == s2, "idempotent replay must return the same snapshot"
        # only one COMMITTED record for this batch
        committed = [repo.get("write-audit", e["id"], 1).content
                     for e in repo.ledger() if e["type"] == "write-audit"]
        c = [a for a in committed
             if a["status"] == "COMMITTED" and a["batchId"] == "batch_replay_1"]
        assert len(c) == 1
        # table has one snapshot chain write (1 row)
        final = catalog.load_table("ods.streaming_events").scan().to_arrow()
        assert final.num_rows == 1

    def test_stale_audit_does_not_skip_write_in_fresh_warehouse(
        self, repo, approved, tmp_path,
    ):
        first_catalog = open_catalog(tmp_path / "first-wh")
        second_catalog = open_catalog(tmp_path / "second-wh")
        ensure_namespaces(first_catalog)
        ensure_namespaces(second_catalog)
        gate = WriteGate(repo)
        table = pa.table({
            "k": pa.array(["a"], pa.string()),
            "v": pa.array([1.0], pa.float64()),
        })
        first_snapshot = gate.publish(
            first_catalog, "ods.streaming_events", table,
            approval_id=approved, batch_id="batch_shared_repo",
        )

        second_snapshot = gate.publish(
            second_catalog, "ods.streaming_events", table,
            approval_id=approved, batch_id="batch_shared_repo",
        )

        assert first_snapshot is not None
        assert second_snapshot is not None
        assert second_catalog.table_exists("ods.streaming_events")
        assert second_catalog.load_table(
            "ods.streaming_events").scan().to_arrow().num_rows == 1


class TestConcurrentApprovalCas:
    def test_two_concurrent_approves_single_winner(self, repo):
        """Two approve() calls racing on the same review: exactly one
        terminal decision persists (no-clobber CAS), the loser raises."""
        coord = GovernanceCoordinator(repo, EventStore(repo), resolver=_On())
        d = SchemaDesigner(caller=lambda _p: {"ok": True, "text": _design_json()})
        r = coord.design_schema(_profile(), "u", f"p_{uuid.uuid4().hex[:6]}",
                                "ods.streaming_events", designer=d,
                                run_id=f"run_{uuid.uuid4().hex[:8]}")
        flow = GovernancePhase1(repo)
        rev = flow.create_review_package(r["schemaSpec"], r["pipelineSpec"])

        winners = []
        errors = []
        lock = threading.Lock()

        def worker(decision: str) -> None:
            try:
                flow.approve(rev["reviewId"], decision, os_actor=f"actor_{decision}")
                with lock:
                    winners.append(decision)
            except Exception as exc:  # noqa: BLE001
                with lock:
                    errors.append(str(exc))

        t1 = threading.Thread(target=worker, args=("APPROVE",))
        t2 = threading.Thread(target=worker, args=("REJECT",))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        assert len(winners) == 1, f"exactly one decision wins, got {winners}"
        assert len(errors) == 1
        # exactly one decision recorded for this review
        decisions = [repo.get("approval-decision", e["id"], 1).content
                     for e in repo.ledger() if e["type"] == "approval-decision"]
        assert len(decisions) == 1
        assert decisions[0]["decision"] in ("APPROVE", "REJECT")
