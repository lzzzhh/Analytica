/**
 * Graph Engine — deterministic GraphSpec validation.
 *
 * Rejects: duplicate/unknown node refs, cycles, unregistered capabilities,
 * code-style conditions, oversized graphs, and any dynamic load hints
 * (paths/functions in metadata).
 */
import { contentHash, specContentHash } from "./canonical.ts";
import type { GraphNodeSpec, GraphSpec } from "./contracts.ts";
import { GraphError } from "./errors.ts";

export interface CapabilityDescriptor {
  capabilityId: string;
  nodeKind: string;
  featureId: string;
  inputContract: string;
  outputContract: string;
  sideEffect: "NONE" | "READ" | "WRITE";
  costClass: "FREE" | "LOW" | "MEDIUM" | "HIGH";
  supportsParallel: boolean;
  adapterId: string;
  timeoutPolicyMs: number;
  retryPolicy: { maxAttempts: number; retryableErrorCodes: string[] };
}

export const GRAPH_LIMITS = {
  maxNodes: 64,
  maxEdges: 128,
  maxDepth: 16,
  maxParallel: 8,
};

export interface ValidationOptions {
  capabilities: Map<string, CapabilityDescriptor>;
  featureSnapshotHash: string;
  /** Effective feature ids of the run (immutable); when provided, every
   *  capability feature and node requiredFeatures must be effective. */
  effectiveFeatures?: ReadonlySet<string>;
  limits?: typeof GRAPH_LIMITS;
}

