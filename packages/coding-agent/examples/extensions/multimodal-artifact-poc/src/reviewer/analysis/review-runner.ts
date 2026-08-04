/**
 * Analysis review orchestration (§17): artifact integrity checks, replay
 * comparison, independent verification, semantic digest for the LLM.
 * Numbers never reach the main agent's model content — only a digest of
 * refs and discrepancy codes.
 */
import { ReviewerStore } from "../store.ts";
import { DEFAULT_REQUIRED_CAPABILITIES } from "../code/review-runner.ts";
import type { CanonicalChart } from "./verifier.ts";
import {
  canonicalizeAnalysisResult,
  compareReplay,
  verifyIndependently,
  type AnalysisReviewDigest,
  type CanonicalMetric,
  type Discrepancy,
  type ReplayComparisonInput,
  type VerificationCase,
} from "./verifier.ts";
import type {
  AnalysisProposal,
  ArtifactRef,
  ReviewCheckResult,
  ReviewFinding,
} from "../contracts/index.ts";

/**
 * ReplayOutcome — produced by a REPLAY RUNNER that executes the original
 * analysis script in an isolated reviewer workspace. Callers may supply a
 * runner (execution), never precomputed results: that would let a caller
 * fabricate a replay. Empty outcomes fail (cannot pass).
 */
export interface ReplayOutcome {
  metrics: CanonicalMetric[];
  tables: Array<{ id: string; rows: unknown[] }>;
  charts?: CanonicalChart[];
  status: string;
  /** raw replay artifact payload persisted under reviews/<reviewKey>/ */
  replayResult: Record<string, unknown>;
  replayManifest: Record<string, unknown>;
}

export interface AnalysisReviewInput {
  proposal: AnalysisProposal;
  objective: string;
  /** Executes the original script in the reviewer workspace (isolated). */
  replayRunner: (proposal: AnalysisProposal, workspaceRoot: string) => Promise<ReplayOutcome>;
  /** Deterministic independent recomputation cases (caller-side KPI checks). */
  verificationCases: VerificationCase[];
  /**
   * Capabilities the GATE requires; an unrequired capability is SKIPPED
   * (required=false) instead of a required UNAVAILABLE. Defaults to
   * everything (fail-closed) when omitted.
   */
  requiredCapabilities?: string[];
  /** Artifact section ids available for finding locations (artifactId/sectionId). */
  sectionsMeta?: Array<{ sectionId: string }>;
  /** When absent, the semantic check is UNAVAILABLE -> ABSTAIN (fail closed). */
  semanticReviewer?: (digest: AnalysisReviewDigest) => Promise<
    Array<{ severity: ReviewFinding["severity"]; category: string; claim: string; suggestedAction: string; evidenceRefIds: string[]; location?: ReviewFinding["location"] }>
  >;
}

export class AnalysisReviewRunner {
  readonly store: ReviewerStore;

  constructor(store: ReviewerStore, workspaceRoot = "") {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
  }

