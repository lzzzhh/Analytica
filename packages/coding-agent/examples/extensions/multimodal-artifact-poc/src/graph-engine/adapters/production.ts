/**
 * Graph Engine — production adapters (real logic, no fakes).
 *
 *   graph.governance.preflight : verifies every dataset input resolves
 *                                through the trusted store with hash
 *                                verification; emits verified-dataset refs.
 *   graph.analysis.fan_in      : aggregates the analysis result + evidence
 *                                verification refs into a proposal ref.
 *   resolveEvidence()          : resolves the REAL analysis evidence set
 *                                (result + plan + manifest + script) from
 *                                the trusted ArtifactStore; missing real
 *                                evidence -> null (callers fail closed).
 */
import { contentHash } from "../canonical.ts";
import type { ArtifactRef } from "../contracts.ts";
import { GraphError } from "../errors.ts";
import type { AdapterContext, AdapterResult, GraphNodeAdapter } from "./types.ts";
import type { AnalysisEvidenceRefs } from "./review-execution.ts";

/** Preflight: REAL governance before analysis, not just a hash gate.
 *
 *  Every dataset input must pass (fail closed on any miss):
 *   1. resolvable through the trusted store          -> HASH_MISMATCH
 *   2. content hash matches the ref                  -> HASH_MISMATCH
 *   3. contentType is known (never guessed)          -> SCHEMA_INVALID
 *   4. masking meta present; sensitive data MUST be masked
 *        (masked=false + sensitive -> MASKING_REQUIRED); an external-report
 *        purpose additionally REQUIRES masked data   -> MASKING_REQUIRED
 *   5. provenance: queryId/snapshotId/lineage        -> LINEAGE_MISSING
 *   6. principal authenticated                       -> PERMISSION_DENIED
 *   7. allowedColumns (node metadata) subset of the
 *        registered columns                          -> SCHEMA_MISMATCH
 */
