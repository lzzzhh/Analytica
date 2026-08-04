/**
 * Phase 18 — Graph Executor (Phase 2 core): happy path, failures, bounded
 * retries, idempotency, recovery, human gates, event chain integrity.
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

import { failAdapter, flakyAdapter, okAdapter, recordingAdapter, recordingVerdictAdapter, verdictAdapter } from "../../src/graph-engine/adapters/fake.ts";
import { stateHash } from "../../src/graph-engine/state-reducer.ts";
import type { ArtifactRef, GraphSpec } from "../../src/graph-engine/contracts.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "p18-"));
}

const PLAN_REF: ArtifactRef = {
  artifactId: "plan_1", artifactType: "task-plan", contentHash: "h", schemaVersion: "1.0", createdByNodeId: "req",
};

function spec(tasks: Array<{ id: string; capability: string; deps: string[]; parallel?: boolean }>, formalReport = true): GraphSpec {
  return compileGraphSpec({
    plan: {
      planId: "plan_x", version: 1, goal: "g",
      tasks: [...tasks.map((t) => ({
        taskId: t.id, title: t.id, objective: t.id, capability: t.capability,
        dependsOn: t.deps ?? [], inputs: t.deps?.length ? t.deps.map(() => "dataset") : [], expectedOutputs: ["dataset"], parallelizable: t.parallel ?? true, optional: false,
      })), { taskId: "analysis", title: "analysis", objective: "analysis", capability: "analysis.run",
        dependsOn: [tasks[tasks.length - 1]!.id], inputs: ["dataset"], expectedOutputs: ["analysis-result"],
        parallelizable: false, optional: false }],
    },
    planRef: PLAN_REF, objective: "g", featureSnapshotHash: "snap_1", graphVersion: 1, formalReport,
  });
}

function executorWith(adapters: Record<string, ReturnType<typeof okAdapter>>) {
  const store = new GraphEventStore(join(tmp(), "events"));
  const caps = graphCapabilityMap();
  const ex = new GraphExecutor({
    store,
    adapters: new Map(Object.entries(adapters)),
    capabilities: caps,
    effectiveFeatures: ALL_GRAPH_FEATURES,
  });
  return { store, ex };
}

describe("executor happy path", () => {
  test("full chain with report completes; events are clean and hash-chained", async () => {
    const g = spec([
      { id: "t1", capability: "lakehouse.catalog.search" },
      { id: "t2", capability: "lakehouse.dataset.inspect", deps: ["t1"] },
      { id: "t3", capability: "lakehouse.query.execute", deps: ["t2"] },
    ]);
    const { store, ex } = executorWith({
      "graph.catalog.search": okAdapter("graph.catalog.search", "dataset"),
      "graph.dataset.inspect": okAdapter("graph.dataset.inspect", "dataset"),
      "graph.query.execute": okAdapter("graph.query.execute", "dataset"),
      "graph.analysis.run": okAdapter("graph.analysis.run", "analysis-result"),
      "graph.governance.preflight": okAdapter("graph.governance.preflight", "verified-dataset"),
      "graph.analysis.fan_in": okAdapter("graph.analysis.fan_in", "proposal"),
      "graph.review.plan": okAdapter("graph.review.plan", "gate-decision"),
      "graph.review.execute": verdictAdapter("graph.review.execute", "PASS"),
      "graph.review.authorize": okAdapter("graph.review.authorize", "authorization"),
      "skill.analysis.report": okAdapter("skill.analysis.report", "report"),
      "graph.deliverable.verify": okAdapter("graph.deliverable.verify", "verification"),
    });
    const run = await ex.run(g, { runId: "run_happy" });
    if (run.state.status !== "COMPLETED") {
      for (const [id, n] of Object.entries(run.state.nodeRuns)) console.log("[dbg] ", id, n.status, n.errorCode ?? "");
      console.log("[dbg] events:", store.allEvents("run_happy").map((e) => e.eventType + (e.nodeId ? ":" + e.nodeId : "") + (e.errorCode ? "(" + e.errorCode + ")" : "")).join(" "));
    }
    assert.equal(run.state.status, "COMPLETED");
    assert.equal(run.state.nodeRuns["task.t3"]!.status, "SUCCEEDED");
    assert.equal(run.state.nodeRuns[MANDATORY_NODE_IDS.verifier]!.status, "SUCCEEDED");
    assert.deepEqual(store.scan("run_happy"), [], "event chain intact");
    // events never carry raw data keys
    for (const ev of store.allEvents("run_happy")) {
      assert.ok(!JSON.stringify(ev).includes("rawData"));
    }
  });
});

describe("executor failures", () => {
  test("non-retryable failure fails the graph (never claims success)", async () => {
    const g = spec([{ id: "t1", capability: "lakehouse.catalog.search" }], false);
    const { store, ex } = executorWith({
      "graph.catalog.search": failAdapter("graph.catalog.search", "SANDBOX_VIOLATION"),
      "graph.governance.preflight": okAdapter("graph.governance.preflight", "verified-dataset"),
      "graph.analysis.fan_in": okAdapter("graph.analysis.fan_in", "proposal"),
      "graph.review.plan": okAdapter("graph.review.plan", "gate-decision"),
      "graph.review.execute": verdictAdapter("graph.review.execute", "PASS"),
      "graph.review.authorize": okAdapter("graph.review.authorize", "authorization"),
    });
    const run = await ex.run(g, { runId: "run_fail" });
    assert.equal(run.state.status, "FAILED");
    assert.equal(run.state.nodeRuns["task.t1"]!.status, "FAILED");
    assert.equal(run.state.nodeRuns["task.t1"]!.errorCode, "SANDBOX_VIOLATION");
    const last = store.lastEvent("run_fail")!;
    assert.equal(last.eventType, "GRAPH_FAILED");
  });

  test("bounded retry: transient failure retried then succeeds", async () => {
    const g = spec([{ id: "t1", capability: "lakehouse.catalog.search" }], false);
    const { ex } = executorWith({
      "graph.catalog.search": flakyAdapter("graph.catalog.search", 1),
      "graph.governance.preflight": okAdapter("graph.governance.preflight", "verified-dataset"),
      "graph.analysis.fan_in": okAdapter("graph.analysis.fan_in", "proposal"),
      "graph.review.plan": okAdapter("graph.review.plan", "gate-decision"),
      "graph.review.execute": verdictAdapter("graph.review.execute", "PASS"),
      "graph.review.authorize": okAdapter("graph.review.authorize", "authorization"),
    });
    const run = await ex.run(g, { runId: "run_retry" });
    assert.equal(run.state.nodeRuns["task.t1"]!.status, "SUCCEEDED");
    assert.equal(run.state.nodeRuns["task.t1"]!.attempt, 2);
  });
});

describe("executor idempotency + recovery", () => {
  test("resume skips succeeded nodes and completes without rerunning them", async () => {
    const g = spec([
      { id: "t1", capability: "lakehouse.catalog.search" },
      { id: "t2", capability: "lakehouse.dataset.inspect", deps: ["t1"] },
      { id: "t3", capability: "lakehouse.query.execute", deps: ["t2"] },
    ], false);
    const log: string[] = [];
    const store = new GraphEventStore(join(tmp(), "events"));
    const caps = graphCapabilityMap();
    const adapters = new Map<string, ReturnType<typeof recordingAdapter>>([
      ["graph.catalog.search", recordingAdapter("graph.catalog.search", log)],
      ["graph.dataset.inspect", recordingAdapter("graph.dataset.inspect", log)],
      ["graph.query.execute", recordingAdapter("graph.query.execute", log)],
      ["graph.analysis.run", recordingAdapter("graph.analysis.run", log, "analysis-result")],
      ["graph.governance.preflight", recordingAdapter("graph.governance.preflight", log, "verified-dataset")],
      ["graph.analysis.fan_in", recordingAdapter("graph.analysis.fan_in", log, "proposal")],
      ["graph.review.plan", recordingAdapter("graph.review.plan", log, "gate-decision")],
      ["graph.review.execute", recordingVerdictAdapter("graph.review.execute", log)],
      ["graph.review.authorize", recordingAdapter("graph.review.authorize", log, "authorization")],
    ]);
    const ex1 = new GraphExecutor({ store, adapters, capabilities: caps, maxParallelNodes: 1, effectiveFeatures: ALL_GRAPH_FEATURES });
    await ex1.run(g, { runId: "run_rec" });
    const firstLog = [...log];
    // second run on the SAME store: terminal already, no reruns
    const ex2 = new GraphExecutor({ store, adapters, capabilities: caps, effectiveFeatures: ALL_GRAPH_FEATURES });
    const run2 = await ex2.run(g, { runId: "run_rec" });
    assert.equal(run2.state.status, "COMPLETED");
    assert.equal(log.length, firstLog.length, "no node rerun on resume");
  });

  test("succeeded nodes are not re-executed after a crash-like partial run", async () => {
    const g = spec([
      { id: "t1", capability: "lakehouse.catalog.search" },
      { id: "t2", capability: "lakehouse.dataset.inspect", deps: ["t1"] },
    ], false);
    const log: string[] = [];
    const store = new GraphEventStore(join(tmp(), "events"));
    const caps = graphCapabilityMap();
    const adapters = new Map<string, ReturnType<typeof recordingAdapter>>([
      ["graph.catalog.search", recordingAdapter("graph.catalog.search", log)],
      ["graph.dataset.inspect", recordingAdapter("graph.dataset.inspect", log)],
      ["graph.analysis.run", recordingAdapter("graph.analysis.run", log, "analysis-result")],
      ["graph.governance.preflight", recordingAdapter("graph.governance.preflight", log, "verified-dataset")],
      ["graph.analysis.fan_in", recordingAdapter("graph.analysis.fan_in", log, "proposal")],
      ["graph.review.plan", recordingAdapter("graph.review.plan", log, "gate-decision")],
      ["graph.review.execute", recordingVerdictAdapter("graph.review.execute", log)],
      ["graph.review.authorize", recordingAdapter("graph.review.authorize", log, "authorization")],
    ]);
    // simulate a crash after t1 succeeded: append events manually (genesis first)
    const ev1 = store.append("run_crash", { graphId: g.graphId, graphVersion: 1, eventType: "GRAPH_CREATED",
      refs: [{ artifactId: g.graphId, artifactType: "graph-spec", contentHash: g.contentHash, schemaVersion: "1.0", createdByNodeId: "compiler" }],
      meta: { graphContentHash: g.contentHash, featureSnapshotHash: "snap_1" } });
    store.append("run_crash", { graphId: g.graphId, graphVersion: 1, eventType: "GRAPH_STARTED", refs: [], meta: {} });
    store.append("run_crash", { graphId: g.graphId, graphVersion: 1, eventType: "NODE_SUCCEEDED", nodeId: "task.t1", refs: [{ artifactId: "art_a", artifactType: "dataset", contentHash: "b".repeat(64), schemaVersion: "1.0", createdByNodeId: "task.t1" }], meta: {} });
    void ev1;
    const ex = new GraphExecutor({ store, adapters, capabilities: caps, effectiveFeatures: ALL_GRAPH_FEATURES });
    const run = await ex.run(g, { runId: "run_crash" });
    if (run.state.status !== "COMPLETED") {
      for (const [id, n] of Object.entries(run.state.nodeRuns)) console.log("[dbg] ", id, n.status, n.errorCode ?? "");
      console.log("[dbg] events:", store.allEvents("run_crash").map((e) => e.eventType + (e.nodeId ? ":" + e.nodeId : "") + (e.errorCode ? "(" + e.errorCode + ")" : "")).join(" "));
    }
    assert.equal(run.state.status, "COMPLETED");
    assert.equal(log.filter((l) => l.includes("graph.catalog.search")).length, 0, "t1 NOT rerun after crash");
    assert.equal(log.filter((l) => l.includes("graph.dataset.inspect")).length, 1, "t2 ran once");
  });
});

describe("executor human gate", () => {
  test("WRITE task waits; external operator resolution lets the run proceed", async () => {
    const g = compileGraphSpec({
      plan: {
        planId: "p", version: 1, goal: "ingest", tasks: [
          { taskId: "w", title: "ingest", objective: "ingest", capability: "lakehouse.query.materialize", dependsOn: [], inputs: [], expectedOutputs: [], parallelizable: false, optional: false },
        ],
      },
      planRef: PLAN_REF, objective: "ingest", featureSnapshotHash: "s", graphVersion: 1, formalReport: false,
    });
    const store = new GraphEventStore(join(tmp(), "events"));
    const caps = graphCapabilityMap();
    const ex = new GraphExecutor({
      store,
      adapters: new Map([["graph.query.materialize", okAdapter("graph.query.materialize", "artifact")]]),
      capabilities: caps,
      effectiveFeatures: ALL_GRAPH_FEATURES,
    });
    const run = await ex.run(g, { runId: "run_human" });
    const gate = g.nodes.find((n) => n.kind === "HUMAN_GATE")!;
    // the executor NEVER approves: the run waits for the operator
    assert.equal(run.state.status, "WAITING_FOR_HUMAN");
    // the gate STARTED (in-flight) but never completed without an operator
    assert.ok(["PENDING", "RUNNING"].includes(run.state.nodeRuns[gate.nodeId]!.status));
    assert.equal(run.state.nodeRuns["task.w"]!.status, "PENDING");
    // an EXTERNAL trusted principal submits the resolution artifact
    const { recordHumanResolution } = await import("../../src/graph-engine/executor.ts");
    recordHumanResolution(store, {
      actionRef: run.state.pendingHumanActions[0]!.actionRef,
      resolution: "APPROVED",
      action: "APPROVE_EXECUTION",
      allowedActions: [],
      originalReviewId: "",
      gateDecisionId: "",
      policySnapshotHash: "",
      actorId: "operator-1",
      principal: { source: "OPERATOR_CLI", actorId: "operator-1", authenticated: true },
      reason: "manual approval",
      timestamp: new Date().toISOString(),
      graphId: g.graphId,
      graphVersion: g.graphVersion,
    });
    // resume: the approved gate lets the write proceed
    const resumed = await ex.run(g, { runId: "run_human" });
    assert.equal(resumed.state.nodeRuns[gate.nodeId]!.status, "SUCCEEDED");
    assert.equal(resumed.state.nodeRuns["task.w"]!.status, "SUCCEEDED");
    const types = store.allEvents("run_human").map((e) => e.eventType);
    assert.ok(types.includes("HUMAN_ACTION_REQUIRED"));
    assert.ok(types.includes("HUMAN_ACTION_RECORDED"));
  });

  test("without a resolver the run waits for human (never self-approves)", async () => {
    const g = compileGraphSpec({
      plan: {
        planId: "p", version: 1, goal: "ingest", tasks: [
          { taskId: "w", title: "ingest", objective: "ingest", capability: "lakehouse.query.materialize", dependsOn: [], inputs: [], expectedOutputs: [], parallelizable: false, optional: false },
        ],
      },
      planRef: PLAN_REF, objective: "ingest", featureSnapshotHash: "s", graphVersion: 1, formalReport: false,
    });
    const store = new GraphEventStore(join(tmp(), "events"));
    const ex = new GraphExecutor({
      store,
      adapters: new Map([["graph.query.materialize", okAdapter("graph.query.materialize", "artifact")]]),
      capabilities: graphCapabilityMap(),
      effectiveFeatures: ALL_GRAPH_FEATURES,
    });
    const run = await ex.run(g, { runId: "run_wait" });
    assert.equal(run.state.status, "WAITING_FOR_HUMAN");
    assert.equal(run.state.pendingHumanActions.length, 1);
    // the WRITE node must NOT have executed
    assert.equal(run.state.nodeRuns["task.w"]!.status, "PENDING");
  });
});

describe("executor determinism", () => {
  test("same graph + state -> same projection hash", async () => {
    const g = spec([{ id: "t1", capability: "lakehouse.catalog.search" }], false);
    const runA = await executorWith({
      "graph.catalog.search": okAdapter("graph.catalog.search", "dataset"),
      "graph.governance.preflight": okAdapter("graph.governance.preflight", "verified-dataset"),
      "graph.analysis.fan_in": okAdapter("graph.analysis.fan_in", "proposal"),
      "graph.review.plan": okAdapter("graph.review.plan"),
      "graph.review.execute": okAdapter("graph.review.execute"),
      "graph.review.authorize": okAdapter("graph.review.authorize"),
    }).ex.run(g, { runId: "run_det_a" });
    const runB = await executorWith({
      "graph.catalog.search": okAdapter("graph.catalog.search", "dataset"),
      "graph.governance.preflight": okAdapter("graph.governance.preflight", "verified-dataset"),
      "graph.analysis.fan_in": okAdapter("graph.analysis.fan_in", "proposal"),
      "graph.review.plan": okAdapter("graph.review.plan"),
      "graph.review.execute": okAdapter("graph.review.execute"),
      "graph.review.authorize": okAdapter("graph.review.authorize"),
    }).ex.run(g, { runId: "run_det_b" });
    assert.equal(stateHash(runA.state), stateHash(runB.state));
  });
});
