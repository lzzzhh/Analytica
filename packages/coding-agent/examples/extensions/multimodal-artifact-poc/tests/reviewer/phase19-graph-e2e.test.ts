/**
 * Phase 19 — Graph Engine E2E (no real model/tool calls; deterministic
 * adapters): happy path, CHANGES_REQUIRED feedback routing, REJECT stop,
 * ABSTAIN -> human gate, feature-off tool registration.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraphSpec, MANDATORY_NODE_IDS } from "../../src/graph-engine/graph-compiler.ts";
import { GraphExecutor } from "../../src/graph-engine/executor.ts";
import { GraphEventStore } from "../../src/graph-engine/event-store.ts";
import { graphCapabilityMap } from "../../src/graph-engine/capability-registry.ts";

const ALL_GRAPH_FEATURES = new Set([
  "round6.graph_engine", "round6.graph_compiler", "round6.graph_validation",
  "round6.graph_executor", "round6.graph_scheduler", "round6.graph_event_store",
  "round6.graph_state_reducer", "round6.graph_artifact_edges",
  "round6.graph_feedback_routing", "round6.graph_review_integration",
  "round6.graph_skill_nodes", "round6.graph_human_gates",
  "round6.graph_observability", "round6.graph_frontend_render", "round6.graph_tool",
  "round2.catalog_tools", "round2.query_tools", "round4.data_analysis",
  "round4.analysis_input_materialization", "round2.data_quality", "round2.lineage",
  "round2.snapshot", "round4.requirement_planning", "round5.reviewer",
  "round2.pipeline_governance",
]);

import { okAdapter, verdictAdapter } from "../../src/graph-engine/adapters/fake.ts";
import { routeFeedback } from "../../src/graph-engine/router.ts";
import { createFeatureResolver } from "../../src/features/resolver.ts";
import type { ArtifactRef, GraphSpec } from "../../src/graph-engine/contracts.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "p19-"));
}

const PLAN_REF: ArtifactRef = {
  artifactId: "plan_1", artifactType: "task-plan", contentHash: "h", schemaVersion: "1.0", createdByNodeId: "req",
};

function standardAdapters() {
  const m = new Map<string, ReturnType<typeof okAdapter> | ReturnType<typeof verdictAdapter>>();
  for (const id of graphCapabilityMap().keys()) {
    if (id === "skill.analysis.report") continue;
    if (id === "graph.review.execute") {
      m.set(id, verdictAdapter(id, "PASS"));
      continue;
    }
    const out = id === "graph.analysis.run" ? "analysis-result"
      : id === "graph.governance.preflight" ? "verified-dataset"
      : id === "graph.analysis.fan_in" ? "proposal"
      : id === "graph.review.plan" ? "gate-decision"
      : id === "graph.review.authorize" ? "authorization"
      : id === "graph.query.execute" || id === "graph.catalog.search" || id === "graph.dataset.inspect" ? "dataset"
      : `${id.split(".").pop()}-result`;
    m.set(id, okAdapter(id, out));
  }
  return m;
}

function chainSpec(tasks: Array<{ id: string; capability: string; deps: string[] }>, formalReport = false): GraphSpec {
  return compileGraphSpec({
    plan: {
      planId: "plan_x", version: 1, goal: "g",
      tasks: [...tasks.map((t) => ({
        taskId: t.id, title: t.id, objective: t.id, capability: t.capability,
        dependsOn: t.deps ?? [], inputs: t.deps?.length ? t.deps.map(() => "dataset") : [], expectedOutputs: ["dataset"], parallelizable: true, optional: false,
      })), { taskId: "analysis", title: "analysis", objective: "analysis", capability: "analysis.run",
        dependsOn: [tasks[tasks.length - 1]!.id], inputs: ["dataset"], expectedOutputs: ["analysis-result"],
        parallelizable: false, optional: false }],
    },
    planRef: PLAN_REF, objective: "g", featureSnapshotHash: "snap", graphVersion: 1, formalReport,
  });
}

describe("E2E happy path", () => {
  test("requirement -> query -> analysis -> reviewer -> authorization completes", async () => {
    const g = chainSpec([
      { id: "q", capability: "lakehouse.query.execute" },
    ]);
    const store = new GraphEventStore(join(tmp(), "events"));
    const ex = new GraphExecutor({ store, adapters: standardAdapters(), capabilities: graphCapabilityMap(), effectiveFeatures: ALL_GRAPH_FEATURES });
    const run = await ex.run(g, { runId: "e2e_ok" });
    assert.equal(run.state.status, "COMPLETED");
    assert.equal(run.state.nodeRuns[MANDATORY_NODE_IDS.promotion]!.status, "SUCCEEDED");
    assert.equal(run.state.nodeRuns[MANDATORY_NODE_IDS.reviewer]!.status, "SUCCEEDED");
  });
});

describe("feedback routing", () => {
  test("CHANGES_REQUIRED with METHOD code routes to DATA_ANALYSIS and consumes a revision", () => {
    const d = routeFeedback("CHANGES_REQUIRED", ["METHOD", "SCRIPT"]);
    assert.equal(d.target, "DATA_ANALYSIS");
    assert.equal(d.consumesRevisionCycle, true);
  });

  test("CHANGES_REQUIRED with QUALITY code routes to PREFLIGHT", () => {
    assert.equal(routeFeedback("CHANGES_REQUIRED", ["QUALITY"]).target, "PREFLIGHT");
  });

  test("CHANGES_REQUIRED with REPORT_QA routes to REPORT_SKILL", () => {
    assert.equal(routeFeedback("CHANGES_REQUIRED", ["REPORT_QA"]).target, "REPORT_SKILL");
  });

  test("REJECT never enters an automatic revision", () => {
    const d = routeFeedback("REJECT", ["POLICY"]);
    assert.equal(d.target, null);
    assert.equal(d.consumesRevisionCycle, false);
  });

  test("ABSTAIN with budget code routes to HUMAN_GATE", () => {
    const d = routeFeedback("ABSTAIN", ["BUDGET"]);
    assert.equal(d.target, "HUMAN_GATE");
    assert.equal(d.consumesRevisionCycle, false);
  });

  test("PASS routes nowhere", () => {
    const d = routeFeedback("PASS", []);
    assert.equal(d.target, null);
  });
});

describe("reviewer verdict mapping", () => {
  test("graph never fabricates a PASS: failing review node fails the graph", async () => {
    const g = chainSpec([{ id: "q", capability: "lakehouse.query.execute" }], true);
    const store = new GraphEventStore(join(tmp(), "events"));
    const adapters = standardAdapters();
    // reviewer returns REJECT -> the DECISION edge blocks promotion/report
    adapters.set("graph.review.execute", verdictAdapter("graph.review.execute", "REJECT"));
    const ex = new GraphExecutor({ store, adapters, capabilities: graphCapabilityMap(), effectiveFeatures: ALL_GRAPH_FEATURES });
    const run = await ex.run(g, { runId: "e2e_review" });
    assert.equal(run.state.status, "FAILED");
    assert.equal(run.state.nodeRuns["sys.promotion-auth"]!.status, "BLOCKED");
    assert.ok(["PENDING", "BLOCKED", "SKIPPED"].includes(run.state.nodeRuns["sys.analysis-report"]!.status), "report never runs on REJECT");
    assert.deepEqual(store.scan("e2e_review"), []);
  });
});

describe("feature gating (round6.graph_tool)", () => {
  test("enabled -> tools registered; disabled -> not registered", async () => {
    const { buildExtensionRegistrations } = await import("../../index.ts");
    const on: string[] = [];
    const piOn = { registerTool: (t: { name: string }) => { on.push(t.name); }, registerCommand: () => {}, on: () => {} } as never;
    buildExtensionRegistrations(piOn as never, createFeatureResolver({ runtimeProfile: "all-enabled" }));
    assert.ok(on.includes("run_analysis_graph"), `registered: ${on.join(",")}`);
    assert.ok(on.includes("inspect_graph_run"));

    const off: string[] = [];
    const piOff = { registerTool: (t: { name: string }) => { off.push(t.name); }, registerCommand: () => {}, on: () => {} } as never;
    buildExtensionRegistrations(piOff as never, createFeatureResolver({}));
    assert.ok(!off.includes("run_analysis_graph"), "graph tool must not register on the default runtime");
  });
});
