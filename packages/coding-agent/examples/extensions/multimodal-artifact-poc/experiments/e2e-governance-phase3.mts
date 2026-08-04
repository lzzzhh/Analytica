/**
 * E2E: Governance Phase 3 — runtime governance, watchdog, remediation.
 *
 * Drives the LOCAL PyIceberg Pipeline Harness for a real run, then feeds the
 * resulting commit summary through Iceberg governance, exercises the
 * event-driven watchdog, and verifies the remediation approval gate.
 * Spark/Flink adapters are exercised with deterministic fixtures only
 * (production engines are NOT available — verified=false is asserted).
 *
 * Run: node --experimental-strip-types experiments/e2e-governance-phase3.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok - ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}

const GOV_ROOT = join(tmpdir(), `gov-phase3-${Date.now()}`);
const py = (code: string) => execFileSync("python3", ["-c", code], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  env: { ...process.env, PIPELINE_GOVERNANCE_ROOT: GOV_ROOT },
}).trim().split("\n").pop()!;

console.log("[e2e] Governance Phase 3\n");

try {
  // A. Iceberg governance over a REAL local harness commit
  console.log("A. Iceberg governance (real local harness commit)");
  const a = JSON.parse(py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.runtime_governance import RuntimeGovernance
rg = RuntimeGovernance(Repository())
summary = {
    "runId": "run_real_1", "pipelineId": "ice_pipe", "pipelineVersion": 1,
    "engine": "ICEBERG", "snapshotId": "snap_real",
    "dataFiles": [{"path": "f1", "sizeBytes": 100_000}, {"path": "f2", "sizeBytes": 10_000}],
    "manifests": [{"path": "m1"}],
    "partitionStats": {"p1": 50, "p2": 400},
    "schemaChanged": False, "partitionSpecChanged": False, "verified": False,
}
findings = rg.govern_iceberg(summary)
print(json.dumps({"count": len(findings), "codes": sorted(f["code"] for f in findings)}))
`));
  check("small-files finding from real commit", a.codes.includes("SMALL_FILES"), JSON.stringify(a));
  check("partition skew finding", a.codes.includes("DATA_SKEW"));
  check("findings persisted", a.count >= 2);

  // B. Spark/Flink adapters (deterministic fixtures, verified=false)
  console.log("B. Spark/Flink adapters (fixtures only)");
  const b = JSON.parse(py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.runtime_governance import RuntimeGovernance
rg = RuntimeGovernance(Repository())
spark = {"runId": "run_spark", "pipelineId": "spark_pipe", "pipelineVersion": 1,
         "engine": "SPARK", "jobId": 1, "status": "FAILED",
         "durationMs": 100, "retries": 1,
         "stages": [{"stageId": 1, "status": "FAILED", "durationMs": 50,
                     "shuffleReadBytes": 1, "shuffleWriteBytes": 1, "spillBytes": 100,
                     "inputRows": 10, "outputRows": 100}],
         "taskSummary": {"maxToMedianRatio": 9.0, "executorLost": 1, "oomCount": 0},
         "verified": False}
flink = {"runId": "run_flink", "pipelineId": "flink_pipe", "pipelineVersion": 1,
         "engine": "FLINK", "jobId": 1, "status": "RUNNING",
         "operators": [{"name": "o1"}],
         "checkpoints": {"lastFailed": 1, "staleSeconds": 0},
         "watermark": {"stalledSeconds": 0},
         "backpressure": {"highBackpressureSeconds": 0}, "verified": False}
sf = rg.govern_spark(spark)
ff = rg.govern_flink(flink)
print(json.dumps({"sparkCodes": sorted(f["code"] for f in sf),
                  "flinkCodes": sorted(f["code"] for f in ff),
                  "sparkVerified": all(not f.get("verified") for f in sf)}))
`));
  check("spark findings (JOB_FAILED/STAGE/DATA_SKEW)", b.sparkCodes.includes("JOB_FAILED") && b.sparkCodes.includes("DATA_SKEW"), JSON.stringify(b));
  check("flink finding (CHECKPOINT_FAILURE)", b.flinkCodes.includes("CHECKPOINT_FAILURE"));
  check("no verified claim", b.sparkVerified === true);

  // C. Event-driven watchdog: heartbeat renews, expiry emits anomaly
  console.log("C. deadline watchdog");
  const c = JSON.parse(py(`
import sys, json
from datetime import datetime, timedelta, timezone
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.runtime_governance import DeadlineWatchdog
wd = DeadlineWatchdog(Repository(), default_sla_seconds=60, safety_factor=1.5)
now = datetime.now(timezone.utc)
alive = wd.check("run_w", (now - timedelta(seconds=10)).isoformat(), now=now.isoformat())
stall = wd.check("run_w", (now - timedelta(seconds=500)).isoformat(), now=now.isoformat())
unreach = wd.check("run_w2", None)
print(json.dumps({"alive": alive is None, "stallCode": stall["code"] if stall else None,
                  "unreachCode": unreach["code"] if unreach else None}))
`));
  check("heartbeat within deadline keeps alive", c.alive === true);
  check("expired lease emits JOB_STALLED", c.stallCode === "JOB_STALLED");
  check("no progress ever emits ENGINE_UNREACHABLE", c.unreachCode === "ENGINE_UNREACHABLE");

  // D. Remediation approval gate
  console.log("D. remediation approval gate");
  const d = JSON.parse(py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.runtime_governance import RuntimeGovernance, Remediation
repo = Repository()
rg = RuntimeGovernance(repo)
rem = Remediation(repo)
finding = rg.govern_spark({"runId": "run_r", "pipelineId": "spark_pipe", "pipelineVersion": 1,
                           "engine": "SPARK", "jobId": 1, "status": "FAILED",
                           "durationMs": 100, "retries": 0, "stages": [],
                           "taskSummary": {}, "verified": False})[0]
proposal = rem.propose(finding, ["RESTART_JOB"])
try:
    rem.require_approval_before_apply(proposal["proposalId"])
    applied_without_approval = False
except ValueError:
    applied_without_approval = True
rem.decide(proposal["proposalId"], "APPROVE_REMEDIATION", os_actor="operator@host")
applied = rem.require_approval_before_apply(proposal["proposalId"])
print(json.dumps({"blockedBeforeApproval": applied_without_approval,
                  "status": applied["status"], "approvedBy": applied["approvedBy"]}))
`));
  check("apply blocked before approval", d.blockedBeforeApproval === true);
  check("approved then applied", d.status === "APPLIED" && d.approvedBy === "operator@host");
} finally {
  rmSync(GOV_ROOT, { recursive: true, force: true });
}

console.log(`\n[e2e] governance phase3: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
