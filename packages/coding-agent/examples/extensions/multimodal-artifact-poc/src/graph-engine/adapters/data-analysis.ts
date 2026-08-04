/**
 * Graph Engine — Data Analysis adapter (reuses runDataAnalysis untouched).
 *
 * Inputs: dataset ArtifactRefs (trusted store). Outputs: the immutable
 * AnalysisResultArtifact ref. Numbers never enter the graph summary.
 */
import type { ArtifactRef } from "../contracts.ts";
import { GraphError } from "../errors.ts";
import type { AdapterContext, AdapterResult, GraphNodeAdapter } from "./types.ts";
import type { SubagentCaller } from "../../data-analysis/index.ts";

export interface DataAnalysisAdapterDeps {
  store: {
    readInput(artifactId: string): string | null;
    readInputBytes(artifactId: string): Buffer | null;
    writeResult(artifactId: string, json: string): string;
    resolveResult?(artifactId: string): Promise<{ content: string; contentHash: string } | null>;
    getMeta?(artifactId: string): { contentType?: string; masked?: boolean } | null;
  };
  /** Resolves review-finding refs (hash-bound) into revision instructions —
   *  the revised analysis consumes the CONCRETE findings, never a blind
   *  re-run. */
  readFindings?: (findingRefs: Array<{ artifactId: string; contentHash: string }>) => Promise<Array<{ category: string; claim: string; suggestedAction: string }>>;
  subagent: SubagentCaller;
  scriptRunner?: (scriptPath: string, workspace: string, deps: string[]) => Promise<{
    ok: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut?: boolean;
  }>;
  featureSnapshot: { effectiveFeatures: string[] };
}

