/**
 * Graph Engine — capability registry (graph.* capability descriptors).
 *
 * Graph core references these ids, never concrete Pi tool names. Each
 * descriptor binds: node kind, feature gate, contracts, side effect, cost,
 * parallelism, adapter id, timeout and retry policy.
 */
import type { CapabilityDescriptor } from "./graph-validator.ts";

export const GRAPH_CAPABILITIES: Record<string, CapabilityDescriptor> = {
  "graph.requirement.plan": {
    capabilityId: "graph.requirement.plan", nodeKind: "DETERMINISTIC", featureId: "round4.requirement_planning",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: false, adapterId: "requirement-planning", timeoutPolicyMs: 60_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.catalog.search": {
    capabilityId: "graph.catalog.search", nodeKind: "TOOL", featureId: "round2.catalog_tools",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: true, adapterId: "lakehouse-catalog", timeoutPolicyMs: 30_000,
    retryPolicy: { maxAttempts: 2, retryableErrorCodes: ["RPC_UNAVAILABLE", "TIMEOUT", "TRANSIENT_IO"] },
  },
  "graph.dataset.inspect": {
    capabilityId: "graph.dataset.inspect", nodeKind: "TOOL", featureId: "round2.catalog_tools",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: true, adapterId: "lakehouse-catalog", timeoutPolicyMs: 30_000,
    retryPolicy: { maxAttempts: 2, retryableErrorCodes: ["RPC_UNAVAILABLE", "TIMEOUT"] },
  },
  "graph.query.validate": {
    capabilityId: "graph.query.validate", nodeKind: "TOOL", featureId: "round2.query_tools",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: true, adapterId: "lakehouse-query", timeoutPolicyMs: 30_000,
    retryPolicy: { maxAttempts: 2, retryableErrorCodes: ["RPC_UNAVAILABLE", "TIMEOUT"] },
  },
  "graph.query.execute": {
    capabilityId: "graph.query.execute", nodeKind: "TOOL", featureId: "round2.query_tools",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "LOW",
    supportsParallel: true, adapterId: "lakehouse-query", timeoutPolicyMs: 60_000,
    retryPolicy: { maxAttempts: 2, retryableErrorCodes: ["RPC_UNAVAILABLE", "TIMEOUT", "TRANSIENT_IO"] },
  },
  "graph.query.materialize": {
    capabilityId: "graph.query.materialize", nodeKind: "TOOL", featureId: "round4.analysis_input_materialization",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "WRITE", costClass: "MEDIUM",
    supportsParallel: false, adapterId: "lakehouse-materialize", timeoutPolicyMs: 120_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.governance.preflight": {
    capabilityId: "graph.governance.preflight", nodeKind: "DETERMINISTIC", featureId: "round6.graph_executor",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: false, adapterId: "preflight-governance", timeoutPolicyMs: 30_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.analysis.run": {
    capabilityId: "graph.analysis.run", nodeKind: "AGENT", featureId: "round4.data_analysis",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "HIGH",
    supportsParallel: false, adapterId: "data-analysis", timeoutPolicyMs: 300_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.data.quality": {
    capabilityId: "graph.data.quality", nodeKind: "TOOL", featureId: "round2.data_quality",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "LOW",
    supportsParallel: true, adapterId: "data-quality", timeoutPolicyMs: 60_000,
    retryPolicy: { maxAttempts: 2, retryableErrorCodes: ["RPC_UNAVAILABLE", "TIMEOUT"] },
  },
  "graph.data.lineage": {
    capabilityId: "graph.data.lineage", nodeKind: "TOOL", featureId: "round2.lineage",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "LOW",
    supportsParallel: true, adapterId: "lineage", timeoutPolicyMs: 60_000,
    retryPolicy: { maxAttempts: 2, retryableErrorCodes: ["RPC_UNAVAILABLE", "TIMEOUT"] },
  },
  "graph.data.snapshot": {
    capabilityId: "graph.data.snapshot", nodeKind: "TOOL", featureId: "round2.snapshot",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "LOW",
    supportsParallel: true, adapterId: "snapshot", timeoutPolicyMs: 60_000,
    retryPolicy: { maxAttempts: 2, retryableErrorCodes: ["RPC_UNAVAILABLE", "TIMEOUT"] },
  },
  "graph.analysis.fan_in": {
    capabilityId: "graph.analysis.fan_in", nodeKind: "REDUCER", featureId: "round6.graph_executor",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: false, adapterId: "fan-in", timeoutPolicyMs: 30_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.review.plan": {
    capabilityId: "graph.review.plan", nodeKind: "DETERMINISTIC", featureId: "round6.graph_review_integration",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: false, adapterId: "review-gate", timeoutPolicyMs: 30_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.review.execute": {
    capabilityId: "graph.review.execute", nodeKind: "DETERMINISTIC", featureId: "round6.graph_review_integration",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "MEDIUM",
    supportsParallel: false, adapterId: "reviewer", timeoutPolicyMs: 300_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.review.authorize": {
    capabilityId: "graph.review.authorize", nodeKind: "DETERMINISTIC", featureId: "round6.graph_review_integration",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: false, adapterId: "promotion", timeoutPolicyMs: 30_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "skill.analysis.report": {
    capabilityId: "skill.analysis.report", nodeKind: "SKILL", featureId: "round6.graph_skill_nodes",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "WRITE", costClass: "MEDIUM",
    supportsParallel: false, adapterId: "analysis-report-skill", timeoutPolicyMs: 300_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.deliverable.verify": {
    capabilityId: "graph.deliverable.verify", nodeKind: "DETERMINISTIC", featureId: "round6.graph_skill_nodes",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: false, adapterId: "deliverable-verifier", timeoutPolicyMs: 60_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.human.review": {
    capabilityId: "graph.human.review", nodeKind: "HUMAN_GATE", featureId: "round6.graph_human_gates",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "NONE", costClass: "FREE",
    supportsParallel: false, adapterId: "human-gate", timeoutPolicyMs: 0,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.artifact.inputs": {
    capabilityId: "graph.artifact.inputs", nodeKind: "DETERMINISTIC", featureId: "round6.graph_executor",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "FREE",
    supportsParallel: false, adapterId: "initial-artifacts", timeoutPolicyMs: 0,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
  "graph.pipeline.remediation": {
    capabilityId: "graph.pipeline.remediation", nodeKind: "DETERMINISTIC", featureId: "round2.pipeline_governance",
    inputContract: "artifact-refs", outputContract: "artifact-refs", sideEffect: "READ", costClass: "LOW",
    supportsParallel: false, adapterId: "pipeline-governance", timeoutPolicyMs: 60_000,
    retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
  },
};

export function graphCapabilityMap(): Map<string, CapabilityDescriptor> {
  return new Map(Object.entries(GRAPH_CAPABILITIES));
}
