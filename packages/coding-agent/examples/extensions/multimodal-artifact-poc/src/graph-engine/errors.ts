/**
 * Graph Engine — typed errors (deterministic error codes, never free text).
 */
export type GraphErrorCode =
  | "INVALID_GRAPH"
  | "CYCLE_DETECTED"
  | "DUPLICATE_NODE"
  | "UNKNOWN_NODE_REF"
  | "UNREGISTERED_CAPABILITY"
  | "FEATURE_DISABLED"
  | "CAPABILITY_UNAVAILABLE"
  | "CONDITION_CODE_EXECUTION_FORBIDDEN"
  | "GRAPH_TOO_LARGE"
  | "BUDGET_EXCEEDED"
  | "HASH_MISMATCH"
  | "SCHEMA_INVALID"
  | "ARTIFACT_MISSING"
  | "SANDBOX_VIOLATION"
  | "PERMISSION_DENIED"
  | "MASKING_REQUIRED"
  | "LINEAGE_MISSING"
  | "SCHEMA_MISMATCH"
  | "HUMAN_APPROVAL_REQUIRED"
  | "TEMPORARY_UNAVAILABLE"
  | "TIMEOUT"
  | "TRANSIENT_IO"
  | "RPC_UNAVAILABLE"
  | "REVIEW_BLOCKED"
  | "REVIEW_ABSTAIN"
  | "REVIEW_REJECTED"
  | "PROMOTION_DENIED"
  | "REPORT_QA_FAILED"
  | "REPORT_SKILL_UNAVAILABLE"
  | "UPSTREAM_FAILED"
  | "CONDITION_FALSE"
  | "BLOCKED_BY_HUMAN"
  | "GENESIS_MISSING"
  | "TERMINAL_RUN_IMMUTABLE"
  | "UNKNOWN_ERROR";

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly nodeId?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, string>;

  constructor(code: GraphErrorCode, message: string, opts: {
    nodeId?: string;
    retryable?: boolean;
    details?: Record<string, string>;
  } = {}) {
    super(message);
    this.name = "GraphError";
    this.code = code;
    this.nodeId = opts.nodeId;
    this.retryable = opts.retryable ?? RETRYABLE_CODES.has(code);
    this.details = opts.details;
  }
}

/** Deterministic failures are never retried. */
export const NON_RETRYABLE: ReadonlySet<GraphErrorCode> = new Set([
  "INVALID_GRAPH",
  "CYCLE_DETECTED",
  "DUPLICATE_NODE",
  "UNKNOWN_NODE_REF",
  "UNREGISTERED_CAPABILITY",
  "FEATURE_DISABLED",
  "CAPABILITY_UNAVAILABLE",
  "CONDITION_CODE_EXECUTION_FORBIDDEN",
  "GRAPH_TOO_LARGE",
  "HASH_MISMATCH",
  "SCHEMA_INVALID",
  "SANDBOX_VIOLATION",
  "PERMISSION_DENIED",
  "HUMAN_APPROVAL_REQUIRED",
  "REPORT_SKILL_UNAVAILABLE",
]);

/** Transient infrastructure failures may be retried with the node policy. */
export const RETRYABLE_CODES: ReadonlySet<GraphErrorCode> = new Set([
  "TEMPORARY_UNAVAILABLE",
  "TIMEOUT",
  "TRANSIENT_IO",
  "RPC_UNAVAILABLE",
]);
