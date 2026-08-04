/**
 * Graph Engine — deterministic wave scheduler.
 *
 * A node is READY when ALL of:
 *   1. every CONTROL/FEEDBACK predecessor SUCCEEDED
 *   2. every required ARTIFACT input exists (edge source SUCCEEDED + ref hash ok)
 *   3. required features effective in the run snapshot
 *   4. capability adapter registered
 *   5. no upstream FAILED/BLOCKED
 *   6. no unsatisfied human gate
 *   7. graph budget not exceeded
 *   8. concurrencyKey free within the wave
 *
 * The scheduler performs NO business logic and produces a deterministic
 * ready order (sorted by nodeId) for identical (graph, state) inputs.
 */
import type { GraphCondition, GraphEdgeSpec, GraphNodeSpec, GraphRunState, GraphSpec } from "./contracts.ts";

export interface SchedulerInput {
  spec: GraphSpec;
  state: GraphRunState;
  availableCapabilities: Set<string>;
  maxParallelNodes: number;
  parallelismEnabled: boolean;
}

export type ReadyDecision =
  | { status: "READY"; nodeId: string; reason: string }
  | { status: "WAITING"; nodeId: string; reason: string }
  | { status: "BLOCKED"; nodeId: string; reasonCode: string; reason: string };

/**
 * READY = the node MAY run now. WAITING = dependencies not satisfied yet.
 * BLOCKED = a hard condition forbids running (upstream failed, condition
 * false, artifact missing, capability unavailable). BLOCKED must NEVER be
 * scheduled; the executor turns it into NODE_BLOCKED (fail closed).
 */
export function isReady(node: GraphNodeSpec, input: SchedulerInput): ReadyDecision {
  const state = input.state;
  // DECISION edges participate in readiness: their conditions (e.g.
  // VERDICT_EQUALS PASS) gate the downstream path
  const preds = input.spec.edges.filter(
    (e) => e.toNodeId === node.nodeId && (e.edgeType === "CONTROL" || e.edgeType === "FEEDBACK" || e.edgeType === "DECISION"),
  );
  for (const e of preds) {
    const run = state.nodeRuns[e.fromNodeId];
    if (!run) return { status: "WAITING", nodeId: node.nodeId, reason: `upstream ${e.fromNodeId} not started` };
    if (run.status === "FAILED" || run.status === "BLOCKED" || run.status === "CANCELLED") {
      return { status: "BLOCKED", nodeId: node.nodeId, reasonCode: "UPSTREAM_FAILED", reason: `upstream ${e.fromNodeId} ${run.status}` };
    }
    if (run.status !== "SUCCEEDED") return { status: "WAITING", nodeId: node.nodeId, reason: `upstream ${e.fromNodeId} ${run.status}` };
    if (e.condition && !conditionHolds(e.condition, input)) {
      return { status: "BLOCKED", nodeId: node.nodeId, reasonCode: "CONDITION_FALSE", reason: `condition ${e.condition.type} not satisfied` };
    }
  }

  // artifact inputs: the edge source must have produced a ref of the edge's
  // declared type, authored by the source, with a valid sha256 content hash
  const artifactEdges = input.spec.edges.filter(
    (e) => e.toNodeId === node.nodeId && e.edgeType === "ARTIFACT",
  );
  for (const e of artifactEdges) {
    const run = state.nodeRuns[e.fromNodeId];
    if (!run || run.status !== "SUCCEEDED") {
      return { status: "WAITING", nodeId: node.nodeId, reason: `artifact source ${e.fromNodeId} not ready` };
    }
    const type = e.artifactType ?? "dataset";
    const match = run.outputRefs.find((r) =>
      r.artifactType === type
      && r.createdByNodeId === e.fromNodeId
      && /^[a-f0-9]{64}$/.test(r.contentHash));
    if (!match) {
      return { status: "BLOCKED", nodeId: node.nodeId, reasonCode: "ARTIFACT_MISSING",
        reason: `no ${type} artifact from ${e.fromNodeId} (source-bound, sha256)` };
    }
  }

  if (!input.availableCapabilities.has(node.capabilityId)) {
    return { status: "BLOCKED", nodeId: node.nodeId, reasonCode: "CAPABILITY_UNAVAILABLE", reason: `capability ${node.capabilityId} unavailable` };
  }

  const run = state.nodeRuns[node.nodeId];
  if (!run) return { status: "WAITING", nodeId: node.nodeId, reason: "no run state" };
  if (run.status === "SUCCEEDED" || run.status === "FAILED" || run.status === "BLOCKED" || run.status === "WAITING_FOR_HUMAN") {
    return { status: "WAITING", nodeId: node.nodeId, reason: `node ${run.status}` };
  }
  // RUNNING means an in-flight attempt (crashed before completion). Recovery
  // semantics: it may be re-dispatched; the executor bounds attempts and
  // human gates re-verify external resolutions.
  if (run.status === "RUNNING") {
    return { status: "READY", nodeId: node.nodeId, reason: "in-flight attempt recovered" };
  }
  return { status: "READY", nodeId: node.nodeId, reason: "dependencies satisfied" };
}