export function preflightGovernanceAdapter(deps: {
  resolveArtifact: (artifactId: string) => Promise<{ contentHash?: string; meta: Record<string, unknown> } | null>;
  /** Default true: external reports may never analyze unmasked data. */
  requireMaskingForExternalReport?: boolean;
}): GraphNodeAdapter {
  const requireMasking = deps.requireMaskingForExternalReport ?? true;
  return {
    capabilityId: "graph.governance.preflight",
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      if (!ctx.principal.authenticated) {
        throw new GraphError("PERMISSION_DENIED", "preflight requires an authenticated principal", { retryable: false });
      }
      const datasets = ctx.inputRefs.filter((r) => r.artifactType === "dataset");
      if (datasets.length === 0) {
        throw new GraphError("ARTIFACT_MISSING", "preflight requires dataset inputs", { retryable: false });
      }
      const purpose = String(ctx.node.metadata["purpose"] ?? "internal-analysis");
      const allowedColumns = (ctx.node.metadata["allowedColumns"] as string | undefined)
        ?.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
      const verified: ArtifactRef[] = [];
      for (const r of datasets) {
        const rec = await deps.resolveArtifact(r.artifactId);
        if (!rec) {
          throw new GraphError("HASH_MISMATCH", `preflight: dataset ${r.artifactId} not resolvable`, { retryable: false });
        }
        // content hash lives in the trusted meta (top-level field may not exist)
        const meta = rec.meta as Record<string, unknown>;
        const actualHash = typeof meta.contentHash === "string" && /^[a-f0-9]{64}$/.test(meta.contentHash)
          ? meta.contentHash : rec.contentHash ?? "";
        if (!actualHash) {
          throw new GraphError("HASH_MISMATCH", `preflight: dataset ${r.artifactId} has no verifiable hash`, { retryable: false });
        }
        if (r.contentHash && actualHash !== r.contentHash) {
          throw new GraphError("HASH_MISMATCH", `preflight: dataset ${r.artifactId} content hash mismatch`, { retryable: false });
        }
        // contentType must be KNOWN (never defaulted to CSV)
        const contentType = typeof meta.contentType === "string" ? meta.contentType : "";
        if (!contentType || !/(csv|parquet|arrow|json)/i.test(contentType)) {
          throw new GraphError("SCHEMA_INVALID", `preflight: dataset ${r.artifactId} has unknown contentType '${contentType}' (fail closed)`, { retryable: false });
        }
        // masking semantics: sensitive inputs must be masked; external
        // reports require masked data even without a sensitive flag
        const masked = typeof meta.masked === "boolean" ? meta.masked : undefined;
        if (masked === undefined) {
          throw new GraphError("MASKING_REQUIRED", `preflight: dataset ${r.artifactId} has no masking meta (fail closed)`, { retryable: false });
        }
        const sensitive = meta.sensitive === true;
        if (sensitive && !masked) {
          throw new GraphError("MASKING_REQUIRED", `preflight: dataset ${r.artifactId} is sensitive but NOT masked`, { retryable: false });
        }
        if (purpose === "external-report" && requireMasking && !masked) {
          throw new GraphError("MASKING_REQUIRED", `preflight: dataset ${r.artifactId} is unmasked but the graph produces an external report`, { retryable: false });
        }
        // provenance: the dataset must be traceable to a query/snapshot/lineage.
        // A FORMAL (external) report additionally requires an IMMUTABLE
        // snapshot AND a query/source reference — a bare queryId is not a
        // stable provenance for a published deliverable
        const hasQuery = typeof meta.queryId === "string" && meta.queryId.length > 0;
        const hasSnapshot = typeof meta.snapshotId === "string" && meta.snapshotId.length > 0;
        const hasLineage = typeof meta.lineageReference === "string" && meta.lineageReference.length > 0;
        const hasProvenance = hasQuery || hasSnapshot || hasLineage;
        if (!hasProvenance) {
          throw new GraphError("LINEAGE_MISSING", `preflight: dataset ${r.artifactId} has no query/snapshot/lineage provenance`, { retryable: false });
        }
        if (purpose === "external-report" && (!hasSnapshot || !(hasQuery || hasLineage))) {
          throw new GraphError("LINEAGE_MISSING", `preflight: dataset ${r.artifactId} needs an immutable snapshot + query/source provenance for an external report`, { retryable: false });
        }
        // column allowlist (optional policy, fail closed on violation)
        if (allowedColumns && allowedColumns.length > 0) {
          const columns = Array.isArray(meta.columns) ? meta.columns.map(String) : [];
          const unknown = allowedColumns.filter((c) => !columns.includes(c));
          if (unknown.length > 0) {
            throw new GraphError("SCHEMA_MISMATCH", `preflight: dataset ${r.artifactId} lacks allowed columns: ${unknown.join(", ")}`, { retryable: false });
          }
        }
        // derived ref: owned by the PREFLIGHT node (origin preserved)
        verified.push({
          ...r,
          artifactType: "verified-dataset",
          createdByNodeId: ctx.node.nodeId,
          originArtifactId: r.artifactId,
          originCreatedBy: r.createdByNodeId,
        });
      }
      return {
        outputRefs: verified,
        summary: `preflight verified ${verified.length} dataset(s) (${purpose})`,
      };
    },
  };
}

/** Fan-in: aggregates the analysis result into a proposal ref for the gate. */
export function fanInAdapter(): GraphNodeAdapter {
  return {
    capabilityId: "graph.analysis.fan_in",
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      const result = ctx.inputRefs.find((r) => r.artifactType === "analysis-result")
        ?? ctx.inputRefs.find((r) => r.artifactType === "dataset");
      if (!result) {
        throw new GraphError("ARTIFACT_MISSING", "fan-in requires the analysis result", { retryable: false });
      }
      // the proposal ref carries the result identity; the reviewer resolves
      // the full real evidence set from it
      const proposalRef: ArtifactRef = {
        artifactId: result.artifactId,
        artifactType: "proposal",
        contentHash: result.contentHash,
        schemaVersion: "1.0",
        createdByNodeId: ctx.node.nodeId,
      };
      return {
        outputRefs: [proposalRef, result],
        summary: `fan-in: ${ctx.inputRefs.length} evidence input(s)`,
      };
    },
  };
}

/** Trusted store surface needed for evidence resolution. */
export interface EvidenceStoreLike {
  resolveResult(artifactId: string): Promise<{ content: string; contentHash: string } | null>;
  resolveArtifact?(artifactId: string): Promise<{ contentHash?: string; meta: Record<string, unknown> } | null>;
}

