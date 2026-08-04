/**
 * Governance Phase 6 — dashboard + Pi UI-only channel tests (TypeScript).
 *
 * Verifies:
 *   - the dashboard overview/detail come from the reducer's authoritative
 *     snapshots (single source of truth);
 *   - the model-facing summary carries only refs/state (no numeric payloads);
 *   - the UI-only details payload (renderResult channel) carries the full
 *     structured view and never appears in the model-facing content;
 *   - feature-off => the dashboard tool is not registered.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeatureResolver } from "../src/features/resolver.ts";
import { buildExtensionRegistrations } from "../index.ts";
import { buildGovernanceStatusTool } from "../src/governance/tool.ts";
import { modelSummaryText } from "../src/governance/ui/renderer.ts";
import type { GovernanceDashboardDetails } from "../src/governance/ui/renderer.ts";

const ROOT = join(import.meta.dirname, "..");
let GOV_ROOT: string;
function freshRoot() { GOV_ROOT = mkdtempSync(join(tmpdir(), "gov-phase6-")); }

const SEED = `
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.event_store import EventStore
from pipelines.governance.state_reducer import StateReducer
repo = Repository(); store = EventStore(repo); reducer = StateReducer(store)
from pipelines.governance.contracts import sha256_canonical
def evt(seq, etype, run, payload=None):
    return {"eventId": f"evt_{run}_{seq:04d}_{etype.lower()[:10]}", "eventType": etype,
            "pipelineId": "p_1", "pipelineVersion": 1, "runId": run,
            "source": "PIPELINE_GOVERNANCE", "sequenceNumber": seq,
            "occurredAt": f"2026-08-02T00:00:{seq:02d}Z",
            "payloadHash": sha256_canonical(payload or {}), "payloadRef": None,
            "supersedesEventId": None, "payload": payload or {}}
`;

function py(code: string): string {
  return execFileSync("python3", ["-c", SEED + code], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PIPELINE_GOVERNANCE_ROOT: GOV_ROOT },
  }).trim().split("\n").pop()!;
}

describe("governance dashboard + UI channel", () => {
  test("overview reflects real snapshots (single source of truth)", () => {
    freshRoot();
    const out = JSON.parse(py(`
store.append(evt(1, "RUN_CREATED", "run_x"))
store.append(evt(2, "RUN_STARTED", "run_x"))
store.append(evt(3, "FINDING_DETECTED", "run_x", {"findingId": "gf_x1"}))
from pipelines.governance.status_dashboard import StatusDashboard
d = StatusDashboard(reducer)
print(json.dumps({"rows": d.overview(), "modelText": d.model_facing_summary()}))
`));
    const rows = out.rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId, "run_x");
    assert.equal(rows[0].state, "ISSUE_DETECTED");
    assert.equal(rows[0].openFindings, 1);
    // model-facing text: state/refs only, no payload
    assert.ok(out.modelText.includes("ISSUE_DETECTED"));
    assert.ok(!out.modelText.includes("gf_x1"), "finding refs belong in detail, not model text");
  });

  test("UI details payload carries full view, never in model text", () => {
    freshRoot();
    const out = JSON.parse(py(`
store.append(evt(1, "RUN_CREATED", "run_y"))
store.append(evt(2, "FINDING_DETECTED", "run_y", {"findingId": "gf_y1", "evidence": "big numeric payload 918273.645"}))
from pipelines.governance.status_dashboard import StatusDashboard
d = StatusDashboard(reducer)
ui = d.ui_details()
model = d.model_facing_summary()
print(json.dumps({"uiType": ui["dashboardType"], "uiRows": len(ui["rows"]),
                  "modelHasFindingPayload": "918273.645" in model}))
`));
    assert.equal(out.uiType, "PIPELINE_GOVERNANCE");
    assert.equal(out.uiRows, 1);
    // the canary numeric payload from the finding event NEVER enters model text
    assert.equal(out.modelHasFindingPayload, false);
  });

  test("agent context and dashboard use the same snapshot", () => {
    freshRoot();
    const out = JSON.parse(py(`
store.append(evt(1, "RUN_CREATED", "run_z"))
store.append(evt(2, "RUN_STARTED", "run_z"))
from pipelines.governance.status_dashboard import StatusDashboard
from pipelines.governance.agent_worker import build_context_package
d = StatusDashboard(reducer)
snap = d.detail("run_z")["snapshot"]
pkg = build_context_package(snap, ["evt_z_0001"])
print(json.dumps({"dashboardState": snap["state"], "agentState": pkg["currentState"]}))
`));
    assert.equal(out.dashboardState, out.agentState);
  });

  test("governance_dashboard tool: real python projection + model/detail split", async () => {
    freshRoot();
    // seed two runs through the real store
    py(`
store.append(evt(1, "RUN_CREATED", "run_t1"))
store.append(evt(2, "RUN_STARTED", "run_t1"))
store.append(evt(1, "RUN_CREATED", "run_t2"))
store.append(evt(2, "RUN_FAILED", "run_t2"))
`);
    const tool = buildGovernanceStatusTool({ repoRoot: ROOT, governanceRoot: GOV_ROOT });
    assert.equal(tool.name, "governance_dashboard");
    assert.equal(tool.renderShell, "self");
    assert.ok(tool.renderResult, "renderResult must be wired (UI-only channel)");

    const result = await tool.execute("t1", {}, undefined, undefined, {} as never);
    const details = result.details as GovernanceDashboardDetails;
    assert.equal(details.dashboardType, "PIPELINE_GOVERNANCE");
    assert.equal(details.rows.length, 2);
    const byRun = new Map(details.rows.map((r) => [r.runId, r]));
    assert.equal(byRun.get("run_t2")!.state, "FAILED");
    assert.equal(byRun.get("run_t1")!.state, "RUNNING");
    // model content: compact refs only, no full rows/payloads
    assert.ok(result.content.some((c) => c.type === "text" && c.text.includes("state=RUNNING")));
    assert.ok(!result.content.some((c) => c.type === "text" && c.text.includes("dashboardType")));

    // model summary helper is deterministic
    const summary = modelSummaryText(details);
    assert.ok(summary.includes("run=run_t2"));
    assert.ok(!summary.includes("generatedAt"));
  });

  test("renderResult produces a Text component from details", async () => {
    freshRoot();
    py(`store.append(evt(1, "RUN_CREATED", "run_r1"))`);
    const tool = buildGovernanceStatusTool({ repoRoot: ROOT, governanceRoot: GOV_ROOT });
    const result = await tool.execute("t2", {}, undefined, undefined, {} as never);
    const component = (tool.renderResult as any)(
      result,
      { expanded: true, isPartial: false },
      {},
      {},
    );
    assert.ok(component, "renderResult must return a component");
    assert.match(component.content ?? component.text ?? "", /Governance Dashboard/);
  });

  test("feature off => governance_dashboard NOT registered; on => registered", () => {
    const registered = new Set<string>();
    const pi = { registerTool: (t: any) => registered.add(t.name), registerCommand: () => {}, on: () => {} };

    // off: pipeline governance (dashboard parent) explicitly off
    const fOff = createFeatureResolver({ features: { "round2.pipeline_governance": false } });
    buildExtensionRegistrations(pi as never, fOff);
    assert.ok(!registered.has("governance_dashboard"), "must not register when feature is off");

    // on: the dashboard feature effective (its dependency chain is satisfied
    // by the resolver only when the parent + state reducer are also on)
    const fOn = createFeatureResolver({ features: {
      "round2.lakehouse": true,
      "round2.pipeline_governance": true,
      "round2.pipeline_state_reducer": true,
      "round2.pipeline_event_store": true,
      "round2.pipeline_status_dashboard": true,
    } });
    buildExtensionRegistrations(pi as never, fOn);
    assert.ok(registered.has("governance_dashboard"), "must register when feature is on");
  });
});