export function validateGraphSpec(spec: GraphSpec, opts: ValidationOptions): string[] {
  const issues: string[] = [];

  // content hash self-consistency
  if (specContentHash(spec) !== spec.contentHash) {
    issues.push("contentHash does not match the canonical spec body");
  }
  if (spec.schemaVersion !== "1.0") issues.push(`unsupported schemaVersion ${spec.schemaVersion}`);

  // duplicate node ids
  const ids = new Set<string>();
  for (const n of spec.nodes) {
    if (ids.has(n.nodeId)) issues.push(`duplicate nodeId ${n.nodeId}`);
    ids.add(n.nodeId);
  }

  // edge refs
  for (const e of spec.edges) {
    if (!ids.has(e.fromNodeId)) issues.push(`edge ${e.edgeId} references unknown fromNodeId ${e.fromNodeId}`);
    if (!ids.has(e.toNodeId)) issues.push(`edge ${e.edgeId} references unknown toNodeId ${e.toNodeId}`);
  }
  for (const n of spec.nodes) {
    for (const dep of n.dependsOn) {
      if (!ids.has(dep)) issues.push(`node ${n.nodeId} dependsOn unknown node ${dep}`);
    }
  }
  for (const id of spec.entryNodeIds) if (!ids.has(id)) issues.push(`entryNodeId ${id} unknown`);
  for (const id of spec.terminalNodeIds) if (!ids.has(id)) issues.push(`terminalNodeId ${id} unknown`);

  // capability + feature
  const limit = opts.limits ?? GRAPH_LIMITS;
  if (spec.nodes.length > limit.maxNodes) issues.push(`graph exceeds maxNodes ${limit.maxNodes}`);
  if (spec.edges.length > limit.maxEdges) issues.push(`graph exceeds maxEdges ${limit.maxEdges}`);
  for (const n of spec.nodes) {
    const cap = opts.capabilities.get(n.capabilityId);
    if (!cap) {
      issues.push(`node ${n.nodeId} uses unregistered capability ${n.capabilityId}`);
      continue;
    }
    if (cap.nodeKind !== n.kind) issues.push(`node ${n.nodeId} kind ${n.kind} != capability kind ${cap.nodeKind}`);
    if (n.inputContract !== cap.inputContract) issues.push(`node ${n.nodeId} inputContract mismatch`);
    if (n.outputContract !== cap.outputContract) issues.push(`node ${n.nodeId} outputContract mismatch`);
    // capability contract must match the node exactly (no WRITE disguised as READ)
    if (n.sideEffect !== cap.sideEffect) issues.push(`node ${n.nodeId} sideEffect ${n.sideEffect} != capability ${cap.sideEffect}`);
    if (n.kind !== cap.nodeKind) issues.push(`node ${n.nodeId} kind ${n.kind} != capability ${cap.nodeKind}`);
    if (n.timeoutMs > cap.timeoutPolicyMs && cap.timeoutPolicyMs > 0) {
      issues.push(`node ${n.nodeId} timeout ${n.timeoutMs} exceeds capability policy ${cap.timeoutPolicyMs}`);
    }
    if (n.maxAttempts > cap.retryPolicy.maxAttempts) {
      issues.push(`node ${n.nodeId} maxAttempts ${n.maxAttempts} exceeds capability policy ${cap.retryPolicy.maxAttempts}`);
    }
    // feature gating: the capability's feature must be effective in the run
    if (opts.effectiveFeatures && !opts.effectiveFeatures.has(cap.featureId)) {
      issues.push(`node ${n.nodeId} capability ${n.capabilityId} requires feature ${cap.featureId} which is not effective`);
    }
    for (const fid of n.requiredFeatures) {
      if (opts.effectiveFeatures && !opts.effectiveFeatures.has(fid)) {
        issues.push(`node ${n.nodeId} requires feature ${fid} which is not effective`);
      }
    }
    // metadata may never carry load hints / code
    for (const [k, v] of Object.entries(n.metadata)) {
      if (typeof v === "string" && /(?:\.\.\/|^\/|require\(|import\(|eval\(|exec\(|function\s*\()/i.test(v)) {
        issues.push(`node ${n.nodeId} metadata.${k} looks executable or path-like`);
      }
    }
  }

  // conditions: enum-shaped only, never code strings
  for (const e of spec.edges) {
    const c = e.condition;
    if (!c) continue;
    const allowed = ["NODE_SUCCEEDED", "NODE_FAILED", "VERDICT_EQUALS", "ERROR_CODE_IN", "ARTIFACT_PRESENT", "HUMAN_APPROVED"];
    if (!allowed.includes(c.type)) {
      issues.push(`edge ${e.edgeId} condition type ${String((c as { type?: string }).type)} not in enum`);
    }
  }

  // cycle detection (deterministic DFS on control edges)
  const controlEdges = new Map<string, string[]>();
  for (const e of spec.edges) {
    if (e.edgeType !== "CONTROL" && e.edgeType !== "FEEDBACK") continue;
    const list = controlEdges.get(e.fromNodeId) ?? [];
    list.push(e.toNodeId);
    controlEdges.set(e.fromNodeId, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) {
      issues.push(`cycle detected involving node ${id} (${stack.concat(id).join(" -> ")})`);
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    stack.push(id);
    for (const next of controlEdges.get(id) ?? []) {
      if (hasCycle(next)) return true;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const n of spec.nodes) hasCycle(n.nodeId);

  // depth bound (skipped when a cycle was already reported — cyclic depth
  // is undefined and would recurse forever)
  if (!issues.some((i) => i.includes("cycle"))) {
    const depthOf = (id: string, memo: Map<string, number>): number => {
      if (memo.has(id)) return memo.get(id)!;
      const deps = controlEdges.get(id) ?? [];
      const depth = deps.length === 0 ? 1 : 1 + Math.max(...deps.map((d) => depthOf(d, memo)));
      memo.set(id, depth);
      return depth;
    };
    const memo = new Map<string, number>();
    for (const n of spec.nodes) {
      if (depthOf(n.nodeId, memo) > limit.maxDepth) {
        issues.push(`graph depth exceeds maxDepth ${limit.maxDepth}`);
        break;
      }
    }
  }

  return issues;
}

export function assertValidGraphSpec(spec: GraphSpec, opts: ValidationOptions): void {
  const issues = validateGraphSpec(spec, opts);
  if (issues.length > 0) {
    throw new GraphError("INVALID_GRAPH", `graph validation failed: ${issues.join("; ")}`, {
      details: { issues: issues.slice(0, 20).join(" | ") },
    });
  }
}

/** Deterministic fingerprint for scheduler determinism assertions. */
export function graphFingerprint(spec: GraphSpec): string {
  return contentHash({
    graphId: spec.graphId,
    graphVersion: spec.graphVersion,
    nodes: spec.nodes.map((n) => ({ id: n.nodeId, deps: n.dependsOn, key: n.concurrencyKey })),
    edges: spec.edges.map((e) => ({ from: e.fromNodeId, to: e.toNodeId, type: e.edgeType })),
  });
}

export type { GraphNodeSpec };
