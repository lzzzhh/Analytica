"""Governance Phase 3 tests — runtime governance, watchdog, remediation.

Coverage manifest features (round2.spark_runtime_governance,
round2.flink_runtime_governance, round2.iceberg_layout_governance,
round2.pipeline_deadline_watchdog, round2.pipeline_remediation) are
exercised here and by experiments/e2e-governance-phase3.mts.

Production Spark/Flink are NOT available: these tests use deterministic
fixtures only and assert verified=false is never claimed.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.runtime_governance import (  # noqa: E402
    DeadlineWatchdog,
    Remediation,
    RuntimeGovernance,
)


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


@pytest.fixture()
def rg(repo) -> RuntimeGovernance:
    return RuntimeGovernance(repo)


def _spark_summary(**over) -> dict:
    s = {
        "runId": "run_s1", "pipelineId": "pipe_s1", "pipelineVersion": 1,
        "engine": "SPARK", "jobId": 1,
        "status": "SUCCEEDED", "durationMs": 1000, "retries": 0,
        "stages": [{"stageId": 1, "status": "SUCCEEDED", "durationMs": 500,
                    "shuffleReadBytes": 100, "shuffleWriteBytes": 100,
                    "spillBytes": 0, "inputRows": 100, "outputRows": 100}],
        "taskSummary": {"maxToMedianRatio": 2.0, "executorLost": 0, "oomCount": 0},
        "verified": False,
    }
    s.update(over)
    return s


def _flink_summary(**over) -> dict:
    s = {
        "runId": "run_f1", "pipelineId": "pipe_f1", "pipelineVersion": 1,
        "engine": "FLINK", "jobId": 1, "status": "RUNNING",
        "operators": [{"name": "op1", "recordsIn": 10, "recordsOut": 10}],
        "checkpoints": {"lastFailed": None, "staleSeconds": 0},
        "watermark": {"stalledSeconds": 0},
        "backpressure": {"highBackpressureSeconds": 0},
        "verified": False,
    }
    s.update(over)
    return s


def _iceberg_summary(**over) -> dict:
    s = {
        "runId": "run_i1", "pipelineId": "pipe_i1", "pipelineVersion": 1,
        "engine": "ICEBERG", "snapshotId": "snap_1",
        "dataFiles": [{"path": "f1", "sizeBytes": 100_000_000}],
        "manifests": [{"path": "m1"}],
        "partitionStats": {"p1": 100},
        "schemaChanged": False, "partitionSpecChanged": False,
        "verified": False,
    }
    s.update(over)
    return s


# ---------------------------------------------------------------------------
# Spark
# ---------------------------------------------------------------------------

def test_spark_clean_run_no_findings(rg):
    findings = rg.govern_spark(_spark_summary())
    assert findings == []


def test_spark_job_failed_finding(rg):
    findings = rg.govern_spark(_spark_summary(status="FAILED"))
    assert any(f["code"] == "JOB_FAILED" and f["blocking"] for f in findings)


def test_spark_stage_failure_and_skew(rg):
    findings = rg.govern_spark(_spark_summary(stages=[
        {"stageId": 2, "status": "FAILED", "durationMs": 100,
         "shuffleReadBytes": 1, "shuffleWriteBytes": 1, "spillBytes": 100,
         "inputRows": 10, "outputRows": 1000},  # spill + skew
    ]))
    codes = {f["code"] for f in findings}
    assert "STAGE_FAILURE" in codes
    assert "SHUFFLE_PRESSURE" in codes
    assert "DATA_SKEW" in codes


def test_spark_task_skew_via_ratio(rg):
    findings = rg.govern_spark(_spark_summary(taskSummary={"maxToMedianRatio": 8.0, "executorLost": 0, "oomCount": 0}))
    assert any(f["code"] == "DATA_SKEW" for f in findings)


def test_spark_invalid_summary_rejected(rg):
    with pytest.raises(ValueError):
        rg.govern_spark({"runId": "x"})  # missing required fields


def test_spark_never_claims_verified(rg):
    """The adapter contract pins verified=false — no production claim."""
    with pytest.raises(ValueError):
        rg.govern_spark(_spark_summary(verified=True))  # schema forbids verified=true


# ---------------------------------------------------------------------------
# Flink
# ---------------------------------------------------------------------------

def test_flink_clean_run_no_findings(rg):
    assert rg.govern_flink(_flink_summary()) == []


def test_flink_checkpoint_failure(rg):
    findings = rg.govern_flink(_flink_summary(checkpoints={"lastFailed": 1, "staleSeconds": 0}))
    assert any(f["code"] == "CHECKPOINT_FAILURE" and f["blocking"] for f in findings)


def test_flink_watermark_and_backpressure(rg):
    findings = rg.govern_flink(_flink_summary(
        watermark={"stalledSeconds": 600},
        backpressure={"highBackpressureSeconds": 120},
    ))
    codes = {f["code"] for f in findings}
    assert "WATERMARK_STALL" in codes
    assert "BACKPRESSURE" in codes


def test_flink_stale_checkpoint(rg):
    findings = rg.govern_flink(_flink_summary(checkpoints={"lastFailed": None, "staleSeconds": 400}))
    assert any(f["code"] == "CHECKPOINT_STALE" for f in findings)


# ---------------------------------------------------------------------------
# Iceberg
# ---------------------------------------------------------------------------

def test_iceberg_clean_commit_no_findings(rg):
    assert rg.govern_iceberg(_iceberg_summary()) == []


def test_iceberg_small_files_finding(rg):
    findings = rg.govern_iceberg(_iceberg_summary(dataFiles=[
        {"path": "f1", "sizeBytes": 10_000},  # < 64KB
        {"path": "f2", "sizeBytes": 200_000_000},
    ]))
    assert any(f["code"] == "SMALL_FILES" for f in findings)


def test_iceberg_partition_skew(rg):
    findings = rg.govern_iceberg(_iceberg_summary(partitionStats={"p1": 10, "p2": 1000}))
    assert any(f["code"] == "PARTITION_SKEW" for f in findings)


def test_iceberg_snapshot_growth(rg):
    files = [{"path": f"f{i}", "sizeBytes": 100_000} for i in range(600)]
    findings = rg.govern_iceberg(_iceberg_summary(dataFiles=files))
    assert any(f["code"] == "SNAPSHOT_GROWTH" for f in findings)


# ---------------------------------------------------------------------------
# Watchdog
# ---------------------------------------------------------------------------

def test_watchdog_no_progress_ever(repo):
    wd = DeadlineWatchdog(repo, default_sla_seconds=60)
    f = wd.check("run_w1", None)
    assert f is not None and f["code"] == "ENGINE_UNREACHABLE"


def test_watchdog_renew_keeps_alive(repo):
    wd = DeadlineWatchdog(repo, default_sla_seconds=60, safety_factor=1.5)
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(seconds=10)).isoformat()
    assert wd.check("run_w2", recent, now=now.isoformat()) is None  # alive


def test_watchdog_expiry_emits_stall(repo):
    wd = DeadlineWatchdog(repo, default_sla_seconds=60, safety_factor=1.5)
    now = datetime.now(timezone.utc)
    old = (now - timedelta(seconds=200)).isoformat()
    f = wd.check("run_w3", old, now=now.isoformat())
    assert f is not None and f["code"] == "JOB_STALLED"
    assert f["blocking"] is True


def test_watchdog_renew_persists_lease(repo):
    wd = DeadlineWatchdog(repo, default_sla_seconds=60, safety_factor=2.0)
    before = datetime.now(timezone.utc)
    deadline = wd.renew("run_w4", before.isoformat(), sla_seconds=60)
    # deadline = renew time + 120s (safety_factor 2.0)
    after = datetime.fromisoformat(deadline)
    assert (after - before).total_seconds() == pytest.approx(120.0, abs=2.0)
    # lease persisted with progress watermark and immutable versions
    lease = wd.lease("run_w4")
    assert lease["renewCount"] == 1
    assert lease["lastProgressAt"] == before.isoformat()
    assert lease["slaSeconds"] == 60
    assert len(repo.versions("watchdog-lease", "wl_run_w4")) == 1
    # second renewal appends a new version (no overwrite)
    wd.renew("run_w4", before.isoformat(), sla_seconds=60)
    assert len(repo.versions("watchdog-lease", "wl_run_w4")) == 2
    assert wd.lease("run_w4")["renewCount"] == 2


def test_watchdog_heartbeat_keeps_deadline_but_not_progress(repo):
    """A heartbeat renews the SLA deadline, but a run whose last PROGRESS is
    older than min_progress_seconds is still flagged as stalled."""
    wd = DeadlineWatchdog(repo, default_sla_seconds=3600, safety_factor=2.0,
                          min_progress_seconds=60)
    now = datetime.now(timezone.utc)
    t0 = (now - timedelta(seconds=10)).isoformat()
    # heartbeat renews (kind=heartbeat → lastProgressAt stays t0)
    wd.renew("run_hb", t0, sla_seconds=3600, kind="heartbeat")
    # only 10s since progress: within min-progress window → alive
    assert wd.check("run_hb", t0, now=now.isoformat()) is None
    # 5 minutes later a heartbeat renews the lease again...
    later = (now + timedelta(minutes=5)).isoformat()
    wd.renew("run_hb", t0, sla_seconds=3600, kind="heartbeat")
    # ...but progress is 5m old > min_progress_seconds → JOB_STALLED
    f = wd.check("run_hb", t0, now=later)
    assert f is not None and f["code"] == "JOB_STALLED"
    assert "min-progress" in f["evidenceRefs"][0]


def test_watchdog_lease_survives_restart(repo):
    """A new watchdog process (same repo) sees the persisted lease and flags
    expiry even when no watermark is passed in."""
    wd1 = DeadlineWatchdog(repo, default_sla_seconds=60, safety_factor=2.0)
    now = datetime.now(timezone.utc)
    wd1.renew("run_rs", (now - timedelta(seconds=5)).isoformat(), sla_seconds=60)
    # new instance = "restart"; it reads the lease, not caller state
    wd2 = DeadlineWatchdog(repo, default_sla_seconds=60, safety_factor=2.0)
    long_after = (now + timedelta(minutes=5)).isoformat()
    f = wd2.check("run_rs", None, now=long_after)
    assert f is not None and f["code"] == "JOB_STALLED"
    assert "lease expired" in f["evidenceRefs"][0]


# ---------------------------------------------------------------------------
# Remediation
# ---------------------------------------------------------------------------

def test_remediation_requires_approval(repo, rg):
    finding = rg.govern_spark(_spark_summary(status="FAILED"))[0]
    rem = Remediation(repo)
    proposal = rem.propose(finding, ["RESTART_JOB"])
    assert proposal["status"] == "PENDING_APPROVAL"
    # apply before approval → refused
    with pytest.raises(ValueError):
        rem.require_approval_before_apply(proposal["proposalId"])
    # reject
    rem.decide(proposal["proposalId"], "REJECT", os_actor="op@h")
    with pytest.raises(ValueError):
        rem.require_approval_before_apply(proposal["proposalId"])


def test_remediation_approved_then_applied(repo, rg):
    finding = rg.govern_spark(_spark_summary(status="FAILED"))[0]
    rem = Remediation(repo)
    proposal = rem.propose(finding, ["RESTART_JOB"])
    rem.decide(proposal["proposalId"], "APPROVE_REMEDIATION", os_actor="op@h")
    applied = rem.require_approval_before_apply(proposal["proposalId"])
    assert applied["status"] == "APPLIED"
    assert applied["approvedBy"] == "op@h"
    # double decision refused (versioned)
    with pytest.raises(ValueError):
        rem.decide(proposal["proposalId"], "APPROVE_REMEDIATION", os_actor="op@h")


def test_remediation_immutable_versions(repo):
    rem = Remediation(repo)
    proposal = rem.propose({"findingId": "gf_1", "runId": "r1", "pipelineId": "p1"},
                           ["action"])
    v1 = repo.get("remediation-proposal", proposal["proposalId"], 1)
    assert v1 is not None and v1.content["status"] == "PENDING_APPROVAL"
    # decided version is v2, v1 unchanged
    rem.decide(proposal["proposalId"], "REJECT", os_actor="op")
    v1_again = repo.get("remediation-proposal", proposal["proposalId"], 1)
    assert v1_again.content["status"] == "PENDING_APPROVAL"


# ---------------------------------------------------------------------------
# New detection rules (spec §6.5 gap closure)
# ---------------------------------------------------------------------------

class TestNewDetectionRules:
    def test_stage_retry_excessive(self, rg):
        findings = rg.govern_spark(_spark_summary(stages=[
            {"stageId": 1, "status": "SUCCEEDED", "retryCount": 5,
             "inputRows": 10, "outputRows": 10}]))
        assert any(f["code"] == "STAGE_RETRY_EXCESSIVE" for f in findings)

    def test_task_failure_rate_high_spark(self, rg):
        findings = rg.govern_spark(_spark_summary(
            taskSummary={"maxToMedianRatio": 2.0, "failedTaskRate": 0.2,
                         "executorLost": 0, "oomCount": 0}))
        assert any(f["code"] == "TASK_FAILURE_RATE_HIGH" for f in findings)

    def test_checkpoint_stale_code(self, rg):
        findings = rg.govern_flink(_flink_summary(
            checkpoints={"lastFailed": None, "staleSeconds": 500}))
        assert any(f["code"] == "CHECKPOINT_STALE" for f in findings)

    def test_flink_task_failure_rate_high(self, rg):
        findings = rg.govern_flink(_flink_summary(operators=[
            {"name": "op1", "failedSubtaskRate": 0.1}]))
        assert any(f["code"] == "TASK_FAILURE_RATE_HIGH" for f in findings)

    def test_partition_skew_code(self, rg):
        findings = rg.govern_iceberg(_iceberg_summary(
            partitionStats={"p1": 100, "p2": 900}))
        assert any(f["code"] == "PARTITION_SKEW" for f in findings)

    def test_schema_drift(self, rg):
        findings = rg.govern_iceberg(_iceberg_summary(schemaChanged=True))
        assert any(f["code"] == "SCHEMA_DRIFT" for f in findings)

    def test_freshness_delayed(self, rg):
        findings = rg.govern_iceberg(_iceberg_summary(freshnessSeconds=90000))
        assert any(f["code"] == "FRESHNESS_DELAYED" for f in findings)
        # within threshold → no finding
        clean = rg.govern_iceberg(_iceberg_summary(freshnessSeconds=60))
        assert not any(f["code"] == "FRESHNESS_DELAYED" for f in clean)