export function dataAnalysisAdapter(deps: DataAnalysisAdapterDeps): GraphNodeAdapter {
  return {
    capabilityId: "graph.analysis.run",
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      // dataset inputs only (revision finding refs ride along as separate
      // inputs and must never be treated as data)
      const datasetRefs = ctx.inputRefs.filter((r) =>
        r.artifactType === "dataset" || r.artifactType === "verified-dataset");
      if (datasetRefs.length === 0) {
        throw new GraphError("ARTIFACT_MISSING", "analysis node requires dataset artifact inputs", { retryable: false });
      }
      // resolve dataset artifacts through the TRUSTED store only
      const { createHash } = await import("node:crypto");
      const dataRefs = datasetRefs.map((r) => {
        // BINARY read: parquet/arrow must be hashed on original bytes
        const bytes = deps.store.readInputBytes(r.artifactId);
        if (bytes === null) {
          throw new GraphError("HASH_MISMATCH", `input artifact ${r.artifactId} missing or unverifiable`, { retryable: false });
        }
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (r.contentHash && actual !== r.contentHash) {
          throw new GraphError("HASH_MISMATCH", `input artifact ${r.artifactId} content hash mismatch`, { retryable: false });
        }
        // format + masked come from the TRUSTED meta, never guessed;
        // an UNKNOWN content type fails CLOSED (never silently CSV)
        const meta = deps.store.getMeta ? deps.store.getMeta(r.artifactId) : null;
        const contentType = meta?.contentType ?? "";
        const format = contentType.includes("parquet") ? "PARQUET"
          : contentType.includes("csv") ? "CSV"
            : contentType.includes("arrow") ? "ARROW"
              : "";
        if (!format) {
          throw new GraphError("SCHEMA_INVALID", `input artifact ${r.artifactId} has unknown content type '${contentType}' (fail closed)`, { retryable: false });
        }
        if (meta?.masked === undefined) {
          throw new GraphError("SCHEMA_INVALID", `input artifact ${r.artifactId} has no masking meta (fail closed)`, { retryable: false });
        }
        return {
          artifactId: r.artifactId,
          sourceType: "TABULAR_ARTIFACT" as const,
          format: format as "CSV" | "PARQUET" | "ARROW",
          contentHash: r.contentHash,
          masked: meta.masked,
        };
      });
      // analysisType must come from the node metadata and be a valid contract value
      const requestedType = String(ctx.node.metadata["analysisType"] ?? "DESCRIPTIVE");
      const VALID_TYPES = ["DESCRIPTIVE", "TREND", "PERIOD_COMPARISON", "BREAKDOWN", "DISTRIBUTION", "CORRELATION", "STATISTICAL_TEST", "CUSTOM"];
      // the graph analysis node ALWAYS means the full subagent path: CUSTOM
      // keeps the task gate off the QUERY_GATEWAY short-circuit
      const analysisType = VALID_TYPES.includes(requestedType) ? requestedType : "CUSTOM";

      const { runDataAnalysis } = await import("../../data-analysis/index.ts");
      const { ArtifactStore } = await import("../../data-analysis/artifact-store.ts");
      const store = deps.store instanceof ArtifactStore ? deps.store : new ArtifactStore();

      if (ctx.abortSignal?.aborted) {
        throw new GraphError("TIMEOUT", `analysis aborted before start (${ctx.idempotencyKey})`, { retryable: true });
      }
      // REVISION: consume the concrete review findings (the reviewer's
      // hash-bound finding refs) — the revised analysis runs on the SAME
      // data but a REVISED objective, never a blind re-run
      let objective = ctx.node.metadata["objective"] as string ?? "analyze the provided data";
      const findingRefs = ctx.inputRefs.filter((r) => r.artifactType === "review-finding");
      if (findingRefs.length > 0) {
        if (!deps.readFindings) {
          throw new GraphError("CAPABILITY_UNAVAILABLE", "revision requires the host to resolve review findings", { retryable: false });
        }
        const findings = await deps.readFindings(findingRefs);
        if (findings.length === 0) {
          throw new GraphError("REVIEW_BLOCKED", "revision finding refs do not resolve to findings", { retryable: false });
        }
        const revisionNote = findings.map((f) => `[${f.category}] ${f.claim} (${f.suggestedAction})`).join("; ");
        objective = `${objective} — REVISION ROUND ${ctx.state.revisionCycles ?? 0}: address: ${revisionNote}`;
      }
      const out = await runDataAnalysis({
        objective,
        analysisType: analysisType as never,
        dataRefs,
        // the graph analysis node is the FULL subagent path: a chart view
        // keeps the task gate off the QUERY_GATEWAY short-circuit
        expectedViews: ["METRIC_CARDS", "LINE_CHART"],
        constraints: { timeoutSeconds: 180, maxAttempts: 1 },
      }, {
        snapshot: deps.featureSnapshot,
        store,
        subagent: deps.subagent,
        defaultTimeoutSeconds: 180,
        // STABLE run id (runId/nodeId) so a retry reuses the SAME artifacts
        // instead of duplicating them; a feedback revision bumps the cycle
        // so the revised analysis produces a NEW result artifact
        runId: `graph-${ctx.idempotencyKey.replace(/[/@]/g, "_")}-r${(ctx.state.revisionCycles ?? 0)}`,
        abortSignal: ctx.abortSignal,
      } as never);

      if (out.failure) {
        throw new GraphError(
          out.failure.errorCode === "SANDBOX_VIOLATION" ? "SANDBOX_VIOLATION"
            : out.failure.errorCode === "EXECUTION_TIMEOUT" ? "TIMEOUT"
              : "SCHEMA_INVALID",
          `analysis failed: ${out.failure.errorCode ?? ""}: ${out.failure.message}`,
          { retryable: out.failure.retryable && out.failure.errorCode !== "SANDBOX_VIOLATION" },
        );
      }
      if (!out.artifact) {
        throw new GraphError("SCHEMA_INVALID", "analysis produced no artifact", { retryable: false });
      }
      const resultRef: ArtifactRef = {
        artifactId: out.artifact.artifactId,
        artifactType: "analysis-result",
        contentHash: "",
        schemaVersion: "1.0",
        createdByNodeId: ctx.node.nodeId,
      };
      // resolve the REAL result artifact (results/... not inputs/...) and
      // verify its content hash (mandatory)
      const resolved = deps.store.resolveResult
        ? await deps.store.resolveResult(out.artifact.artifactId)
        : null;
      if (!resolved) {
        throw new GraphError("HASH_MISMATCH", `analysis result ${out.artifact.artifactId} not resolvable`, { retryable: false });
      }
      if (createHash("sha256").update(resolved.content).digest("hex") !== resolved.contentHash) {
        throw new GraphError("HASH_MISMATCH", `analysis result ${out.artifact.artifactId} hash mismatch`, { retryable: false });
      }
      resultRef.contentHash = resolved.contentHash;
      return {
        outputRefs: [resultRef],
        summary: `analysis artifact ${resultRef.artifactId} (status ${out.artifact.status})`,
      };
    },
  };
}
