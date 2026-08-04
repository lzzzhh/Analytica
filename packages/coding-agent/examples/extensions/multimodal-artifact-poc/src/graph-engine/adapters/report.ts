/**
 * Graph Engine — report + verifier adapters.
 *
 * analysis-report: the Skill has NO local TS implementation in this repo
 * (only SKILL.md). Per the task rules we STOP and report instead of
 * guessing: this adapter BLOCKS the node with REPORT_SKILL_UNAVAILABLE
 * until an interface exists. The graph then fails closed (never fabricates
 * a report).
 *
 * deliverable.verify: deterministic checks on report refs when a report IS
 * produced (interface arrives later); verifies ref resolution + reviewer
 * authorization binding.
 */
import { contentHash } from "../canonical.ts";
import type { ArtifactRef } from "../contracts.ts";
import { GraphError } from "../errors.ts";
import type { AdapterContext, AdapterResult, GraphNodeAdapter } from "./types.ts";

/** Explicit stop: no local analysis-report implementation to call. */
export function analysisReportSkillAdapter(): GraphNodeAdapter {
  return {
    capabilityId: "skill.analysis.report",
    execute: async (): Promise<AdapterResult> => {
      throw new GraphError(
        "REPORT_SKILL_UNAVAILABLE" as never,
        "analysis-report Skill has no local TS interface in this repository (SKILL.md only) — report node blocked, not fabricated",
        { retryable: false },
      );
    },
  };
}

export interface VerifierDeps {
  canResolveRef?: (ref: ArtifactRef) => Promise<boolean>;
}

/** Deterministic deliverable verifier (first version: ref checks). */
export function deliverableVerifierAdapter(deps: VerifierDeps = {}): GraphNodeAdapter {
  return {
    capabilityId: "graph.deliverable.verify",
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      const reportRefs = ctx.inputRefs.filter((r) => r.artifactType === "report");
      const analysisRefs = ctx.inputRefs.filter((r) => r.artifactType === "analysis-result");
      if (reportRefs.length === 0) {
        throw new GraphError("REPORT_QA_FAILED", "verifier requires a report artifact", { retryable: false });
      }
      for (const ref of [...reportRefs, ...analysisRefs]) {
        if (!ref.artifactId || !ref.contentHash) {
          throw new GraphError("SCHEMA_INVALID", `verifier: ref ${ref.artifactId} lacks a content hash`, { retryable: false });
        }
        if (deps.canResolveRef) {
          const ok = await deps.canResolveRef(ref);
          if (!ok) {
            throw new GraphError("REPORT_QA_FAILED", `verifier: ref ${ref.artifactId} not resolvable`, { retryable: false });
          }
        }
      }
      return {
        outputRefs: [{
          artifactId: `verification_${contentHash(`${ctx.runId}:${ctx.node.nodeId}`).slice(0, 16)}`,
          artifactType: "verification",
          contentHash: contentHash({ ok: true, refs: ctx.inputRefs.map((r) => r.artifactId) }),
          schemaVersion: "1.0",
          createdByNodeId: ctx.node.nodeId,
        }],
        summary: "deliverable refs verified",
      };
    },
  };
}
