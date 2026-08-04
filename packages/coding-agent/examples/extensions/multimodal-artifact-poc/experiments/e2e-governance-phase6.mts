/**
 * E2E: Governance Phase 6 — multi-pipeline status dashboard + UI channel.
 *
 * Verifies: the dashboard overview/detail are projections of the reducer's
 * authoritative snapshots (no second state store); agent context and the
 * dashboard consume the SAME snapshots; the model-facing summary is compact
 * (no payload numbers); the UI-only details payload carries the full view.
 *
 * Run: node --experimental-strip-types experiments/e2e-governance-phase6.mts
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

const GOV_ROOT = join(tmpdir(), `gov-phase6-${Date.now()}`);
const SEED = `
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.event_store import EventStore
from pipelines.governance.state_reducer import StateReducer
from pipelines.governance.status_dashboard import StatusDashboard
from pipelines.governance.agent_worker import build_context_package
from pipelines.governance.contracts import sha256_canonical
repo = Repository(); store = EventStore(repo); reducer = StateReducer(store)
def evt(seq, etype, run, payload=None):
    return {"eventId": f"evt_{run}_{seq:04d}_{etype.lower()[:10]}", "eventType": etype,
            "pipelineId": "p_1", "pipelineVersion": 1, "runId": run,
            "source": "PIPELINE_GOVERNANCE", "sequenceNumber": seq,
            "occurredAt": f"2026-08-02T00:00:{seq:02d}Z",
            "payloadHash": sha256_canonical(payload or {}), "payloadRef": None,
            "supersedesEventId": None, "payload": payload or {}}
`;
const py = (code: string) => execFileSync("python3", ["-c", SEED + code], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  env: { ...process.env, PIPELINE_GOVERNANCE_ROOT: GOV_ROOT },
}).trim().split("\n").pop()!;

console.log("[e2e] Governance Phase 6\n");

try {
  // A. multi-pipeline dashboard from real snapshots
  console.log("A. multi-pipeline dashboard");
  const a = JSON.parse(py(`
store.append(evt(1, "RUN_CREATED", "run_alpha"))
store.append(evt(2, "RUN_STARTED", "run_alpha"))
store.append(evt(1, "RUN_CREATED", "run_beta"))
store.append(evt(2, "RUN_FAILED", "run_beta"))
store.append(evt(1, "RUN_CREATED", "run_gamma"))
store.append(evt(2, "PROCESSING_COMPLETED", "run_gamma"))
d = StatusDashboard(reducer)
rows = d.overview()
print(json.dumps({"count": len(rows),
                  "states": {r["runId"]: r["state"] for r in rows},
                  "severities": {r["runId"]: r["severity"] for r in rows}}))
`));
  check("three pipelines shown", a.count === 3, JSON.stringify(a));
  check("run_alpha RUNNING", a.states.run_alpha === "RUNNING");
  check("run_beta FAILED (severity HIGH)", a.states.run_beta === "FAILED" && a.severities.run_beta === "HIGH");
  check("run_gamma PROCESSING_COMPLETED", a.states.run_gamma === "PROCESSING_COMPLETED");

  // B. agent context uses the same snapshot as the dashboard
  console.log("B. single source of truth");
  const b = JSON.parse(py(`
snap = StatusDashboard(reducer).detail("run_alpha")["snapshot"]
pkg = build_context_package(snap, ["evt_run_alpha_0002"])
print(json.dumps({"dashboardState": snap["state"], "agentState": pkg["currentState"],
                  "agentEngine": pkg["currentEngineContext"]["engine"]}))
`));
  check("dashboard == agent snapshot state", b.dashboardState === b.agentState);

  // C. model text compact, UI details full
  console.log("C. UI channel separation");
  const c = JSON.parse(py(`
store.append(evt(1, "RUN_CREATED", "run_delta"))
store.append(evt(2, "FINDING_DETECTED", "run_delta", {"findingId": "gf_delta", "evidence": "payload 918273.645"}))
d = StatusDashboard(reducer)
model = d.model_facing_summary()
ui = d.ui_details()
print(json.dumps({"modelHasPayload": "918273.645" in model,
                  "uiRows": len(ui["rows"]), "uiType": ui["dashboardType"]}))
`));
  check("model text excludes payload numbers", c.modelHasPayload === false);
  check("UI details carries full rows", c.uiRows >= 4 && c.uiType === "PIPELINE_GOVERNANCE");
} finally {
  rmSync(GOV_ROOT, { recursive: true, force: true });
}

console.log(`\n[e2e] governance phase6: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