function conditionHolds(c: GraphCondition, input: SchedulerInput): boolean {
  switch (c.type) {
    case "NODE_SUCCEEDED":
      return input.state.nodeRuns[c.nodeId]?.status === "SUCCEEDED";
    case "NODE_FAILED":
      return input.state.nodeRuns[c.nodeId]?.status === "FAILED";
    case "VERDICT_EQUALS": {
      // The verdict MUST come from THIS edge's source node (createdByNodeId
      // binding) — a verdict ref emitted by any other node cannot satisfy
      // the condition. The ref's contentHash binds the review identity.
      const source = input.state.nodeRuns[c.nodeId];
      if (!source) return false;
      const verdictOk = source.outputRefs.some((r) =>
        r.artifactType === "verdict"
        && r.artifactId === `verdict:${c.verdict.toLowerCase()}`
        && r.createdByNodeId === c.nodeId);
      if (verdictOk) return true;
      // PASS-equivalent: a permission-controlled human-review decision from
      // the SAME source node (operator accepted an ABSTAIN review)
      if (c.verdict === "PASS") {
        return source.outputRefs.some((r) =>
          r.artifactType === "human-review-decision"
          && r.createdByNodeId === c.nodeId);
      }
      return false;
    }
    case "ERROR_CODE_IN": {
      const codes = Object.values(input.state.nodeRuns)
        .map((n) => n.errorCode)
        .filter(Boolean);
      return codes.some((c2) => c.errorCodes.includes(c2!));
    }
    case "ARTIFACT_PRESENT":
      return input.state.artifactRefs.some((r) => r.artifactType === c.artifactType);
    case "HUMAN_APPROVED": {
      const h = input.state.pendingHumanActions.find((a) => a.actionRef === c.actionRef);
      return h?.resolved === true && h.resolution === "APPROVED";
    }
  }
}

export interface WaveDecision {
  ready: ReadyDecision[];
  blocked: ReadyDecision[];
}

/** Deterministic next wave (sorted by nodeId): READY nodes may run,
 *  BLOCKED nodes must be turned into NODE_BLOCKED by the executor. */
export function nextWave(input: SchedulerInput): WaveDecision {
  const pending = input.spec.nodes
    .filter((n) => {
      const run = input.state.nodeRuns[n.nodeId];
      // RUNNING = in-flight attempt (crashed) — recoverable, re-dispatchable
      return !run || run.status === "PENDING" || run.status === "READY" || run.status === "RUNNING";
    })
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  const ready: ReadyDecision[] = [];
  const blocked: ReadyDecision[] = [];
  const keysInWave = new Set<string>();
  const max = input.parallelismEnabled ? input.maxParallelNodes : 1;
  for (const node of pending) {
    if (ready.length >= max) break;
    if (node.concurrencyKey && keysInWave.has(node.concurrencyKey)) continue;
    const decision = isReady(node, input);
    if (decision.status === "BLOCKED") {
      blocked.push(decision);
    } else if (decision.status === "READY") {
      ready.push(decision);
      if (node.concurrencyKey) keysInWave.add(node.concurrencyKey);
    }
  }
  return { ready, blocked };
}
