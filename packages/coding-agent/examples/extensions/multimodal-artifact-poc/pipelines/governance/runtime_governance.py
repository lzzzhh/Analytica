"""Runtime governance — Spark/Flink/Iceberg adapters, findings, watchdog,
remediation.

IMPORTANT: production Spark/Flink are NOT available in this environment.
The adapters here are CONTRACT + DETERMINISTIC FIXTURES only — they validate
structured runtime summaries and produce deterministic findings from them.
Nothing claims verified production Spark/Flink behaviour; every summary
carries verified=false and the manifest records the engine verification
level.

The deadline watchdog is event-driven: heartbeat/progress events renew a
lease; expiry produces an anomaly event. It never restarts, modifies or
terminates a pipeline.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from pipelines.governance.contracts import is_valid_contract, sha256_canonical
from pipelines.governance.repository import Repository

FINDING_CODES = {
    "JOB_FAILED", "JOB_TIMEOUT", "JOB_STALLED", "STAGE_FAILURE", "DATA_SKEW",
    "HOT_KEY", "SHUFFLE_PRESSURE", "CHECKPOINT_FAILURE", "WATERMARK_STALL",
    "BACKPRESSURE", "SMALL_FILES", "SNAPSHOT_GROWTH", "INPUT_OUTPUT_MISMATCH",
    "DUPLICATE_DATA", "DATA_LOSS_SUSPECTED", "ENGINE_UNREACHABLE",
    "PERFORMANCE_DEGRADATION",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# ---------------------------------------------------------------------------
# Adapters — deterministic fixture-based governance
# ---------------------------------------------------------------------------

class RuntimeGovernance:
    """Consumes engine runtime summaries and emits GovernanceFindings.

    Each adapter validates the summary against its contract, runs
    deterministic rules, and returns findings. Findings are persisted via
    the Repository (objects) and surfaced as events by the caller.
    """

    def __init__(self, repo: Optional[Repository] = None):
        self.repo = repo or Repository()

    # -- Spark -----------------------------------------------------------

    def govern_spark(self, summary: dict) -> list[dict]:
        if not is_valid_contract("spark-runtime-summary", summary):
            raise ValueError("invalid Spark runtime summary")
        findings: list[dict] = []
        run_id = summary["runId"]
        pipeline_id = summary["pipelineId"]
        pipeline_version = summary["pipelineVersion"]

        # JOB_FAILED / JOB_STALLED
        if summary["status"] == "FAILED":
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "JOB_FAILED", "HIGH", True,
                                          [f"spark-job-{summary['jobId']}"],
                                          ["RESTART_JOB", "CHECK_LOG"]))
        for stage in summary.get("stages", []):
            if stage.get("status") == "FAILED":
                findings.append(self._finding(pipeline_id, pipeline_version, run_id, "STAGE_FAILURE", "HIGH", True,
                                              [f"spark-stage-{stage['stageId']}"],
                                              ["REVIEW_STAGE", "REPARTITION"]))
            # shuffle pressure: spill > 0
            if (stage.get("spillBytes") or 0) > 0:
                findings.append(self._finding(pipeline_id, pipeline_version, run_id, "SHUFFLE_PRESSURE", "MEDIUM", False,
                                              [f"spark-stage-{stage['stageId']}"],
                                              ["INCREASE_PARTITIONS", "SALT_HOT_KEYS"]))
            # stage retried too many times
            if (stage.get("retryCount") or 0) > 2:
                findings.append(self._finding(pipeline_id, pipeline_version, run_id,
                                              "STAGE_RETRY_EXCESSIVE", "MEDIUM", False,
                                              [f"spark-stage-{stage['stageId']}"],
                                              ["REVIEW_STAGE", "REVIEW_SLA"]))
            # data skew: output >> input ratio or hot partition
            inp = stage.get("inputRows") or 0
            out = stage.get("outputRows") or 0
            if inp > 0 and out > inp * 5:
                findings.append(self._finding(pipeline_id, pipeline_version, run_id, "DATA_SKEW", "MEDIUM", False,
                                              [f"spark-stage-{stage['stageId']}"],
                                              ["REPARTITION", "HOT_KEY_SALTING"]))
        # task summary: max/median ratio > 5 → skew
        ts = summary.get("taskSummary") or {}
        if ts.get("maxToMedianRatio") is not None and ts["maxToMedianRatio"] > 5:
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "DATA_SKEW", "MEDIUM", False,
                                          ["spark-task-summary"],
                                          ["REPARTITION", "HOT_KEY_SALTING"]))
        # high task failure rate
        if ts.get("failedTaskRate") is not None and ts["failedTaskRate"] > 0.05:
            findings.append(self._finding(pipeline_id, pipeline_version, run_id,
                                          "TASK_FAILURE_RATE_HIGH", "HIGH", True,
                                          ["spark-task-summary"], ["REVIEW_STAGE", "CHECK_ENGINE"]))
        # executor lost / OOM
        if ts.get("executorLost") or ts.get("oomCount"):
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "JOB_FAILED", "HIGH", True,
                                          ["spark-task-summary"],
                                          ["REVIEW_EXECUTOR_MEMORY"]))
        return findings

    # -- Flink -----------------------------------------------------------

    def govern_flink(self, summary: dict) -> list[dict]:
        if not is_valid_contract("flink-runtime-summary", summary):
            raise ValueError("invalid Flink runtime summary")
        findings: list[dict] = []
        run_id = summary["runId"]
        pipeline_id = summary["pipelineId"]
        pipeline_version = summary["pipelineVersion"]

        if summary["status"] == "FAILED":
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "JOB_FAILED", "HIGH", True,
                                          [f"flink-job-{summary['jobId']}"],
                                          ["RESTART_JOB", "CHECK_CHECKPOINT"]))
        ckpt = summary.get("checkpoints") or {}
        if ckpt.get("lastFailed") is not None:
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "CHECKPOINT_FAILURE", "HIGH", True,
                                          ["flink-checkpoint"], ["INCREASE_TIMEOUT", "REVIEW_STATE_SIZE"]))
        if ckpt.get("staleSeconds") is not None and ckpt["staleSeconds"] > 300:
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "CHECKPOINT_STALE", "MEDIUM", False,
                                          ["flink-checkpoint"], ["INVESTIGATE_CHECKPOINT_STALL"]))
        wm = summary.get("watermark") or {}
        if wm.get("stalledSeconds") is not None and wm["stalledSeconds"] > 300:
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "WATERMARK_STALL", "MEDIUM", False,
                                          ["flink-watermark"], ["CHECK_SOURCE", "INCREASE_IDLE_TIMEOUT"]))
        for op in summary.get("operators", []):
            if (op.get("failedSubtaskRate") or 0) > 0.05:
                findings.append(self._finding(pipeline_id, pipeline_version, run_id,
                                              "TASK_FAILURE_RATE_HIGH", "HIGH", True,
                                              [f"flink-operator-{op.get('name', '?')}"],
                                              ["REVIEW_STAGE", "SCALE_OUT"]))
        bp = summary.get("backpressure") or {}
        if bp.get("highBackpressureSeconds") is not None and bp["highBackpressureSeconds"] > 60:
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "BACKPRESSURE", "MEDIUM", False,
                                          ["flink-backpressure"], ["SCALE_OUT", "OPTIMIZE_OPERATOR"]))
        return findings

    # -- Iceberg ---------------------------------------------------------

    def govern_iceberg(self, summary: dict) -> list[dict]:
        if not is_valid_contract("iceberg-commit-summary", summary):
            raise ValueError("invalid Iceberg commit summary")
        findings: list[dict] = []
        run_id = summary["runId"]
        pipeline_id = summary["pipelineId"]
        pipeline_version = summary["pipelineVersion"]

        files = summary.get("dataFiles") or []
        small_files = [f for f in files if (f.get("sizeBytes") or 0) < 64 * 1024]
        if small_files:
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "SMALL_FILES", "LOW", False,
                                          [f"iceberg-snapshot-{summary['snapshotId']}"],
                                          ["COMPACTION"]))
        parts = summary.get("partitionStats") or {}
        if parts:
            sizes = [v for v in parts.values() if isinstance(v, (int, float)) and v > 0]
            if len(sizes) > 1 and max(sizes) > 5 * min(sizes):
                findings.append(self._finding(pipeline_id, pipeline_version, run_id, "PARTITION_SKEW", "MEDIUM", False,
                                              ["iceberg-partitions"], ["REPARTITION"]))
        # schema drift: the commit changed the table schema
        if summary.get("schemaChanged"):
            findings.append(self._finding(pipeline_id, pipeline_version, run_id,
                                          "SCHEMA_DRIFT", "HIGH", True,
                                          [f"iceberg-snapshot-{summary['snapshotId']}"],
                                          ["REVIEW_STAGE", "CHECK_SOURCE"]))
        # freshness delayed beyond 24h
        fresh = summary.get("freshnessSeconds")
        if fresh is not None and fresh > 24 * 3600:
            findings.append(self._finding(pipeline_id, pipeline_version, run_id,
                                          "FRESHNESS_DELAYED", "MEDIUM", False,
                                          [f"iceberg-snapshot-{summary['snapshotId']}"],
                                          ["CHECK_SOURCE", "REVIEW_SLA"]))
        # snapshot growth: excessive new files per run
        if len(files) > 500:
            findings.append(self._finding(pipeline_id, pipeline_version, run_id, "SNAPSHOT_GROWTH", "LOW", False,
                                          [f"iceberg-snapshot-{summary['snapshotId']}"],
                                          ["COMPACTION", "REVIEW_WRITE_FREQUENCY"]))
        return findings

    def _finding(self, pipeline_id: str, pipeline_version: int, run_id: str,
                 code: str, severity: str, blocking: bool,
                 evidence_refs: list[str], actions: list[str]) -> dict:
        f = {
            "findingId": _new_id("gf"),
            "pipelineId": pipeline_id,
            "pipelineVersion": pipeline_version,
            "runId": run_id,
            "category": "RUNTIME_PERFORMANCE",
            "code": code,
            "severity": severity,
            "status": "OPEN",
            "blocking": blocking,
            "evidenceRefs": evidence_refs,
            "recommendedActions": actions,
        }
        if not is_valid_contract("governance-finding", f):
            raise ValueError("produced invalid finding")
        self.repo.put("governance-finding", f["findingId"], 1, f)
        return f


# ---------------------------------------------------------------------------
# Deadline Watchdog — event-driven lease + expiry (never Cron)
# ---------------------------------------------------------------------------

class DeadlineWatchdog:
    """Progress/heartbeat events renew a PERSISTENT lease; expiry emits an
    anomaly event. The lease is stored as a versioned, immutable watchdog-lease
    object so a restart or a second process sees the same deadlines.

    Heartbeat vs progress are kept separate: a heartbeat keeps the overall
    deadline alive, but a run whose LAST PROGRESS is older than
    min_progress_seconds is flagged as stalled even while heartbeats continue
    (min_progress_seconds is enforced, not just computed).

    The watchdog NEVER restarts, modifies or terminates pipelines. It only
    produces finding objects + a WATCHDOG event for the reducer.
    """

    def __init__(self, repo: Optional[Repository] = None,
                 default_sla_seconds: int = 3600,
                 safety_factor: float = 1.5,
                 min_progress_seconds: int = 60):
        self.repo = repo or Repository()
        self.default_sla_seconds = default_sla_seconds
        self.safety_factor = safety_factor
        self.min_progress_seconds = min_progress_seconds

    # -- lease persistence -------------------------------------------------

    def _lease_id(self, run_id: str) -> str:
        return f"wl_{run_id}"

    def renew(self, run_id: str, last_progress_at: str,
              sla_seconds: Optional[int] = None,
              pipeline_id: str = "pipeline_1", pipeline_version: int = 1,
              kind: str = "progress") -> str:
        """Persist a renewed lease from a progress/heartbeat event. Returns
        the new deadline. The lease object is versioned and immutable —
        every renewal appends a new version (renewCount increments)."""
        sla = sla_seconds or self.default_sla_seconds
        now_dt = datetime.now(timezone.utc)
        deadline = now_dt + timedelta(seconds=sla * self.safety_factor)
        prev = self.repo.get("watchdog-lease", self._lease_id(run_id))
        lease_id = self._lease_id(run_id)
        # progress events advance the progress watermark; heartbeats do not
        last_progress = last_progress_at if kind == "progress" else (
            prev.content["lastProgressAt"] if prev else None)
        lease = {
            "leaseId": lease_id,
            "runId": run_id,
            "pipelineId": pipeline_id,
            "pipelineVersion": pipeline_version,
            "lastProgressAt": last_progress,
            "lastHeartbeatAt": now_dt.isoformat(),
            "deadlineAt": deadline.isoformat(),
            "slaSeconds": sla,
            "safetyFactor": self.safety_factor,
            "minProgressSeconds": self.min_progress_seconds,
            "renewCount": (prev.content["renewCount"] if prev else 0) + 1,
            "updatedAt": now_dt.isoformat(),
        }
        if not is_valid_contract("watchdog-lease", lease):
            raise ValueError("invalid watchdog lease")
        v = max(self.repo.versions("watchdog-lease", lease_id) or [0]) + 1
        self.repo.put("watchdog-lease", lease_id, v, lease)
        return deadline.isoformat()

    def lease(self, run_id: str) -> Optional[dict]:
        """Latest persisted lease for a run, or None."""
        obj = self.repo.get("watchdog-lease", self._lease_id(run_id))
        return obj.content if obj else None

    # -- evaluation --------------------------------------------------------

    def check(self, run_id: str, last_progress_at: Optional[str],
              now: Optional[str] = None,
              pipeline_id: str = "pipeline_1",
              pipeline_version: int = 1) -> Optional[dict]:
        """Evaluate one run's deadline against the persisted lease. Returns an
        anomaly finding when the lease expired or progress stalled; None
        otherwise. Heartbeats keep the deadline alive but do NOT satisfy the
        min-progress requirement."""
        if last_progress_at is None and self.lease(run_id) is None:
            return self._anomaly(pipeline_id, pipeline_version, run_id, "ENGINE_UNREACHABLE",
                                 "no progress ever recorded", ["CHECK_ENGINE"])
        now_dt = datetime.fromisoformat(now) if now else datetime.now(timezone.utc)

        # preferred source: the persisted lease (survives restart); fall back
        # to the caller-provided watermark only when no lease exists yet.
        lease = self.lease(run_id)
        if lease is not None:
            progress_at = lease["lastProgressAt"] or last_progress_at
            heartbeat_at = lease["lastHeartbeatAt"]
            deadline_at = datetime.fromisoformat(lease["deadlineAt"])
            min_prog = lease["minProgressSeconds"]
            if now_dt > deadline_at:
                return self._anomaly(
                    pipeline_id, pipeline_version, run_id, "JOB_STALLED",
                    f"lease expired at {lease['deadlineAt']} (deadline "
                    f"{lease['slaSeconds'] * lease['safetyFactor']:.0f}s, "
                    f"renewed {lease['renewCount']}x)",
                    ["CHECK_JOB", "REVIEW_SLA"])
            # heartbeat alive but no real progress within min-progress window
            if progress_at is not None:
                progress_dt = datetime.fromisoformat(progress_at)
                age_seconds = (now_dt - progress_dt).total_seconds()
                if age_seconds > min_prog:
                    return self._anomaly(
                        pipeline_id, pipeline_version, run_id, "JOB_STALLED",
                        f"no progress for {int(age_seconds)}s "
                        f"(min-progress {min_prog}s; heartbeat at {heartbeat_at})",
                        ["CHECK_JOB", "REVIEW_SLA"])
            return None

        # no lease yet: fall back to SLA-only judgement on the raw watermark
        progress_dt = datetime.fromisoformat(last_progress_at)
        age_seconds = (now_dt - progress_dt).total_seconds()
        if age_seconds > self.default_sla_seconds * self.safety_factor:
            return self._anomaly(pipeline_id, pipeline_version, run_id, "JOB_STALLED",
                                 f"no progress for {int(age_seconds)}s "
                                 f"(deadline {self.default_sla_seconds * self.safety_factor}s)",
                                 ["CHECK_JOB", "REVIEW_SLA"])
        return None

    def _anomaly(self, pipeline_id: str, pipeline_version: int, run_id: str,
                 code: str, detail: str, actions: list[str]) -> dict:
        f = {
            "findingId": _new_id("gf"),
            "pipelineId": pipeline_id,
            "pipelineVersion": pipeline_version,
            "runId": run_id,
            "category": "INFRASTRUCTURE",
            "code": code,
            "severity": "HIGH",
            "status": "OPEN",
            "blocking": code in ("ENGINE_UNREACHABLE", "JOB_STALLED"),
            "evidenceRefs": [f"watchdog:{detail}"],
            "recommendedActions": actions,
        }
        if not is_valid_contract("governance-finding", f):
            raise ValueError("produced invalid watchdog finding")
        self.repo.put("governance-finding", f["findingId"], 1, f)
        return f


# ---------------------------------------------------------------------------
# Remediation — proposals require operator approval; never auto-applied
# ---------------------------------------------------------------------------

class Remediation:
    """Remediation proposals from findings. APPROVAL GATE: a proposal can
    only be APPLIED after an operator APPROVE_REMEDIATION decision — the
    remediation itself only marks the proposal; applying (re-running,
    changing parallelism, etc.) is out of scope and never automatic.

    Decisions go through the shared OperatorApproval (OPERATOR_CLI source,
    object-hash binding, immutable versions)."""

    def __init__(self, repo: Optional[Repository] = None):
        self.repo = repo or Repository()
        from pipelines.governance.approval import OperatorApproval
        self.approvals = OperatorApproval(repo)

    def propose(self, finding: dict, actions: list[str]) -> dict:
        proposal = {
            "proposalId": _new_id("rp"),
            "findingId": finding["findingId"],
            "pipelineId": finding.get("pipelineId", "pipeline_1"),
            "runId": finding["runId"],
            "actions": actions,
            "status": "PENDING_APPROVAL",
            "createdAt": _now(),
            "approvedBy": None,
            "appliedAt": None,
        }
        if not is_valid_contract("remediation-proposal", proposal):
            raise ValueError("invalid remediation proposal")
        self.repo.put("remediation-proposal", proposal["proposalId"], 1, proposal)
        return proposal

    def decide(self, proposal_id: str, decision: str,
               os_actor: str, comment: str = "") -> dict:
        """Operator decision via the shared approval store. APPROVE_REMEDIATION
        marks the proposal approved (it does NOT apply anything)."""
        obj = self.repo.get("remediation-proposal", proposal_id)
        if obj is None:
            raise ValueError(f"proposal {proposal_id} not found")
        proposal = obj.content
        if proposal["status"] != "PENDING_APPROVAL":
            raise ValueError(f"proposal {proposal_id} already decided")
        if decision == "APPROVE_REMEDIATION":
            status = "APPROVED"
        elif decision in ("REQUEST_CHANGES", "REJECT"):
            status = "REJECTED"
        else:
            raise ValueError(f"invalid decision {decision!r}")
        # shared approval record (hash-bound, OPERATOR_CLI) — binds the
        # hash of the decided object, which is what require_approval_before_apply
        # re-hashes; tampering with either version invalidates the decision.
        decided = {**proposal, "status": status, "approvedBy": os_actor}
        object_hash = sha256_canonical(decided)
        self.approvals.record("remediation", proposal_id, decision, os_actor,
                              object_hash, comment)
        v = max(self.repo.versions("remediation-proposal", proposal_id) or [0]) + 1
        self.repo.put("remediation-proposal", proposal_id, v, decided)
        return decided

    def require_approval_before_apply(self, proposal_id: str) -> dict:
        """The ONLY way to reach APPLIED: must be operator-approved first,
        and the proposal hash must be unchanged since the decision."""
        obj = self.repo.get("remediation-proposal", proposal_id)
        if obj is None or obj.content["status"] != "APPROVED":
            raise ValueError(
                f"proposal {proposal_id} is not operator-approved — refusing to apply")
        self.approvals.require_decision("remediation", proposal_id,
                                        "APPROVE_REMEDIATION",
                                        sha256_canonical(obj.content))
        applied = {**obj.content, "status": "APPLIED", "appliedAt": _now()}
        v = max(self.repo.versions("remediation-proposal", proposal_id)) + 1
        self.repo.put("remediation-proposal", proposal_id, v, applied)
        return applied


def generate_governance_report(repo, pipeline_id: str, run_id: str,
                               pipeline_version: int = 1) -> dict:
    """Aggregate open findings into a versioned GovernanceReport (§13 #10).
    The report references findings (never embeds raw logs); blocking reports
    flag that a human decision is required before the pipeline proceeds."""
    from pipelines.governance.contracts import is_valid_contract
    finding_refs = []
    blocking = False
    for entry in repo.ledger():
        if entry.get("type") != "governance-finding":
            continue
        obj = repo.get("governance-finding", entry.get("id"), entry.get("version"))
        if obj is None:
            continue
        f = obj.content
        if f.get("runId") != run_id:
            continue
        finding_refs.append(f.get("findingId") or entry.get("id"))
        if f.get("blocking"):
            blocking = True
    report = {
        "reportId": f"gr_{uuid.uuid4().hex[:12]}",
        "pipelineId": pipeline_id,
        "pipelineVersion": pipeline_version,
        "runId": run_id,
        "findingRefs": finding_refs,
        "blocking": blocking,
        "summary": (
            f"{len(finding_refs)} finding(s) for run {run_id}"
            + (" — BLOCKING, human decision required" if blocking else "")
        ),
        "createdAt": _now(),
    }
    if not is_valid_contract("governance-report", report):
        raise ValueError("generated governance report fails contract validation")
    return report
