/**
 * Graph Engineering Runtime — core contracts (Phase 1).
 *
 * Deterministic, typed, immutable, recoverable, auditable. The graph core
 * never executes business logic; adapters do. Artifact edges carry REFS
 * only — raw data never travels through the graph, and numeric values never
 * appear in model-facing summaries or events.
 */

// ---------------------------------------------------------------------------
// ArtifactRef — the ONLY thing that flows along ARTIFACT edges
// ---------------------------------------------------------------------------

export interface ArtifactRef {
  artifactId: string;
  artifactType: string;
  contentHash: string;
  schemaVersion: string;
  /** The node that DERIVED this ref in the graph (scheduler binding). */
  createdByNodeId: string;
  /** The original trusted artifact (for derived refs). */
  originArtifactId?: string;
  originCreatedBy?: string;
  queryId?: string;
  snapshotId?: string;
}

// ---------------------------------------------------------------------------
// GraphSpec — immutable compiled graph
// ---------------------------------------------------------------------------

export type GraphNodeKind =
  | "DETERMINISTIC"
  | "TOOL"
  | "AGENT"
  | "SKILL"
  | "REDUCER"
  | "HUMAN_GATE";

export type GraphSideEffect = "NONE" | "READ" | "WRITE";

export interface GraphRetryPolicy {
  maxAttempts: number;
  retryableErrorCodes: string[];
  backoff: "NONE" | "FIXED" | "EXPONENTIAL";
  initialDelayMs: number;
}

export interface GraphNodeSpec {
  nodeId: string;
  kind: GraphNodeKind;
  capabilityId: string;
  label: string;
  dependsOn: string[];
  inputContract: string;
  outputContract: string;
  sideEffect: GraphSideEffect;
  requiredFeatures: string[];
  timeoutMs: number;
  maxAttempts: number;
  retryPolicy: GraphRetryPolicy;
  concurrencyKey?: string;
  /** No executable code; only fixed scalar metadata (e.g. format, detailLevel). */
  metadata: Record<string, string | number | boolean>;
}

/** Fixed-enum structured conditions — executable code is forbidden. */
export type GraphCondition =
  | { type: "NODE_SUCCEEDED"; nodeId: string }
  | { type: "NODE_FAILED"; nodeId: string }
  | { type: "VERDICT_EQUALS"; nodeId: string; verdict: "PASS" | "CHANGES_REQUIRED" | "REJECT" | "ABSTAIN" | "UNREVIEWED_LOW_RISK" }
  | { type: "ERROR_CODE_IN"; errorCodes: string[] }
  | { type: "ARTIFACT_PRESENT"; artifactType: string }
  | { type: "HUMAN_APPROVED"; actionRef: string };

export type GraphEdgeType = "CONTROL" | "ARTIFACT" | "FEEDBACK" | "DECISION";

export interface GraphEdgeSpec {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: GraphEdgeType;
  artifactType?: string;
  condition?: GraphCondition;
  feedbackReasonCodes?: string[];
}

export interface GraphSpec {
  schemaVersion: "1.0";
  graphId: string;
  graphVersion: number;
  objective: string;
  sourcePlanRef: ArtifactRef;
  featureSnapshotHash: string;
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
  entryNodeIds: string[];
  terminalNodeIds: string[];
  policyRefs: ArtifactRef[];
  contentHash: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

export type NodeRunStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "WAITING_FOR_HUMAN"
  | "SKIPPED"
  | "CANCELLED";

export interface NodeRunState {
  nodeId: string;
  status: NodeRunStatus;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  inputRefs: ArtifactRef[];
  outputRefs: ArtifactRef[];
  decisionRefs: ArtifactRef[];
  errorCode?: string;
  retryable?: boolean;
  /** No business values, no raw numbers — codes/refs only. */
  summary?: string;
}

export interface HumanActionRef {
  actionRef: string;
  nodeId: string;
  actionType: "APPROVE" | "REJECT" | "WAIVE" | "REVIEW";
  reasonCode?: string;
  createdAt: string;
  resolved?: boolean;
  resolution?: "APPROVED" | "REJECTED" | "WAIVED";
  resolvedAt?: string;
}

export type GraphRunStatus =
  | "CREATED"
  | "RUNNING"
  | "WAITING_FOR_HUMAN"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface GraphRunState {
  schemaVersion: "1.0";
  runId: string;
  graphId: string;
  graphVersion: number;
  graphContentHash: string;
  featureSnapshotHash: string;
  status: GraphRunStatus;
  nodeRuns: Record<string, NodeRunState>;
  artifactRefs: ArtifactRef[];
  decisionRefs: ArtifactRef[];
  pendingHumanActions: HumanActionRef[];
  /** Feedback-loop cycles consumed (REVISION_REQUESTED events applied). */
  revisionCycles: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Events — append-only, hash-chained, fail closed
// ---------------------------------------------------------------------------

export type GraphEventType =
  | "GRAPH_CREATED"
  | "GRAPH_VALIDATED"
  | "GRAPH_STARTED"
  | "NODE_READY"
  | "NODE_STARTED"
  | "NODE_SUCCEEDED"
  | "NODE_FAILED"
  | "NODE_RETRY_SCHEDULED"
  | "NODE_BLOCKED"
  | "ARTIFACT_ATTACHED"
  | "ROUTE_SELECTED"
  | "REVIEW_GATE_DECIDED"
  | "REVIEW_COMPLETED"
  | "REVISION_REQUESTED"
  | "HUMAN_ACTION_REQUIRED"
  | "HUMAN_ACTION_RECORDED"
  | "GRAPH_VERSION_CREATED"
  | "GRAPH_COMPLETED"
  | "GRAPH_FAILED"
  | "GRAPH_CANCELLED";

export interface GraphEvent {
  eventId: string;
  runId: string;
  graphId: string;
  graphVersion: number;
  sequence: number;
  eventType: GraphEventType;
  nodeId?: string;
  refs: ArtifactRef[];
  errorCode?: string;
  /** Structured codes only (resolution, actorId, graphContentHash...) —
   *  never business numbers or raw data. */
  meta: Record<string, string>;
  timestamp: string;
  previousEventHash: string;
  contentHash: string;
}

/** No raw data, credentials, model output or business numbers in events. */
export const EVENT_SENSITIVE_FIELDS = ["rawData", "rows", "credentials", "modelOutput"] as const;
