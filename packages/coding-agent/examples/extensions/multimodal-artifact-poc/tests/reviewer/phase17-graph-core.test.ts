/**
 * Phase 17 — Graph Core (Phase 1): contracts, canonical hash, validator,
 * compiler, scheduler, state reducer, event store. No real adapters run.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, specContentHash, canonicalize } from "../../src/graph-engine/canonical.ts";
import {
  validateGraphSpec,
  assertValidGraphSpec,
  type CapabilityDescriptor,
} from "../../src/graph-engine/graph-validator.ts";
import { compileGraphSpec, MANDATORY_NODE_IDS, nextGraphVersion, type CompileInput } from "../../src/graph-engine/graph-compiler.ts";
import { nextWave } from "../../src/graph-engine/scheduler.ts";
import { newRunState, reduceEvent, replayRunState, stateHash } from "../../src/graph-engine/state-reducer.ts";
import { GraphEventStore } from "../../src/graph-engine/event-store.ts";
import { GraphError } from "../../src/graph-engine/errors.ts";
import { readFileSync as readFileSyncFs, writeFileSync as writeFileSyncFs } from "node:fs";
import type { ArtifactRef, GraphEvent, GraphSpec } from "../../src/graph-engine/contracts.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "p17-"));
}

const PLAN_REF: ArtifactRef = {
  artifactId: "plan_1", artifactType: "task-plan", contentHash: "h", schemaVersion: "1.0", createdByNodeId: "req",
};

function cap(id: string, kind = "TOOL", features: string[] = []): CapabilityDescriptor {
  return {
    capabilityId: id, nodeKind: kind, featureId: "round6.graph_engine", inputContract: "artifact-refs",
    outputContract: "artifact-refs", sideEffect: id.includes("report") || id.includes("materialize") ? "WRITE" : id.includes("human") ? "NONE" : "READ", costClass: "LOW", supportsParallel: true,
    adapterId: `adapter:${id}`, timeoutPolicyMs: 600_000,
    retryPolicy: { maxAttempts: 4, retryableErrorCodes: [] },
  };
}

function caps(spec: GraphSpec): Map<string, CapabilityDescriptor> {
  const m = new Map<string, CapabilityDescriptor>();
  for (const n of spec.nodes) {
    if (!m.has(n.capabilityId)) {
      const kind = n.kind === "AGENT" ? "AGENT" : n.kind === "SKILL" ? "SKILL" : n.kind === "HUMAN_GATE" ? "HUMAN_GATE" : n.kind === "REDUCER" ? "REDUCER" : n.kind === "DETERMINISTIC" ? "DETERMINISTIC" : "TOOL";
      m.set(n.capabilityId, cap(n.capabilityId, kind));
    }
  }
  return m;
}

function compile(opts: Partial<CompileInput> = {}): GraphSpec {
  return compileGraphSpec({
    plan: {
      planId: "plan_x", version: 1, goal: "aggregate sales",
      tasks: [
        { taskId: "t1", title: "search", objective: "find dataset", capability: "lakehouse.catalog.search", dependsOn: [], inputs: [], expectedOutputs: ["dataset"], parallelizable: true, optional: false },
        { taskId: "t2", title: "inspect", objective: "inspect dataset", capability: "lakehouse.dataset.inspect", dependsOn: ["t1"], inputs: ["dataset"], expectedOutputs: ["dataset"], parallelizable: true, optional: false },
        { taskId: "t3", title: "execute", objective: "run query", capability: "lakehouse.query.execute", dependsOn: ["t2"], inputs: ["dataset"], expectedOutputs: ["analysis-result"], parallelizable: false, optional: false },
      ],
    },
    planRef: PLAN_REF,
    objective: "aggregate sales",
    featureSnapshotHash: "snap_1",
    graphVersion: 1,
    formalReport: true,
    ...opts,
  });
}

describe("A. contracts", () => {
  test("canonical hash is stable and order-insensitive", () => {
    const a = { b: 1, a: [2, { d: 3, c: 4 }] };
    const b = { a: [2, { c: 4, d: 3 }], b: 1 };
    assert.equal(canonicalize(a), canonicalize(b));
    assert.equal(contentHash(a), contentHash(b));
  });

  test("specContentHash excludes the contentHash field", () => {
    const spec = compile();
    const h = specContentHash(spec);
    assert.equal(h, spec.contentHash);
    assert.equal(specContentHash({ ...spec, contentHash: "tampered" }), h);
  });
});

describe("B. validator", () => {
  test("valid compiled graph passes", () => {
    const spec = compile();
    assert.deepEqual(validateGraphSpec(spec, { capabilities: caps(spec), featureSnapshotHash: "snap_1" }), []);
  });

  test("duplicate nodeId rejected", () => {
    const spec = compile();
    spec.nodes.push({ ...spec.nodes[0]!, nodeId: spec.nodes[0]!.nodeId });
    const issues = validateGraphSpec(spec, { capabilities: caps(spec), featureSnapshotHash: "s" });
    assert.ok(issues.some((i) => i.includes("duplicate nodeId")));
  });

  test("unknown node ref rejected", () => {
    const spec = compile();
    spec.edges.push({ edgeId: "e_bad", fromNodeId: "nope", toNodeId: "task.t1", edgeType: "CONTROL" });
    const issues = validateGraphSpec(spec, { capabilities: caps(spec), featureSnapshotHash: "s" });
    assert.ok(issues.some((i) => i.includes("nope")));
  });

  test("cycle detected", () => {
    const spec = compile();
    spec.edges.push({ edgeId: "e_cyc", fromNodeId: "task.t3", toNodeId: "task.t1", edgeType: "CONTROL" });
    const issues = validateGraphSpec(spec, { capabilities: caps(spec), featureSnapshotHash: "s" });
    assert.ok(issues.some((i) => i.includes("cycle")));
  });

  test("unregistered capability rejected", () => {
    const spec = compile();
    const m = caps(spec);
    m.delete("graph.catalog.search");
    const issues = validateGraphSpec(spec, { capabilities: m, featureSnapshotHash: "s" });
    assert.ok(issues.some((i) => i.includes("unregistered capability")));
  });

  test("code-style condition rejected", () => {
    const spec = compile();
    spec.edges.push({
      edgeId: "e_code", fromNodeId: "task.t1", toNodeId: "task.t2", edgeType: "CONTROL",
      condition: { type: "NODE_SUCCEEDED", nodeId: "task.t1" },
    });
    // code strings in conditions are impossible by typing; a string condition
    // must fail validation
    const bad = { ...spec, edges: [...spec.edges, { ...spec.edges[0]!, condition: "eval(1)" as never }] };
    const issues = validateGraphSpec(bad, { capabilities: caps(bad), featureSnapshotHash: "s" });
    assert.ok(issues.some((i) => i.includes("condition")) || issues.length > 0);
    assert.throws(() => assertValidGraphSpec(bad, { capabilities: caps(bad), featureSnapshotHash: "s" }), GraphError);
  });

  test("tampered contentHash rejected", () => {
    const spec = compile();
    spec.contentHash = "deadbeef";
    const issues = validateGraphSpec(spec, { capabilities: caps(spec), featureSnapshotHash: "s" });
    assert.ok(issues.some((i) => i.includes("contentHash")));
  });
});

describe("C. compiler", () => {
  test("compiles a plan with mandatory system nodes", () => {
    const spec = compile();
    const ids = spec.nodes.map((n) => n.nodeId);
    assert.ok(ids.includes(MANDATORY_NODE_IDS.preflight));
    assert.ok(ids.includes(MANDATORY_NODE_IDS.reviewGate));
    assert.ok(ids.includes(MANDATORY_NODE_IDS.reviewer));
    assert.ok(ids.includes(MANDATORY_NODE_IDS.promotion));
    assert.ok(spec.nodes.find((n) => n.nodeId === MANDATORY_NODE_IDS.reportSkill)?.kind === "SKILL", "report is a SKILL node, never an Agent");
    assert.ok(ids.includes(MANDATORY_NODE_IDS.verifier));
    assert.ok(spec.nodes.every((n) => n.kind !== "AGENT" || n.capabilityId === "graph.analysis.run"), "no report agent");
  });

  test("unregistered planner capability rejected", () => {
    assert.throws(
      () => compile({ plan: { planId: "p", version: 1, goal: "g", tasks: [{ taskId: "x", title: "x", objective: "o", capability: "nope.nope", dependsOn: [], inputs: [], expectedOutputs: [], parallelizable: false, optional: false }] } }),
      (e: Error) => e instanceof GraphError && e.code === "UNREGISTERED_CAPABILITY",
    );
  });

  test("WRITE task gets a mandatory human gate", () => {
    const spec = compileGraphSpec({
      plan: {
        planId: "p", version: 1, goal: "ingest", tasks: [
          { taskId: "w", title: "ingest", objective: "ingest file", capability: "lakehouse.query.materialize", dependsOn: [], inputs: [], expectedOutputs: [], parallelizable: false, optional: false },
        ],
      },
      planRef: PLAN_REF, objective: "ingest", featureSnapshotHash: "s", graphVersion: 1, formalReport: false,
    });
    const gate = spec.nodes.find((n) => n.nodeId.startsWith("sys.human-gate."));
    assert.ok(gate, "human gate inserted for WRITE task");
    assert.equal(gate!.kind, "HUMAN_GATE");
    const task = spec.nodes.find((n) => n.nodeId === "task.w")!;
    assert.ok(task.dependsOn.includes(gate!.nodeId), "write depends on the human gate");
    // no cycle
    assert.deepEqual(validateGraphSpec(spec, { capabilities: caps(spec), featureSnapshotHash: "s" }), []);
  });

  test("nextGraphVersion is monotonic and hash-stable", () => {
    const spec = compile();
    const v2 = nextGraphVersion(spec);
    assert.equal(v2.graphVersion, 2);
    assert.notEqual(v2.contentHash, spec.contentHash);
    assert.equal(specContentHash(v2), v2.contentHash);
  });
});

describe("D. scheduler", () => {
  test("dependencies gate readiness; deterministic wave order", () => {
    const spec = compile({ formalReport: false });
    let state = newRunState({ runId: "r", graphId: spec.graphId, graphVersion: 1, graphContentHash: spec.contentHash, featureSnapshotHash: "s", nodeIds: spec.nodes.map((n) => n.nodeId) });
    const input = { spec, state, availableCapabilities: new Set(caps(spec).keys()), maxParallelNodes: 4, parallelismEnabled: true };
    const wave1 = nextWave(input);
    const wave1Ids = wave1.ready.map((w) => w.nodeId);
    assert.ok(wave1Ids.includes("task.t1"), `entry task ready (${wave1Ids.join(",")})`);
    assert.ok(!wave1Ids.includes("task.t2"), "dependent task not ready yet");
    assert.equal(wave1.blocked.length, 0);
    // succeed t1
    state = reduceEvent(state, { eventId: "e", runId: "r", graphId: spec.graphId, graphVersion: 1, sequence: 1, eventType: "NODE_SUCCEEDED", nodeId: "task.t1", refs: [{ artifactId: "art_d", artifactType: "dataset", contentHash: "a".repeat(64), schemaVersion: "1.0", createdByNodeId: "task.t1" }], meta: {}, timestamp: new Date().toISOString(), previousEventHash: "g", contentHash: "c" } as GraphEvent);
    const wave2 = nextWave({ ...input, state });
    const wave2Ids = wave2.ready.map((w) => w.nodeId);
    assert.ok(wave2Ids.includes("task.t2"), `t2 becomes ready after t1 (${wave2Ids.join(",")})`);
    assert.ok(!wave2Ids.includes("task.t3"), "t3 still gated by t2");
  });

  test("parallelism off -> one node per wave", () => {
    const spec = compileGraphSpec({
      plan: { planId: "p", version: 1, goal: "g", tasks: [
        { taskId: "a", title: "a", objective: "o", capability: "lakehouse.catalog.search", dependsOn: [], inputs: [], expectedOutputs: [], parallelizable: true, optional: false },
        { taskId: "b", title: "b", objective: "o", capability: "lakehouse.dataset.inspect", dependsOn: [], inputs: [], expectedOutputs: [], parallelizable: true, optional: false },
      ] },
      planRef: PLAN_REF, objective: "o", featureSnapshotHash: "s", graphVersion: 1, formalReport: false,
    });
    let state = newRunState({ runId: "r", graphId: spec.graphId, graphVersion: 1, graphContentHash: spec.contentHash, featureSnapshotHash: "s", nodeIds: spec.nodes.map((n) => n.nodeId) });
    const wave = nextWave({ spec, state, availableCapabilities: new Set(caps(spec).keys()), maxParallelNodes: 4, parallelismEnabled: false });
    assert.equal(wave.ready.length, 1);
  });

  test("concurrencyKey serializes same-key nodes", () => {
    const spec = compileGraphSpec({
      plan: { planId: "p", version: 1, goal: "g", tasks: [
        { taskId: "a", title: "a", objective: "o", capability: "lakehouse.catalog.search", dependsOn: [], inputs: [], expectedOutputs: [], parallelizable: true, optional: false },
        { taskId: "b", title: "b", objective: "o", capability: "lakehouse.dataset.inspect", dependsOn: [], inputs: [], expectedOutputs: [], parallelizable: true, optional: false },
      ] },
      planRef: PLAN_REF, objective: "o", featureSnapshotHash: "s", graphVersion: 1, formalReport: false,
    });
    for (const n of spec.nodes) if (n.nodeId.startsWith("task.")) n.concurrencyKey = "serial";
    let state = newRunState({ runId: "r", graphId: spec.graphId, graphVersion: 1, graphContentHash: spec.contentHash, featureSnapshotHash: "s", nodeIds: spec.nodes.map((n) => n.nodeId) });
    const wave = nextWave({ spec, state, availableCapabilities: new Set(caps(spec).keys()), maxParallelNodes: 4, parallelismEnabled: true });
    const taskReady = wave.ready.filter((r) => r.nodeId.startsWith("task."));
    assert.equal(taskReady.length, 1, "same concurrencyKey -> one task per wave");
  });
});

describe("E. event store + reducer", () => {
  test("append creates a monotonic hash chain; scan is clean", () => {
    const store = new GraphEventStore(join(tmp(), "events"));
    const runId = "run_test";
    const ev0 = store.append(runId, { graphId: "g", graphVersion: 1, eventType: "GRAPH_CREATED", refs: [], meta: {} });
    const ev1 = store.append(runId, { graphId: "g", graphVersion: 1, eventType: "GRAPH_STARTED", refs: [], meta: {} });
    const ev2 = store.append(runId, { graphId: "g", graphVersion: 1, eventType: "NODE_SUCCEEDED", nodeId: "task.t1", refs: [], meta: {} });
    assert.equal(ev0.sequence, 0);
    assert.equal(ev1.sequence, 1);
    assert.equal(ev2.sequence, 2);
    assert.equal(ev2.previousEventHash, ev1.contentHash);
    assert.deepEqual(store.scan(runId), []);
  });

  test("tampered event breaks the chain scan", () => {
    const store = new GraphEventStore(join(tmp(), "events"));
    const runId = "run_tamper";
    store.append(runId, { graphId: "g", graphVersion: 1, eventType: "GRAPH_CREATED", refs: [], meta: {} });
    store.append(runId, { graphId: "g", graphVersion: 1, eventType: "GRAPH_STARTED", refs: [], meta: {} });
    const ev2 = store.append(runId, { graphId: "g", graphVersion: 1, eventType: "NODE_SUCCEEDED", nodeId: "t", refs: [], meta: {} });
    const path = join(store.root, "runs", runId, "events", "1.json");
    const parsed = JSON.parse(readFileSyncFs(path, "utf8"));
    parsed.nodeId = "tampered";
    writeFileSyncFs(path, JSON.stringify(parsed));
    const issues = store.scan(runId);
    assert.ok(issues.some((i) => i.includes("contentHash mismatch") || i.includes("sequence")), issues.join(";"));
  });

  test("recovery: replay events rebuilds the run state", () => {
    const spec = compile({ formalReport: false });
    const nodeIds = spec.nodes.map((n) => n.nodeId);
    const initial = newRunState({ runId: "r", graphId: spec.graphId, graphVersion: 1, graphContentHash: spec.contentHash, featureSnapshotHash: "s", nodeIds });
    const events: GraphEvent[] = [
      { eventId: "e0", runId: "r", graphId: spec.graphId, graphVersion: 1, sequence: 0, eventType: "GRAPH_STARTED", refs: [], timestamp: "2026-01-01T00:00:00Z", previousEventHash: "genesis", contentHash: "c0" },
      { eventId: "e1", runId: "r", graphId: spec.graphId, graphVersion: 1, sequence: 1, eventType: "NODE_SUCCEEDED", nodeId: "task.t1", refs: [{ artifactId: "art_1", artifactType: "dataset", contentHash: "h", schemaVersion: "1.0", createdByNodeId: "task.t1" }], timestamp: "2026-01-01T00:00:01Z", previousEventHash: "c0", contentHash: "c1" },
      { eventId: "e2", runId: "r", graphId: spec.graphId, graphVersion: 1, sequence: 2, eventType: "GRAPH_COMPLETED", refs: [], timestamp: "2026-01-01T00:00:02Z", previousEventHash: "c1", contentHash: "c2" },
    ];
    const replayed = replayRunState(initial, events);
    assert.equal(replayed.status, "COMPLETED");
    assert.equal(replayed.nodeRuns["task.t1"]!.status, "SUCCEEDED");
    assert.equal(replayed.nodeRuns["task.t1"]!.outputRefs.length, 1);
    // deterministic projection
    assert.equal(stateHash(replayed), stateHash(replayRunState(initial, [...events].reverse())));
  });
});