/** Real evidence resolution from the trusted ArtifactStore. */
export async function resolveEvidenceFromStore(
  artifactId: string,
  store?: EvidenceStoreLike,
): Promise<AnalysisEvidenceRefs | null> {
  if (!store) {
    const { ArtifactStore } = await import("../../data-analysis/artifact-store.ts");
    store = new ArtifactStore();
  }
  const result = await store.resolveResult(artifactId);
  if (!result) return null;
  let artifact: {
    executionManifestRef?: string;
    scriptArtifactRef?: string;
    analysisPlanRef?: string;
    inputManifestRef?: string;
    validationRefs?: Array<{ artifactId: string }>;
  };
  try {
    artifact = JSON.parse(result.content) as typeof artifact;
  } catch {
    return null;
  }
  const refFor = async (id: string | undefined, type: string): Promise<ArtifactRef | null> => {
    if (!id) return null;
    const rec = await store.resolveResult(id);
    if (!rec) return null;
    return {
      artifactId: id, artifactType: type, contentHash: rec.contentHash,
      schemaVersion: "1.0", createdByNodeId: "data-analysis",
    };
  };
  const resultRef: ArtifactRef = {
    artifactId, artifactType: "analysis-result", contentHash: result.contentHash,
    schemaVersion: "1.0", createdByNodeId: "data-analysis",
  };
  const planRef = await refFor(artifact.analysisPlanRef, "analysis-plan");
  const manifestRef = await refFor(artifact.executionManifestRef, "execution-manifest");
  const scriptRef = await refFor(artifact.scriptArtifactRef, "analysis-script");
  const inputManifestRef = artifact.inputManifestRef
    ? await refFor(artifact.inputManifestRef, "input-manifest")
    : null;
  // ALL real evidence must exist — otherwise fail closed (ABSTAIN semantics)
  if (!planRef || !manifestRef || !scriptRef) return null;
  if (artifact.inputManifestRef && !inputManifestRef) return null;
  // REAL input artifacts: the execution manifest records the inputs the
  // script actually consumed; each must resolve (inputs/ or results/) with
  // a verified content hash — the reviewer's computation replay executes on
  // THESE frozen bytes
  const inputArtifactRefs: ArtifactRef[] = [];
  if (manifestRef) {
    const manifestRec = await store.resolveResult(manifestRef.artifactId);
    if (manifestRec) {
      try {
        const manifest = JSON.parse(manifestRec.content) as {
          inputArtifacts?: Array<{ artifactId?: string; contentHash?: string }>;
        };
        for (const inp of manifest.inputArtifacts ?? []) {
          if (!inp.artifactId) continue;
          const rec = await store.resolveResult(inp.artifactId)
            ?? (store.resolveArtifact ? await store.resolveArtifact(inp.artifactId).then((r) => r
              ? { content: "", contentHash: typeof r.meta.contentHash === "string" ? r.meta.contentHash : (r.contentHash ?? "") }
              : null) : null);
          if (!rec) return null; // an input the script consumed is missing -> fail closed
          // TOCTOU guard: the manifest records the hash the ANALYSIS saw;
          // if the store now holds different bytes for the same id, the
          // evidence set is INVALID (ABSTAIN) — never bind a newer version
          if (inp.contentHash && rec.contentHash !== inp.contentHash) {
            return null;
          }
          inputArtifactRefs.push({
            artifactId: inp.artifactId, artifactType: "dataset",
            contentHash: inp.contentHash ?? rec.contentHash, schemaVersion: "1.0", createdByNodeId: "data-analysis",
          });
        }
      } catch {
        return null;
      }
    }
  }
  // REAL validation refs from the result artifact
  const validationRefs: ArtifactRef[] = [];
  for (const v of artifact.validationRefs ?? []) {
    const rec = await store.resolveResult(v.artifactId);
    if (!rec) return null;
    validationRefs.push({
      artifactId: v.artifactId, artifactType: "validation-ref",
      contentHash: rec.contentHash, schemaVersion: "1.0", createdByNodeId: "data-analysis",
    });
  }
  return {
    analysisResultRef: resultRef,
    analysisPlanRef: planRef,
    executionManifestRef: manifestRef,
    scriptArtifactRef: scriptRef,
    inputManifestRef: inputManifestRef ?? undefined,
    inputArtifactRefs,
    validationRefs,
  };
}
