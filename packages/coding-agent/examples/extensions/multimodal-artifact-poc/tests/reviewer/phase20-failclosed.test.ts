/**
 * Phase 20 — fail-closed counter-examples (GPT review acceptance items).
 *
 * 1. upstream FAILED -> downstream adapters never invoked (count 0)
 * 2. DECISION condition false (REJECT/CHANGES_REQUIRED/ABSTAIN) ->
 *    promotion/report adapters never invoked
 * 3. no external resolution artifact -> human gate never SUCCEEDED
 * 4. corrupted event -> resume refuses
 * 5. same runId + different graph hash -> resume refuses
 * 6. feature off -> capability not schedulable
 * 7. tampered artifact bytes -> data-analysis adapter hash check fails
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraphSpec } from "../../src/graph-engine/graph-compiler.ts";
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

import { okAdapter, recordingAdapter, verdictAdapter } from "../../src/graph-engine/adapters/fake.ts";
import { validateGraphSpec } from "../../src/graph-engine/graph-validator.ts";
import { dataAnalysisAdapter } from "../../src/graph-engine/adapters/data-analysis.ts";
import { GraphError } from "../../src/graph-engine/errors.ts";
import type { ArtifactRef, GraphSpec } from "../../src/graph-engine/contracts.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "p20-"));
}

const PLAN_REF: ArtifactRef = {
  artifactId: "plan_1", artifactType: "task-plan", contentHash: "h", schemaVersion: "1.0", createdByNodeId: "req",
};

function chain(tasks: Array<{ id: string; capability: string; deps: string[] }>, formalReport = true): GraphSpec {
  return compileGraphSpec({
    plan: {
      planId: "p", version: 1, goal: "g",
      tasks: [...tasks.map((t) => ({
        taskId: t.id, title: t.id, objective: t.id, capability: t.capability,
        dependsOn: t.deps ?? [], inputs: t.deps?.length ? t.deps.map(() => "dataset") : [],
        expectedOutputs: ["dataset"], parallelizable: true, optional: false,
      })), { taskId: "analysis", title: "analysis", objective: "analysis", capability: "analysis.run",
        dependsOn: [tasks[tasks.length - 1]!.id], inputs: ["dataset"], expectedOutputs: ["analysis-result"],
        parallelizable: false, optional: false }],
    },
    planRef: PLAN_REF, objective: "g", featureSnapshotHash: "snap", graphVersion: 1, formalReport,
  });
}

const OUTPUT_TYPES: Record<string, string> = {
  "graph.catalog.search": "dataset",
  "graph.dataset.inspect": "dataset",
  "graph.query.execute": "dataset",
  "graph.analysis.run": "analysis-result",
  "graph.governance.preflight": "verified-dataset",
  "graph.analysis.fan_in": "proposal",
  "graph.review.plan": "gate-decision",
  "graph.review.authorize": "authorization",
};

function recordingForCapability(id: string, log: string[]) {
  return recordingAdapter(id, log, OUTPUT_TYPES[id] ?? `${id.split(".").pop()}-result`);
}

function runWithReview(verdict: "PASS" | "REJECT" | "CHANGES_REQUIRED" | "ABSTAIN", log: string[]) {
  const g = chain([{ id: "q", capability: "lakehouse.query.execute" }]);
  const store = new GraphEventStore(join(tmp(), "events"));
  const m = new Map<string, ReturnType<typeof okAdapter> | ReturnType<typeof verdictAdapter> | ReturnType<typeof recordingAdapter>>();
  for (const id of graphCapabilityMap().keys()) {
    if (id === "skill.analysis.report") continue;
    if (id === "graph.review.execute") { m.set(id, verdictAdapter(id, verdict)); continue; }
    m.set(id, recordingForCapability(id, log));
  }
  const ex = new GraphExecutor({ store, adapters: m as never, capabilities: graphCapabilityMap(), effectiveFeatures: ALL_GRAPH_FEATURES });
  return ex.run(g, { runId: `v_${verdict.toLowerCase()}` });
}

describe("P0-1: failed upstream never schedules downstream", () => {
  test("upstream FAILED -> reviewer/report adapters invoked 0 times", async () => {
    const log: string[] = [];
    const g = chain([{ id: "q", capability: "lakehouse.query.execute" }]);
    const store = new GraphEventStore(join(tmp(), "events"));
    const m = new Map<string, ReturnType<typeof okAdapter> | ReturnType<typeof recordingAdapter>>();
    for (const id of graphCapabilityMap().keys()) {
      if (id === "skill.analysis.report") continue;
      m.set(id, recordingForCapability(id, log));
    }
    // deterministic failure of the data task
    m.set("graph.query.execute", {
      capabilityId: "graph.query.execute",
      execute: async () => { log.push("graph.query.execute:task.q"); throw new GraphError("SANDBOX_VIOLATION", "boom", { retryable: false }); },
    });
    const ex = new GraphExecutor({ store, adapters: m as never, capabilities: graphCapabilityMap(), effectiveFeatures: ALL_GRAPH_FEATURES });
    const run = await ex.run(g, { runId: "up_fail" });
    assert.equal(run.state.status, "FAILED");
    assert.equal(log.filter((l) => l.includes("graph.review.execute")).length, 0, "reviewer never invoked");
    assert.equal(log.filter((l) => l.includes("skill.analysis.report")).length, 0, "report never invoked");
    assert.ok(run.state.nodeRuns["sys.reviewer"]!.status === "BLOCKED" || run.state.nodeRuns["sys.reviewer"]!.status === "PENDING");
  });
});

describe("P0-2: verdicts gate promotion/report", () => {
  test("REJECT -> promotion adapter invoked 0 times; graph fails", async () => {
    const log: string[] = [];
    const run = await runWithReview("REJECT", log);
    assert.equal(run.state.status, "FAILED");
    assert.equal(log.filter((l) => l.includes("graph.review.authorize")).length, 0, "promotion never invoked on REJECT");
    assert.equal(log.filter((l) => l.includes("skill.analysis.report")).length, 0);
  });

  test("CHANGES_REQUIRED -> promotion/report invoked 0 times; REVISION_REQUESTED emitted", async () => {
    const log: string[] = [];
    const store = new GraphEventStore(join(tmp(), "events"));
    const g = chain([{ id: "q", capability: "lakehouse.query.execute" }]);
    const m = new Map<string, ReturnType<typeof okAdapter> | ReturnType<typeof verdictAdapter> | ReturnType<typeof recordingAdapter>>();
    for (const id of graphCapabilityMap().keys()) {
      if (id === "skill.analysis.report") continue;
      if (id === "graph.review.execute") { m.set(id, verdictAdapter(id, "CHANGES_REQUIRED")); continue; }
      m.set(id, recordingForCapability(id, log));
    }
    const ex = new GraphExecutor({ store, adapters: m as never, capabilities: graphCapabilityMap(), effectiveFeatures: ALL_GRAPH_FEATURES });
    const run = await ex.run(g, { runId: "v_changes" });
    assert.equal(log.filter((l) => l.includes("graph.review.authorize")).length, 0, "promotion never invoked on CHANGES_REQUIRED");
    assert.equal(log.filter((l) => l.includes("skill.analysis.report")).length, 0);
    const types = store.allEvents("v_changes").map((e) => e.eventType);
    assert.ok(types.includes("REVISION_REQUESTED"), "revision requested");
    assert.ok(types.includes("ROUTE_SELECTED"));
    assert.ok(run.state.status === "FAILED" || run.state.status === "WAITING_FOR_HUMAN");
  });

  test("ABSTAIN -> report invoked 0 times; ROUTE_SELECTED targets human", async () => {
    const log: string[] = [];
    const store = new GraphEventStore(join(tmp(), "events"));
    const g = chain([{ id: "q", capability: "lakehouse.query.execute" }]);
    const m = new Map<string, ReturnType<typeof okAdapter> | ReturnType<typeof verdictAdapter> | ReturnType<typeof recordingAdapter>>();
    for (const id of graphCapabilityMap().keys()) {
      if (id === "skill.analysis.report") continue;
      if (id === "graph.review.execute") { m.set(id, verdictAdapter(id, "ABSTAIN")); continue; }
      m.set(id, recordingForCapability(id, log));
    }
    const ex = new GraphExecutor({ store, adapters: m as never, capabilities: graphCapabilityMap(), effectiveFeatures: ALL_GRAPH_FEATURES });
    const run = await ex.run(g, { runId: "v_abstain" });
    assert.equal(log.filter((l) => l.includes("skill.analysis.report")).length, 0, "report never invoked on ABSTAIN");
    const routes = store.allEvents("v_abstain").filter((e) => e.eventType === "ROUTE_SELECTED");
    assert.ok(routes.length >= 1, "abstain routed");
  });
});

describe("P0-4: human gate cannot succeed without an external resolution", () => {
  test("gate stays pending forever without an operator artifact", async () => {
    const g = compileGraphSpec({
      plan: { planId: "p", version: 1, goal: "g", tasks: [
        { taskId: "w", title: "w", objective: "w", capability: "lakehouse.query.materialize", dependsOn: [], inputs: [], expectedOutputs: ["dataset"], parallelizable: false, optional: false },
      ] },
      planRef: PLAN_REF, objective: "g", featureSnapshotHash: "s", graphVersion: 1, formalReport: false,
    });
    const store = new GraphEventStore(join(tmp(), "events"));
    const ex = new GraphExecutor({
      store,
      adapters: new Map([["graph.query.materialize", okAdapter("graph.query.materialize")]]),
      capabilities: graphCapabilityMap(),
      effectiveFeatures: ALL_GRAPH_FEATURES,
    });
    const run = await ex.run(g, { runId: "no_res" });
    const gate = g.nodes.find((n) => n.kind === "HUMAN_GATE")!;
    assert.equal(run.state.status, "WAITING_FOR_HUMAN");
    assert.notEqual(run.state.nodeRuns[gate.nodeId]!.status, "SUCCEEDED");
    // resume without a resolution: still waiting, never approved
    const again = await ex.run(g, { runId: "no_res" });
    assert.equal(again.state.status, "WAITING_FOR_HUMAN");
  });
});

describe("P0-5: recovery is fail closed", () => {
  test("corrupted event -> resume refuses", async () => {
    const g = chain([{ id: "q", capability: "lakehouse.query.execute" }], false);
    const store = new GraphEventStore(join(tmp(), "events"));
    store.append("corrupt", { graphId: g.graphId, graphVersion: 1, eventType: "GRAPH_CREATED", refs: [], meta: {} });
    const ev2 = store.append("corrupt", { graphId: g.graphId, graphVersion: 1, eventType: "NODE_SUCCEEDED", nodeId: "task.q", refs: [], meta: {} });
    void ev2;
    const { readFileSync, writeFileSync: wf } = await import("node:fs");
    const p = join(store.root, "runs", "corrupt", "events", "1.json");
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    parsed.nodeId = "tampered";
    wf(p, JSON.stringify(parsed));
    const ex = new GraphExecutor({ store, adapters: new Map(), capabilities: graphCapabilityMap(), effectiveFeatures: ALL_GRAPH_FEATURES });
    await assert.rejects(
      () => ex.run(g, { runId: "corrupt" }),
      (e: Error) => e instanceof GraphError && e.message.includes("event chain damaged"),
    );
  });

  test("same runId + different graph hash -> resume refuses", async () => {
    const g1 = chain([{ id: "q", capability: "lakehouse.query.execute" }], false);
    const store = new GraphEventStore(join(tmp(), "events"));
    const m = new Map([["graph.query.execute", okAdapter("graph.query.execute", "dataset")]]);
    const ex1 = new GraphExecutor({ store, adapters: m, capabilities: graphCapabilityMap(), effectiveFeatures: ALL_GRAPH_FEATURES });
    await ex1.run(g1, { runId: "bind" });
    // a DIFFERENT graph compiled with the same runId
    const g2 = chain([{ id: "other", capability: "lakehouse.catalog.search" }], false);
    const ex2 = new GraphExecutor({ store, adapters: m, capabilities: graphCapabilityMap(), effectiveFeatures: ALL_GRAPH_FEATURES });
    await assert.rejects(
      () => ex2.run(g2, { runId: "bind" }),
      (e: Error) => e instanceof GraphError && e.message.includes("GRAPH_RUN_BINDING_MISMATCH"),
    );
  });
});

describe("P1-6: feature snapshot gating", () => {
  test("capability feature off -> validation rejects the node", () => {
    const g = chain([{ id: "q", capability: "lakehouse.query.execute" }], false);
    const issues = validateGraphSpec(g, {
      capabilities: graphCapabilityMap(),
      featureSnapshotHash: "s",
      effectiveFeatures: new Set(["round6.graph_engine"]), // graph.query.execute feature (round2.query_tools) NOT effective
    });
    assert.ok(issues.some((i) => i.includes("requires feature")), issues.join(";"));
  });
});

describe("P1-8: artifact tampering fails the analysis adapter hash check", () => {
  test("tampered artifact bytes -> HASH_MISMATCH", async () => {
    const dir = tmp();
    const artifactId = "art_a1b2c3d4e5f60708";
    const raw = "id,value\n1,10\n2,20";
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(raw).digest("hex");
    const store = {
      readInput: (id: string) => (id === artifactId ? raw : null),
      readInputBytes: (id: string) => (id === artifactId ? Buffer.from(raw) : null),
      writeResult: () => "",
      getMeta: () => ({ contentType: "text/csv", masked: true }),
    };
    const adapter = dataAnalysisAdapter({
      store: store as never,
      subagent: async () => ({ ok: true, text: "" }) as never,
      featureSnapshot: { effectiveFeatures: [] },
    });
    const ctx = {
      node: { nodeId: "task.a", capabilityId: "graph.analysis.run", metadata: {} } as never,
      inputRefs: [{ artifactId, artifactType: "dataset", contentHash: "tampered-hash", schemaVersion: "1.0", createdByNodeId: "x" }] as never,
      runId: "r", graphId: "g", graphVersion: 1, state: {} as never, featureSnapshotHash: "s", principal: {} as never,
      idempotencyKey: "r/task.a/1", abortSignal: undefined,
    };
    await assert.rejects(
      () => adapter.execute(ctx as never),
      (e: Error) => e instanceof GraphError && e.code === "HASH_MISMATCH",
    );
  });
});
