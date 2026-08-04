/**
 * Graph Engine — fake adapters for deterministic core tests (Phase 2).
 * These never touch real modules; they exercise the executor contract.
 */
import { contentHash } from "../canonical.ts";
import type { ArtifactRef } from "../contracts.ts";
import { GraphError } from "../errors.ts";
import type { AdapterContext, AdapterResult, GraphNodeAdapter } from "./types.ts";

export function fakeRef(kind: string, seed: string, nodeId: string): ArtifactRef {
  return {
    artifactId: `art_${contentHash(seed).slice(0, 16)}`,
    artifactType: kind,
    contentHash: contentHash(seed),
    schemaVersion: "1.0",
    createdByNodeId: nodeId,
  };
}

/** Deterministic ok adapter: produces an artifact ref per call. */
export function okAdapter(capabilityId: string, outputType = "dataset"): GraphNodeAdapter {
  return {
    capabilityId,
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      return {
        outputRefs: [fakeRef(outputType, `${capabilityId}:${ctx.node.nodeId}`, ctx.node.nodeId)],
        summary: `${capabilityId} ok`,
      };
    },
  };
}

/** Deterministic failing adapter (non-retryable by default). */
export function failAdapter(capabilityId: string, code: "HASH_MISMATCH" | "RPC_UNAVAILABLE" | "SANDBOX_VIOLATION" = "HASH_MISMATCH"): GraphNodeAdapter {
  return {
    capabilityId,
    execute: async (): Promise<AdapterResult> => {
      throw new GraphError(code, `${capabilityId} failed deterministically`, { retryable: code === "RPC_UNAVAILABLE" });
    },
  };
}

/** Fails the first N calls, then succeeds (retry test). */
export function flakyAdapter(capabilityId: string, failTimes: number): GraphNodeAdapter {
  let calls = 0;
  return {
    capabilityId,
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      calls++;
      if (calls <= failTimes) {
        throw new GraphError("RPC_UNAVAILABLE", "transient", { retryable: true });
      }
      return { outputRefs: [fakeRef("dataset", `flaky:${ctx.runId}:${calls}`, ctx.node.nodeId)] };
    },
  };
}

/** Records invocations (idempotency test). */
export function recordingAdapter(capabilityId: string, log: string[], outputType = "dataset"): GraphNodeAdapter {
  return {
    capabilityId,
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      log.push(`${capabilityId}:${ctx.node.nodeId}`);
      return { outputRefs: [fakeRef(outputType, `${capabilityId}:${ctx.runId}:${ctx.node.nodeId}:${log.length}`, ctx.node.nodeId)] };
    },
  };
}

/** Reviewer fake: emits a decision ref + a verdict ref (DECISION edge). */
export function verdictAdapter(capabilityId: string, verdict: "PASS" | "CHANGES_REQUIRED" | "REJECT" | "ABSTAIN" | "UNREVIEWED_LOW_RISK"): GraphNodeAdapter {
  return {
    capabilityId,
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      return {
        outputRefs: [
          { artifactId: `review_${contentHash(`${ctx.runId}:${ctx.node.nodeId}`).slice(0, 12)}`, artifactType: "review-decision", contentHash: contentHash(verdict), schemaVersion: "1.0", createdByNodeId: ctx.node.nodeId },
          { artifactId: `verdict:${verdict.toLowerCase()}`, artifactType: "verdict", contentHash: contentHash(verdict), schemaVersion: "1.0", createdByNodeId: ctx.node.nodeId },
        ],
        summary: `verdict ${verdict}`,
      };
    },
  };
}

/** Records invocations AND emits a verdict ref (idempotency tests). */
export function recordingVerdictAdapter(capabilityId: string, log: string[], verdict: "PASS" | "REJECT" | "CHANGES_REQUIRED" | "ABSTAIN" = "PASS"): GraphNodeAdapter {
  return {
    capabilityId,
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      log.push(`${capabilityId}:${ctx.node.nodeId}`);
      return {
        outputRefs: [
          { artifactId: `review_${contentHash(`${ctx.runId}:${ctx.node.nodeId}:${log.length}`).slice(0, 12)}`, artifactType: "review-decision", contentHash: contentHash(verdict), schemaVersion: "1.0", createdByNodeId: ctx.node.nodeId },
          { artifactId: `verdict:${verdict.toLowerCase()}`, artifactType: "verdict", contentHash: contentHash(verdict), schemaVersion: "1.0", createdByNodeId: ctx.node.nodeId },
        ],
        summary: `verdict ${verdict}`,
      };
    },
  };
}
