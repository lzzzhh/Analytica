/**
 * Reviewer frontend + tool wiring (Phase 6).
 *
 * The MAIN agent only ever receives a ReviewSummary (refs/status). Full
 * details (findings, checks, timeline) go through the UI-only details
 * channel; analysis numbers never reach the main agent's model content.
 */
import type {
  EffectiveReviewStatus,
  ReviewDecisionArtifact,
  ReviewFinding,
  ReviewSummary,
  ReviewVerdict,
} from "./contracts/index.ts";

export function toReviewSummary(decision: ReviewDecisionArtifact): ReviewSummary {
  const blocking = decision.blockingFindings;
  const high = blocking.filter((f) => f.severity === "HIGH");
  const advisory = decision.advisoryFindings;
  const categories = new Set<string>();
  for (const f of [...blocking, ...advisory]) categories.add(f.category);
  return {
    reviewId: decision.reviewId,
    proposalId: decision.proposalId,
    verdict: decision.verdict,
    blockerCount: blocking.filter((f) => f.severity === "BLOCKER").length,
    highCount: high.length,
    advisoryCount: advisory.length,
    categories: [...categories],
    findingRefs: [...blocking, ...advisory].map((f) => f.findingId),
    displayedDirectly: true,
  };
}

/** Derive the UI-facing status without mutating the original artifact. */
export function effectiveStatus(verdict: ReviewVerdict | "NOT_REVIEWED"): EffectiveReviewStatus {
  switch (verdict) {
    case "PASS": return "PASSED";
    case "CHANGES_REQUIRED": return "CHANGES_REQUIRED";
    case "REJECT": return "REJECTED";
    case "ABSTAIN": return "ABSTAINED";
    default: return "NOT_REVIEWED";
  }
}

/** UI-only details payload (renderResult channel — never model content). */
export function reviewDetails(decision: ReviewDecisionArtifact): {
  dashboardType: "REVIEW";
  decision: ReviewDecisionArtifact;
} {
  return { dashboardType: "REVIEW", decision };
}

/** Findings flattened for the UI with location + evidence (no raw numbers). */
export function findingDetails(findings: ReviewFinding[]): Array<{
  findingId: string;
  severity: string;
  category: string;
  claim: string;
  location?: ReviewFinding["location"];
  evidenceRefIds: string[];
  suggestedAction: string;
}> {
  return findings.map((f) => ({
    findingId: f.findingId,
    severity: f.severity,
    category: f.category,
    claim: f.claim,
    location: f.location,
    evidenceRefIds: f.evidenceRefs.map((r) => r.artifactId),
    suggestedAction: f.suggestedAction,
  }));
}
