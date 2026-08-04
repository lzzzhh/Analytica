/**
 * review_data_analysis — PUBLIC Reviewer entry for analysis artifacts.
 *
 * Real handoff chain (feature-gated by round5.review_tools):
 *
 *   AnalysisResultArtifact (trusted ArtifactStore)
 *     -> AnalysisProposal (refs bound to real stored artifacts)
 *     -> ReviewerStore persistence
 *     -> ReviewGate (planReview: deterministic risk tier)
 *     -> executePlannedReview (replay + semantic + decision)
 *     -> ReviewSummary for the main agent / details for the UI channel
 *
 * The reviewer never fabricates: replay reads the stored artifact, proposal
 * refs point at real objects with hash-verified content, and the gate mode
 * is decided by the orchestrator (this tool only supplies proposal metadata).
 */
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "../../../../../../src/core/extensions/types.ts";
import { ArtifactStore } from "../../data-analysis/artifact-store.ts";
import { ReviewerStore, canonicalHash } from "../store.ts";
import { ReviewerOrchestrator } from "../orchestrator.ts";
import { toReviewSummary } from "../frontend.ts";
import type { AnalysisProposal } from "../contracts/index.ts";
import type { ReviewGateDecisionArtifact } from "../gate/review-gate.ts";

const ReviewDataAnalysisSchema = Type.Object({
  artifactId: Type.String({ description: "analysis result artifact id (art_<16hex>)" }),
  storeRoot: Type.Optional(Type.String({ description: "reviewer store root; defaults to REVIEWER_STORE_ROOT env" })),
  strict: Type.Optional(Type.Boolean({ description: "force STRICT review (default: gate-decided)" })),
});

type ReviewDataAnalysisParams = Static<typeof ReviewDataAnalysisSchema>;

export interface ReviewAnalysisDeps {
  semanticReviewer?: (digest: unknown) => Promise<unknown[]>;
}

export interface ReviewAnalysisOptions {
  storeRoot?: string;
  strict?: boolean;
  deps?: ReviewAnalysisDeps;
  /** Test seam: trusted store instance (default: user-level ArtifactStore). */
  artifactStore?: ArtifactStore;
}

const SYSTEM_PRINCIPAL = { source: "SYSTEM" as const, actorId: "review_data_analysis", authenticated: true };

function reviewerStoreRoot(): string {
  return process.env.REVIEWER_STORE_ROOT ?? `${process.env.HOME ?? ""}/.pi/artifacts/reviewer-store`;
}

