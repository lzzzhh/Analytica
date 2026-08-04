/**
 * Graph Engine — state reducer: event stream -> GraphRunState (recoverable).
 *
 * Replaying the event log deterministically rebuilds the run state, so a
 * crashed executor can resume from the persisted projection without rerunning
 * succeeded nodes.
 */
import { canonicalize, contentHash } from "./canonical.ts";
import type {
  GraphEvent,
  GraphRunState,
  HumanActionRef,
  NodeRunState,
  NodeRunStatus,
} from "./contracts.ts";
import { GraphError } from "./errors.ts";

export function newRunState(input: {
  runId: string;
  graphId: string;
  graphVersion: number;
  graphContentHash: string;
  featureSnapshotHash: string;
  nodeIds: string[];
}): GraphRunState {
  const now = new Date().toISOString();
  const nodeRuns: Record<string, NodeRunState> = {};
  for (const nodeId of input.nodeIds) {
    nodeRuns[nodeId] = { nodeId, status: "PENDING", attempt: 0, inputRefs: [], outputRefs: [], decisionRefs: [] };
  }
  return {
    schemaVersion: "1.0",
    runId: input.runId,
    graphId: input.graphId,
    graphVersion: input.graphVersion,
    graphContentHash: input.graphContentHash,
    featureSnapshotHash: input.featureSnapshotHash,
    status: "CREATED",
    nodeRuns,
    artifactRefs: [],
    decisionRefs: [],
    pendingHumanActions: [],
    revisionCycles: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function transition(node: NodeRunState, status: NodeRunStatus, event: GraphEvent): NodeRunState {
  return {
    ...node,
    status,
    attempt: event.eventType === "NODE_STARTED" ? node.attempt + 1 : node.attempt,
    startedAt: event.eventType === "NODE_STARTED" ? event.timestamp : node.startedAt,
    completedAt:
      event.eventType === "NODE_SUCCEEDED" || event.eventType === "NODE_FAILED" || event.eventType === "NODE_BLOCKED"
        ? event.timestamp
        : node.completedAt,
    errorCode: event.errorCode ?? node.errorCode,
    retryable: event.eventType === "NODE_RETRY_SCHEDULED" ? true : node.retryable,
    summary: event.eventType === "NODE_BLOCKED" ? "blocked" : node.summary,
  };
}

/** Terminal runs are immutable: only audit-style events may be applied. */
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const AUDIT_EVENTS = new Set(["GRAPH_CREATED", "GRAPH_VALIDATED", "GRAPH_STARTED", "GRAPH_VERSION_CREATED"]);

/** Apply one event to a run state (pure). */
export function reduceEvent(state: GraphRunState, event: GraphEvent): GraphRunState {
  if (TERMINAL_STATUSES.has(state.status) && !AUDIT_EVENTS.has(event.eventType)) {
    throw new Error(`terminal run ${state.runId} refuses state event ${event.eventType}`);
  }
  const next: GraphRunState = {
    ...state,
    nodeRuns: { ...state.nodeRuns },
    artifactRefs: [...state.artifactRefs],
    decisionRefs: [...state.decisionRefs],
    pendingHumanActions: [...state.pendingHumanActions],
    updatedAt: event.timestamp,
  };
  const touch = (id: string) => {
    next.nodeRuns[id] = next.nodeRuns[id] ?? {
      nodeId: id, status: "PENDING", attempt: 0, inputRefs: [], outputRefs: [], decisionRefs: [],
    };
    return next.nodeRuns[id]!;
  };

  switch (event.eventType) {
    case "GRAPH_STARTED":
      next.status = "RUNNING";
      break;
    case "NODE_READY":
      next.nodeRuns[event.nodeId!] = transition(touch(event.nodeId!), "READY", event);
      break;
    case "NODE_STARTED":
      next.nodeRuns[event.nodeId!] = transition(touch(event.nodeId!), "RUNNING", event);
      break;
    case "NODE_SUCCEEDED": {
      const n = transition(touch(event.nodeId!), "SUCCEEDED", event);
      n.outputRefs = [...n.outputRefs, ...event.refs.filter((r) => !n.outputRefs.some((o) => o.artifactId === r.artifactId))];
      next.nodeRuns[event.nodeId!] = n;
      next.artifactRefs = dedupRefs([...next.artifactRefs, ...event.refs]);
      break;
    }
    case "NODE_FAILED":
      next.nodeRuns[event.nodeId!] = transition(touch(event.nodeId!), "FAILED", event);
      break;
    case "NODE_RETRY_SCHEDULED":
      next.nodeRuns[event.nodeId!] = transition(touch(event.nodeId!), "READY", event);
      break;
    case "NODE_BLOCKED":
      next.nodeRuns[event.nodeId!] = transition(touch(event.nodeId!), "BLOCKED", event);
      break;
    case "REVIEW_COMPLETED":
      next.decisionRefs = dedupRefs([...next.decisionRefs, ...event.refs]);
      break;
    case "ARTIFACT_ATTACHED":
      next.artifactRefs = dedupRefs([...next.artifactRefs, ...event.refs]);
      break;
    case "HUMAN_ACTION_REQUIRED": {
      const refs = event.refs.filter((r) => r.artifactType === "human-action");
      for (const r of refs) {
        const action: HumanActionRef = {
          actionRef: r.artifactId,
          nodeId: event.nodeId ?? "",
          actionType: "REVIEW",
          createdAt: event.timestamp,
        };
        next.pendingHumanActions.push(action);
      }
      next.status = "WAITING_FOR_HUMAN";
      break;
    }
    case "HUMAN_ACTION_RECORDED": {
      const refs = event.refs.filter((r) => r.artifactType === "human-action" || r.artifactType === "human-action-resolution");
      for (const r of refs) {
        const idx = next.pendingHumanActions.findIndex((a) => a.actionRef === r.artifactId);
        if (idx >= 0) {
          next.pendingHumanActions[idx] = {
            ...next.pendingHumanActions[idx]!,
            resolved: true,
            resolution: (event.errorCode === "HUMAN_APPROVAL_REQUIRED" ? "REJECTED" : "APPROVED"),
            resolvedAt: event.timestamp,
          };
        }
      }
      // only switch back to RUNNING when there IS at least one pending
      // action and ALL of them are resolved (the empty-array every() trap
      // must never resurrect a run)
      if (next.pendingHumanActions.length > 0
          && next.pendingHumanActions.every((a) => a.resolved)) {
        next.status = "RUNNING";
      }
      break;
    }
    case "GRAPH_COMPLETED":
      next.status = "COMPLETED";
      break;
    case "GRAPH_FAILED":
      next.status = "FAILED";
      break;
    case "GRAPH_CANCELLED":
      next.status = "CANCELLED";
      break;
    case "GRAPH_VERSION_CREATED": {
      const version = Number(event.meta["version"] ?? "0");
      const specRef = event.refs.find((r) => r.artifactType === "graph-spec");
      if (version > 0) {
        next.graphVersion = version;
        next.graphContentHash = specRef?.contentHash ?? next.graphContentHash;
      }
      break;
    }
    case "REVISION_REQUESTED": {
      // FEEDBACK LOOP: the executor names the nodes to reset (the routed
      // target + its topological successors) in meta["resetNodes"]; replay
      // of the same event resets the SAME nodes (deterministic)
      next.revisionCycles = (next.revisionCycles ?? 0) + 1;
      const reset = (event.meta["resetNodes"] ?? "").split(",").map((n) => n.trim()).filter((n) => n.length > 0);
      for (const id of reset) {
        const n = next.nodeRuns[id];
        if (n) {
          next.nodeRuns[id] = {
            nodeId: id, status: "PENDING", attempt: 0,
            inputRefs: [], outputRefs: [], decisionRefs: [],
            errorCode: undefined, retryable: false,
          };
        }
      }
      break;
    }
    default:
      break;
  }
  return next;
}

/** Rebuild the run state by replaying all events (recovery path). */
export function replayRunState(
  initialState: GraphRunState,
  events: GraphEvent[],
): GraphRunState {
  let state = initialState;
  for (const ev of events.sort((a, b) => a.sequence - b.sequence)) {
    state = reduceEvent(state, ev);
  }
  return state;
}

/** Deterministic projection fingerprint (state equality assertions). */
export function stateHash(state: GraphRunState): string {
  return contentHash({
    status: state.status,
    nodes: Object.values(state.nodeRuns)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map((n) => ({ id: n.nodeId, status: n.status, attempt: n.attempt, errorCode: n.errorCode })),
    artifacts: state.artifactRefs.map((r) => r.artifactId).sort(),
  });
}

export function dedupRefs<T extends { artifactId: string }>(refs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of refs) {
    if (seen.has(r.artifactId)) continue;
    seen.add(r.artifactId);
    out.push(r);
  }
  return out;
}

/** Integrity guard: event payloads must never carry business values. */
export function assertEventClean(event: GraphEvent): void {
  const text = canonicalize(event);
  for (const field of ["rawData", "rows", "credentials", "modelOutput", "numbers"]) {
    if (text.includes(`"${field}"`)) {
      throw new GraphError("SCHEMA_INVALID", `graph event carries forbidden field '${field}'`, { retryable: false });
    }
  }
}