  async run(input: AnalysisReviewInput): Promise<{
    checks: ReviewCheckResult[];
    findings: ReviewFinding[];
    replayArtifactRef?: ArtifactRef;
    independentVerificationRef?: ArtifactRef;
  }> {
    const checks: ReviewCheckResult[] = [];
    const findings: ReviewFinding[] = [];
    let replayArtifactRef: ArtifactRef | undefined;
    let independentVerificationRef: ArtifactRef | undefined;

    // artifact integrity: proposal refs must be hash-verifiable in the store
    const integrity = await this._checkArtifacts(input.proposal);
    checks.push(...integrity);
    if (integrity.some((c) => c.status === "FAILED")) {
      return { checks, findings, replayArtifactRef: undefined, independentVerificationRef: undefined };
    }

    // read the ORIGINAL analysis result from the store (never from the caller)
    const original = await this._readOriginalResult(input.proposal);
    if (!original) {
      checks.push(this._check("analysis:original-result", "INTEGRITY", "FAILED",
        "original analysis result artifact missing", [], true));
      return { checks, findings, replayArtifactRef: undefined, independentVerificationRef: undefined };
    }

    // replay: execute the original script in the reviewer workspace
    const replay = await input.replayRunner(input.proposal, this.workspaceRoot);
    const replayEmpty = replay.metrics.length === 0 && replay.tables.length === 0;
    let discrepancies: Array<{ code: string }> = [];
    if (replayEmpty) {
      checks.push(this._check("analysis:replay", "REPLAY", "FAILED",
        "replay produced no metrics/tables — cannot pass on empty replay",
        [], true));
    } else {
      discrepancies = compareReplay({
        originalMetrics: original.metrics,
        replayMetrics: replay.metrics,
        originalTables: original.tables,
        replayTables: replay.tables,
        originalStatus: original.status,
        replayStatus: replay.status,
        originalCharts: original.charts,
        replayCharts: replay.charts,
      });
      checks.push(this._check("analysis:replay", "REPLAY",
        discrepancies.length === 0 ? "PASSED" : "FAILED",
        discrepancies.length === 0 ? "replay consistent" : `${discrepancies.length} discrepancy(ies)`,
        [], true));
      // persist replay artifacts with REAL hashes (never placeholder)
      const replayRef = await this._persistReplayArtifacts(replay);
      replayArtifactRef = replayRef;
    }
    // independent verification (deterministic recomputation)
    const requiredCapabilities = input.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES;
    const ivRequired = requiredCapabilities.includes("independent-verification");
    const verified = verifyIndependently(input.verificationCases);
    const failed = verified.filter((v) => !v.ok);
    // STRICT requires non-empty cases covering replayPolicy.independentMetricIds
    let ivStatus: "PASSED" | "FAILED" | "UNAVAILABLE" | "SKIPPED" = "PASSED";
    let ivSummary = "independent recomputation matches";
    if (!ivRequired) {
      ivStatus = "SKIPPED";
      ivSummary = "independent verification not required by gate";
    } else if (input.verificationCases.length === 0) {
      ivStatus = "UNAVAILABLE";
      ivSummary = "INDEPENDENT_VERIFICATION_EMPTY: STRICT requires verification cases";
    } else {
      const requiredIds = input.proposal.replayPolicy.independentMetricIds ?? [];
      const covered = new Set(input.verificationCases.map((v) => v.metricId));
      const uncovered = requiredIds.filter((id) => !covered.has(id));
      if (uncovered.length > 0) {
        ivStatus = "UNAVAILABLE";
        ivSummary = `INDEPENDENT_VERIFICATION_INCOMPLETE: missing ${uncovered.join(", ")}`;
      } else if (failed.length > 0) {
        ivStatus = "FAILED";
        ivSummary = `${failed.length} independent KPI(s) mismatch`;
      }
    }
    const verifyCheck: ReviewCheckResult = this._check(
      "analysis:independent", "NUMERIC", ivStatus, ivSummary, [], ivRequired,
    );
    checks.push(verifyCheck);
    if (ivStatus === "PASSED" && input.verificationCases.length > 0) {
      independentVerificationRef = await this._persistJsonArtifact(
        "independent-verification", { verified });
    }

    // semantic review: LLM gets ONLY the digest
    const digest: AnalysisReviewDigest = {
      objective: input.objective ?? "",
      analysisType: "data-analysis",
      artifactId: input.proposal.analysisResultRef.artifactId,
      sectionIds: (input.sectionsMeta ?? []).map((sec) => sec.sectionId),
      methods: [],
      assumptions: [],
      limitations: [],
      checkSummaries: checks.map((c) => ({
        checkId: c.checkId, status: c.status, summary: c.summary,
        evidenceRefIds: c.evidenceRefs.map((r) => r.artifactId),
      })),
      findingClaims: [],
      discrepancyCodes: discrepancies.map((d) => d.code),
    };
    let semanticFindings: Array<{
      severity: ReviewFinding["severity"]; category: string; claim: string;
      suggestedAction: string; evidenceRefIds: string[];
      location?: ReviewFinding["location"];
    }> = [];
    const semanticRequired = requiredCapabilities.includes("semantic");
    if (!input.semanticReviewer) {
      checks.push(this._check("analysis:semantic", "SEMANTIC",
        semanticRequired ? "UNAVAILABLE" : "SKIPPED",
        semanticRequired ? "semantic reviewer not configured" : "semantic review not required by gate",
        [], semanticRequired));
    } else {
      try {
        semanticFindings = await input.semanticReviewer(digest);
        checks.push(this._check("analysis:semantic", "SEMANTIC", "PASSED",
          `semantic review produced ${semanticFindings.length} finding(s)`,
          [], semanticRequired));
      } catch {
        checks.push(this._check("analysis:semantic", "SEMANTIC", "UNAVAILABLE",
          "semantic reviewer failed to produce valid findings", [], semanticRequired));
        semanticFindings = [];
      }
      for (const f of semanticFindings) {
        findings.push({
          findingId: `af_${Math.random().toString(16).slice(2, 10)}`,
          severity: f.severity, category: f.category, claim: f.claim,
          evidenceRefs: f.evidenceRefIds.map((id) => ({
            artifactId: id, artifactType: "evidence-ref", contentHash: "" })),
          location: f.location as ReviewFinding["location"],
          suggestedAction: f.suggestedAction,
          deterministic: false,
          confidence: 0.8,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // semantic evidence rule: HIGH/BLOCKER findings must carry evidence refs,
    // and ALL findings may only reference evidence IDs that were provided
    if (input.semanticReviewer) {
      const missingEvidence = semanticFindings.filter(
        (f) => (f.severity === "BLOCKER" || f.severity === "HIGH") && f.evidenceRefIds.length === 0);
      if (missingEvidence.length > 0) {
        checks.push(this._check("analysis:semantic-evidence", "EVIDENCE", "FAILED",
          `${missingEvidence.length} HIGH/BLOCKER semantic finding(s) without evidence`, [], true));
      }
      const allowedEvidence = new Set<string>();
      for (const c of checks) for (const r of c.evidenceRefs) allowedEvidence.add(r.artifactId);
      const unknownEvidence = semanticFindings.filter((f) =>
        (Array.isArray(f.evidenceRefIds) ? f.evidenceRefIds : []).some((id) => !allowedEvidence.has(id)));
      if (unknownEvidence.length > 0) {
        checks.push(this._check("analysis:semantic-evidence", "EVIDENCE", "FAILED",
          `${unknownEvidence.length} semantic finding(s) reference unknown evidence IDs`, [], true));
      }
    }

    return {
      checks,
      findings,
      replayArtifactRef,
      independentVerificationRef,
    };
  }

  /** workspaceRoot for replay execution (must be reviewer-isolated). */
  readonly workspaceRoot: string;

  private async _readOriginalResult(proposal: AnalysisProposal): Promise<{
    metrics: CanonicalMetric[]; tables: Array<{ id: string; rows: unknown[] }>;
    charts: CanonicalChart[]; status: string;
  } | null> {
    const rec = await this.store.read(proposal.analysisResultRef.artifactId);
    if (!rec) return null;
    // real artifact shape: metrics/tables/charts live inside `sections`
    const c = canonicalizeAnalysisResult(rec.content);
    return { metrics: c.metrics, tables: c.tables, charts: c.charts, status: c.status };
  }

  private async _persistReplayArtifacts(replay: ReplayOutcome): Promise<ArtifactRef> {
    const replayResultRef = await this._persistJsonArtifact("replay-result", replay.replayResult);
    await this._persistJsonArtifact("replay-manifest", replay.replayManifest);
    return replayResultRef;
  }

  private async _persistJsonArtifact(name: string, payload: Record<string, unknown>): Promise<ArtifactRef> {
    const dir = `reviews/analysis/${this._runToken()}`;
    await this.store.writeImmutable(`${dir}/${name}.json`, payload);
    const rec = await this.store.read(`${dir}/${name}.json`);
    return {
      artifactId: `${dir}/${name}.json`,
      artifactType: `analysis-${name}`,
      contentHash: rec?.hash ?? "",
    };
  }

  private _runToken(): string {
    return `${Date.now().toString(16)}`;
  }

  private async _checkArtifacts(proposal: AnalysisProposal): Promise<ReviewCheckResult[]> {
    const checks: ReviewCheckResult[] = [];
    const refs: Array<[string, ArtifactRef]> = [
      ["analysis-result", proposal.analysisResultRef],
      ["analysis-plan", proposal.analysisPlanRef],
      ["execution-manifest", proposal.executionManifestRef],
      ["script", proposal.scriptArtifactRef],
    ];
    for (const [name, ref] of refs) {
      const rec = await this.store.read(ref.artifactId);
      const ok = rec !== null && rec.hash === ref.contentHash;
      checks.push(this._check(`analysis:artifact-${name}`, "INTEGRITY",
        ok ? "PASSED" : "FAILED", ok ? "hash matches" : `artifact ${name} missing or hash mismatch`, [ref]));
    }
    return checks;
  }

  private _check(
    checkId: string, checkClass: ReviewCheckResult["checkClass"],
    status: ReviewCheckResult["status"], summary: string,
    evidenceRefs: ArtifactRef[], requiredOverride = true,
  ): ReviewCheckResult {
    return {
      checkId, checkClass, required: requiredOverride, status, summary, evidenceRefs,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 0,
    };
  }
}

/** Convert discrepancies to digest codes (LLM sees codes, not numbers). */
export function discrepanciesToCodes(ds: Discrepancy[]): string[] {
  return ds.map((d) => d.code);
}