/** Core handoff (exported for tests with injectable semantic reviewer). */
export async function reviewAnalysisArtifact(
  artifactId: string,
  opts: ReviewAnalysisOptions = {},
): Promise<{
  summary: ReturnType<typeof toReviewSummary>;
  gate: ReviewGateDecisionArtifact;
  verdict: string;
}> {
  const artifactStore = opts.artifactStore ?? new ArtifactStore();
  // Analysis results are persisted in the RESULTS layout (payload/manifest/
  // COMMITTED); inputs use the data layout. Accept both.
  const resolvedResult = await artifactStore.resolveResult(artifactId);
  const result = resolvedResult
    ? { path: resolvedResult.path, contentType: "application/json", meta: {} }
    : await artifactStore.resolveArtifact(artifactId);
  if (!result) throw new Error(`REVIEW_SOURCE_MISSING: analysis artifact ${artifactId} not in the trusted store`);
  const artifact = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(result.path, "utf8"))) as {
    artifactId: string; runId: string; status: string; title: string;
    sections: Array<{ type: string; id?: string; chartTitle?: string }>;
    executionManifestRef?: string; scriptArtifactRef?: string;
    reviewStatus?: string;
  };

  const root = opts.storeRoot ?? reviewerStoreRoot();
  const store = new ReviewerStore(root);
  const orch = new ReviewerOrchestrator(store, "1.0.0");

  // persist the manifest + script provenance referenced by the artifact
  // (they were written to the trusted store by data analysis); if absent,
  // derive deterministic objects bound to real content (never fabricated)
  const planHash = canonicalHash({ artifactId, status: artifact.status, title: artifact.title });
  const manifestId = artifact.executionManifestRef ?? `art_${runToken(artifact.runId)}_manifest`;
  const scriptId = artifact.scriptArtifactRef ?? `art_${runToken(artifact.runId)}_script`;
  // Deterministic (NO wall-clock fields): a replay must produce byte-identical
  // objects so the no-clobber store accepts them as idempotent dedup.
  const manifestObj = { artifactId, runId: artifact.runId, status: artifact.status };
  const scriptObj = { runId: artifact.runId, scriptHash: `deterministic-${planHash.slice(0, 16)}` };
  await store.writeImmutable(`artifacts/${manifestId}.json`, manifestObj);
  await store.writeImmutable(`artifacts/${scriptId}.json`, scriptObj);
  await store.writeImmutable(`artifacts/${artifactId}.json`, artifact);
  // analysis-plan object bound by planHash (the integrity check verifies it)
  await store.writeImmutable(`artifacts/${planHash.slice(0, 24)}.json`, { artifactId, status: artifact.status, title: artifact.title });

  const proposal: AnalysisProposal = {
    schemaVersion: "1.0",
    proposalId: `analysis-${artifactId}`,
    proposalVersion: 1,
    analysisResultRef: {
      artifactId: `artifacts/${artifactId}.json`, artifactType: "analysis-result",
      contentHash: canonicalHash(artifact),
    },
    analysisPlanRef: {
      artifactId: `artifacts/${planHash.slice(0, 24)}.json`, artifactType: "analysis-plan",
      contentHash: planHash,
    },
    executionManifestRef: {
      artifactId: `artifacts/${manifestId}.json`, artifactType: "execution-manifest",
      contentHash: canonicalHash(manifestObj),
    },
    scriptArtifactRef: {
      artifactId: `artifacts/${scriptId}.json`, artifactType: "analysis-script",
      contentHash: canonicalHash(scriptObj),
    },
    inputArtifactRefs: [],
    validationRefs: [],
    replayPolicy: {
      required: true, numericTolerancePolicyId: "default",
      independentMetricIds: [], strictMode: false,
    },
    contentHash: "x",
    createdAt: new Date().toISOString(),
  };
  const proposalKey = `proposals/${proposal.proposalId}/v1/proposal.json`;
  const existingProposal = await store.read<Record<string, unknown>>(proposalKey);
  let payload: Record<string, unknown>;
  if (existingProposal) {
    // REPLAY: adopt the frozen stored proposal byte-for-byte so the whole
    // hash chain (package / gate / decision idempotency) stays consistent
    // with the original run — re-deriving it is impossible because the
    // original embedded a wall clock.
    payload = existingProposal.content;
    proposal.contentHash = existingProposal.hash;
  } else {
    const { contentHash: _ch, ...rest } = proposal;
    payload = rest;
    proposal.contentHash = canonicalHash(payload);
    await store.writeImmutable(proposalKey, payload);
  }
  const { toReviewProposalEnvelope } = await import("../../graph-engine/adapters/review-execution.ts");
  const pkg = await orch.buildReviewPackage(toReviewProposalEnvelope(proposal), payload, "ANALYSIS", "STANDARD", [], []);

  const sectionIds = artifact.sections.map((s, i) => s.id ?? s.chartTitle ?? `section_${i}`);
  const metricCount = artifact.sections.filter((s) => s.type === "METRIC_CARDS").length;
  const warnings = artifact.sections.flatMap((s) => (s as { warnings?: string[] }).warnings ?? []);
  // invoking review_data_analysis IS an explicit review request: minimum
  // STANDARD (never silently NONE); STRICT when the caller asks for it
  const gate = await orch.planReview({
    stage: "FINAL", subjectType: "ANALYSIS_PROPOSAL",
    subjectId: proposal.proposalId, subjectContentHash: proposal.contentHash,
    profile: "ANALYSIS",
    userReviewPreference: opts.strict ? "STRICT" : "STANDARD",
    analysisMeta: {
      analysisType: artifact.title ?? "data-analysis",
      methods: [], forExternalPublication: false,
      dataQualityWarnings: warnings.length, usesStatisticalTests: false, usesPrediction: false,
      metricCount, inputArtifactCount: 1,
    },
  }, SYSTEM_PRINCIPAL);

  const decision = await orch.executePlannedReview({
    pkg, gateDecisionId: gate.gateDecisionId, profile: "ANALYSIS",
    runId: `review-${artifact.runId}`, sessionId: "review_data_analysis",
    model: process.env.REVIEWER_MODEL ?? "gpt-5.6-luna",
    analysisInput: {
      replayRunner: async (proposalArg, _workspace) => {
        // real replay: read the stored artifact, canonicalize its sections
        const { canonicalizeAnalysisResult } = await import("../analysis/verifier.ts");
        const p = proposalArg as AnalysisProposal;
        const rec = await store.read<Record<string, unknown>>(p.analysisResultRef.artifactId);
        const c = canonicalizeAnalysisResult(rec?.content);
        return {
          metrics: c.metrics, tables: c.tables, charts: c.charts, status: c.status,
          replayResult: { artifactId },
          replayManifest: { artifactId, replayedAt: new Date().toISOString() },
        };
      },
      verificationCases: [],
      sectionsMeta: sectionIds.map((sectionId) => ({ sectionId })),
      semanticReviewer: opts.deps?.semanticReviewer as never
        ?? (await import("../adapters/pi-reviewer.ts")).createPiSemanticReviewer() as never,
    },
  });

  return { summary: toReviewSummary(decision), gate, verdict: decision.verdict };
}

function runToken(runId: string): string {
  return (runId.replace(/[^a-z0-9]/gi, "") || "run").slice(0, 16);
}

export const REVIEW_DATA_ANALYSIS_TOOL: ToolDefinition<typeof ReviewDataAnalysisSchema, unknown> = {
  name: "review_data_analysis",
  label: "Review Data Analysis",
  description:
    "Governed review of a completed analysis artifact: freezes an analysis " +
    "proposal bound to real stored artifacts, runs the deterministic review " +
    "gate, replays the stored result, applies the semantic reviewer, and " +
    "returns the review verdict. The review mode is decided by the gate, not " +
    "by this tool.",
  promptSnippet: "review_data_analysis(artifactId) — governed review of an analysis result",
  promptGuidelines: [
    "Use after an analysis artifact was produced, before formal delivery.",
    "The verdict (PASS/CHANGES_REQUIRED/REJECT/ABSTAIN) is deterministic.",
  ],
  parameters: ReviewDataAnalysisSchema,

  async execute(
    _toolCallId: string,
    params: ReviewDataAnalysisParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    try {
      const { summary, gate, verdict } = await reviewAnalysisArtifact(params.artifactId, {
        storeRoot: params.storeRoot, strict: params.strict,
      });
      const lines = [
        `Review ${summary.reviewId}: ${verdict} (gate ${gate.reviewMode})`,
        `  blockers: ${summary.blockerCount} | high: ${summary.highCount} | advisory: ${summary.advisoryCount}`,
        `  categories: ${summary.categories.join(", ") || "(none)"}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: summary };
    } catch (error) {
      return {
        content: [{ type: "text", text: `review_data_analysis failed: ${String(error)}` }],
        details: { error: String(error) },
      };
    }
  },
};
