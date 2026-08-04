/**
 * Graph Engine — adapter contract. Adapters bridge graph nodes to EXISTING
 * modules; they never re-implement business logic, never return raw data,
 * never fabricate refs. Output is typed NodeResult with refs only.
 */
import type { ArtifactRef, GraphNodeSpec, GraphRunState } from "../contracts.ts";
import type { GraphErrorCode } from "../errors.ts";

export interface AdapterContext {
  node: GraphNodeSpec;
  runId: string;
  graphId: string;
  graphVersion: number;
  state: GraphRunState;
  inputRefs: ArtifactRef[];
  featureSnapshotHash: string;
  /** Host-injected trusted principal; never model-provided. */
  principal: { source: "OPERATOR_CLI" | "USER_UI" | "SYSTEM"; actorId: string; authenticated: boolean };
  /** STABLE operation key: runId/nodeId (never includes attempt) — adapters
   *  must key side effects on this so retries/resume cannot duplicate them. */
  idempotencyKey: string;
  /** Attempt number of the current adapter invocation. */
  attempt: number;
  /** Aborts the adapter when the node timeout fires (best effort). */
  abortSignal?: AbortSignal;
}

export interface ReviewerDecisionPayload {
  verdict: "PASS" | "CHANGES_REQUIRED" | "REJECT" | "ABSTAIN" | "UNREVIEWED_LOW_RISK";
  reviewDecisionRef: ArtifactRef;
  reasonCodes: string[];
  findingRefs: ArtifactRef[];
  /** ABSTAIN: the exact review/gate/policy binding for the operator
   *  resolution artifact (never inferred by the executor). */
  humanActionContext?: {
    reviewId: string;
    gateDecisionId: string;
    policySnapshotHash: string;
  };
}

export interface AdapterResult {
  outputRefs: ArtifactRef[];
  decisionRefs?: ArtifactRef[];
  /** Typed reviewer decision — NEVER parsed from a human summary. */
  decision?: ReviewerDecisionPayload;
  /** Codes/refs only — no business numbers. */
  summary?: string;
}

export interface GraphNodeAdapter {
  capabilityId: string;
  execute(ctx: AdapterContext): Promise<AdapterResult>;
}

export type AdapterError = {
  code: GraphErrorCode;
  message: string;
};

export function adapterError(code: GraphErrorCode, message: string): AdapterError {
  return { code, message };
}
