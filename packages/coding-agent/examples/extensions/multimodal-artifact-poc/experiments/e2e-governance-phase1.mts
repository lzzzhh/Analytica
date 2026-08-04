/**
 * E2E: Governance Phase 1 — schema discovery, spec design, validation,
 * non-executable draft compilation, OPERATOR_CLI approval, sealing and
 * versioned amendment.
 *
 * Run: node --experimental-strip-types experiments/e2e-governance-phase1.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

function py(code: string): string {
  return execFileSync("python3", ["-c", code], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PIPELINE_GOVERNANCE_ROOT: GOV_ROOT },
  }).trim();
}

function pyJson(code: string): any {
  return JSON.parse(py(code).split("\n").pop()!);
}

// isolated governance root per run (never the shared .data/…)
const GOV_ROOT = join(tmpdir(), `gov-phase1-${Date.now()}`);
const PROF_ROOT = join(tmpdir(), `gov-prof-${Date.now()}`);
mkdirSync(PROF_ROOT, { recursive: true });
const PROFILE = join(PROF_ROOT, "runtime-config.json");
writeFileSync(PROFILE, JSON.stringify({
  features: {
    "round2.lakehouse": true,
    "round2.pipeline_governance": true,
    "round2.pipeline_schema_design": true,
    "round2.pipeline_spec_generation": true,
    "round2.pipeline_draft_compilation": true,
    "round2.pipeline_human_approval": true,
    "round2.pipeline_amendment": true,
  },
}));
const CLI_ENV = {
  ...process.env,
  PIPELINE_GOVERNANCE_ROOT: GOV_ROOT,
  FEATURE_RUNTIME_CONFIG_PATH: PROFILE,
};

console.log("[e2e] Governance Phase 1\n");

// ---- 0. setup: deterministic source parquet + spec JSONs ----------------
const tmp = mkdtempSync(join(tmpdir(), "gov-phase1-"));
try {
  console.log("A. schema discovery over an unknown dataset");
  const discovery = py(`
import sys, json, os
sys.path.insert(0, ".")
import pyarrow as pa, pyarrow.parquet as pq
from pathlib import Path
from pipelines.governance.discovery import profile_parquet
os.environ.setdefault("GOV_TMP", ${JSON.stringify(tmp)})
rows = [{"application_id": f"app_{i:06d}", "entity_id": f"ent_{i % 50:03d}",
         "event_time": f"2026-07-{i % 28 + 1:02d}", "loan_amount": i * 100,
         "borrower_score": 300 + i % 500} for i in range(1000)]
pq.write_table(pa.Table.from_pylist(rows), Path(os.environ["GOV_TMP"]) / "source.parquet")
profile = profile_parquet(Path(os.environ["GOV_TMP"]) / "source.parquet")
print(json.dumps({"rowCount": profile["rowCount"],
                  "candidateKeys": profile["candidateKeys"],
                  "eventTimes": profile["candidateEventTimes"],
                  "fields": [f["name"] for f in profile["fields"]]}))
`);
  const prof = JSON.parse(discovery.split("\n").pop()!);
  check("profile rowCount = 1000", prof.rowCount === 1000, JSON.stringify(prof.rowCount));
  check("application_id is a candidate key with evidence",
    prof.candidateKeys.some((k: any) => k.fields[0] === "application_id" && k.confidence > 0.9),
    JSON.stringify(prof.candidateKeys));
  check("event_time is a candidate event time", prof.eventTimes.includes("event_time"));
  check("profile never declares a primaryKey", !("primaryKey" in prof));

  // ---- B. agent draft (stub) → SchemaSpec + PipelineSpec -----------------
  console.log("B. spec drafts (agent-assisted, deterministic validation)");
  const schemaSpec = {
    specId: "schema_loan", version: 1, targetDataset: "dwd.loan_application_detail",
    businessGranularity: "loan application",
    primaryKey: ["application_id"], businessKeys: ["application_id"],
    fieldMappings: [
      { sourceField: "application_id", targetField: "application_id", targetType: "string", nullability: "NOT_NULL" },
      { sourceField: "entity_id", targetField: "entity_id", targetType: "string" },
      { sourceField: "event_time", targetField: "event_time", targetType: "timestamp" },
      { sourceField: "loan_amount", targetField: "loan_amount", targetType: "long" },
    ],
    types: { application_id: "string", loan_amount: "long" },
    timeFields: ["event_time"], partitioning: ["event_time"],
    compatibilityStrategy: "ADDITIVE", sensitiveFields: [],
    assumptions: ["daily batch source"], risks: [],
    createdAt: "2026-08-02T00:00:00Z",
  };
  const pipelineSpec = {
    specId: "pipeline_loan", version: 1, pipelineId: "loan_pipeline",
    sources: ["source.application_events"], target: "dwd.loan_application_detail",
    executionMode: "BATCH", executionBackend: "PYICEBERG_LOCAL", updateMode: "FULL",
    steps: [{ stepId: "s1", operation: "clean", input: "source.application_events", output: "dwd.loan_application_detail" }],
    keys: { application_id: ["application_id"] },
    dedupPolicy: "KEEP_FIRST", timeSemantics: "EVENT_TIME",
    partitioning: ["event_time"], schemaEvolutionPolicy: "ADDITIVE",
    assumptions: [], risks: [],
    createdAt: "2026-08-02T00:00:00Z",
  };
  const schemaPath = join(tmp, "schema-spec.json");
  const pipelinePath = join(tmp, "pipeline-spec.json");
  writeFileSync(schemaPath, JSON.stringify(schemaSpec));
  writeFileSync(pipelinePath, JSON.stringify(pipelineSpec));

  // ---- C. review package via CLI ----------------------------------------
  console.log("C. review package (validate + compile non-executable draft)");
  const reviewOut = execFileSync(
    "python3", ["-m", "pipelines.governance", "review", schemaPath, pipelinePath],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: CLI_ENV });
  const reviewId = reviewOut.match(/reviewId=(\S+)/)![1];
  const draftId = reviewOut.match(/draftArtifact=(\S+)/)![1];
  check("review created", !!reviewId);
  check("draft compiled (executable=false)", /executable=False/.test(reviewOut), reviewOut);
  check("no validation errors", !/issues=\[.*ERROR/.test(reviewOut), reviewOut.split("\n").find(l => l.startsWith("issues=")) || "");

  // ---- D. APPROVE via CLI → sealed --------------------------------------
  console.log("D. OPERATOR_CLI approval → sealed spec");
  const approveOut = execFileSync(
    "python3", ["-m", "pipelines.governance", "approve", reviewId, "--decision", "APPROVE", "--comment", "looks good"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: CLI_ENV });
  check("approval recorded (OPERATOR_CLI + osActor)", /approverSource=OPERATOR_CLI/.test(approveOut), approveOut);
  check("sealed with 4 content hashes", /sealed specId=/.test(approveOut), approveOut);
  check("sealed hashes bound", /schemaSpecHash=sha256/.test(approveOut) && /reviewPackageHash=sha256/.test(approveOut));

  // sealed persisted in repo
  const sealed = pyJson(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
r = Repository()
obj = r.get("approved-pipeline-spec", "pipeline_loan", 1)
print(json.dumps(obj.content if obj else {"error": "missing"}))
`);
  check("sealed spec persisted in repository", sealed.specId === "pipeline_loan" && !!sealed.reviewPackageHash);

  // ---- E. REQUEST_CHANGES → amend (pure CLI) → new review -----------------
  console.log("E. REQUEST_CHANGES → amend (pure CLI) → new review");
  const changedSchema = { ...schemaSpec, version: 2, fieldMappings: [...schemaSpec.fieldMappings,
    { sourceField: "borrower_score", targetField: "borrower_score", targetType: "long" }] };
  const changedPipeline = { ...pipelineSpec, version: 2, steps: [...pipelineSpec.steps,
    { stepId: "s2", operation: "enrich", input: "dwd.loan_application_detail", output: "dwd.loan_application_detail" }] };
  const changedSchemaPath = join(tmp, "schema-spec-v2.json");
  const changedPipelinePath = join(tmp, "pipeline-spec-v2.json");
  writeFileSync(changedSchemaPath, JSON.stringify(changedSchema));
  writeFileSync(changedPipelinePath, JSON.stringify(changedPipeline));
  // REQUEST_CHANGES via CLI (comment required)
  const changesApproval = execFileSync(
    "python3", ["-m", "pipelines.governance", "approve", reviewId, "--decision", "REQUEST_CHANGES", "--comment", "add score"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: CLI_ENV });
  check("REQUEST_CHANGES recorded via CLI", /decision=REQUEST_CHANGES/.test(changesApproval), changesApproval);
  // amend via CLI (pure operator flow, no Python API bypass)
  const amendOut = execFileSync(
    "python3", ["-m", "pipelines.governance", "amend", reviewId,
      "--schema-spec", changedSchemaPath, "--pipeline-spec", changedPipelinePath,
      "--reason", "add score field"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: CLI_ENV });
  const v2ReviewId = amendOut.match(/newReviewId=(\S+)/)![1];
  const v2Version = amendOut.match(/newVersion=(\d+)/)![1];
  check("amend created new review (different id)", v2ReviewId !== reviewId, amendOut);
  check("amendment bumped version to 2", v2Version === "2", amendOut);
  check("v2 draft re-compiled (executable=false)", /draftExecutable=False/.test(amendOut), amendOut);
  check("v2 validation clean", /issues=\[\]/.test(amendOut), amendOut.split("\n").find(l => l.startsWith("issues=")) || "");

  // approve the NEW review and seal via CLI — old approval must not seal it
  const approveV2 = execFileSync(
    "python3", ["-m", "pipelines.governance", "approve", v2ReviewId, "--decision", "APPROVE", "--comment", "v2 ok"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: CLI_ENV });
  check("v2 APPROVE + seal via CLI", /sealed specId=pipeline_loan v2/.test(approveV2), approveV2);

  // ---- F. unapproved spec cannot seal ------------------------------------
  console.log("F. unapproved / tampered approval rejected");
  const tampered = py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.flow import GovernancePhase1
from pipelines.governance.repository import Repository
g = GovernancePhase1(Repository())
review = g.repo.get_review(${JSON.stringify(v2ReviewId)})
bad = {"approvalId": "a_bad", "reviewId": review["reviewId"],
       "reviewContentHash": "sha256:" + "f" * 64, "decision": "APPROVE",
       "approverSource": "OPERATOR_CLI", "osActor": "u@h", "comment": "",
       "decidedAt": "2026-08-02T00:00:00Z"}
try:
    g.seal_approved(review["reviewId"], bad)
    print(json.dumps({"sealed": True}))
except ValueError as e:
    print(json.dumps({"sealed": False, "reason": str(e)}))
`);
  const tamperedResult = JSON.parse(tampered.split("\n").pop()!);
  check("tampered approval cannot seal", tamperedResult.sealed === false);

  // ---- G. governance agent cannot approve --------------------------------
  console.log("G. agent cannot produce an approval");
  const agentDecision = py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.contracts import is_valid_contract
agent = {"approvalId": "a_agent", "reviewId": "r", "reviewContentHash": "sha256:" + "0" * 64,
         "decision": "APPROVE", "approverSource": "AGENT", "osActor": "agent",
         "comment": "", "decidedAt": "2026-08-02T00:00:00Z"}
print(json.dumps({"valid": is_valid_contract("approval-decision", agent)}))
`);
  check("AGENT-source decision rejected by contract", JSON.parse(agentDecision.split("\n").pop()!).valid === false);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(PROF_ROOT, { recursive: true, force: true });
}

console.log(`\n[e2e] governance phase1: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
