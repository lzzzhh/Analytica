/**
 * Reviewer policy — builds a ReviewPolicySnapshot with a canonical hash.
 * The snapshot freezes the check profile, level and severity rules so a
 * review is bound to the exact policy that produced it (§9, §19).
 */
import { canonicalHash } from "./contracts/index.ts";
import type {
  ReviewLevel,
  ReviewPolicySnapshot,
  ReviewProfile,
} from "./contracts/index.ts";

export interface PolicySpec {
  policyVersion: string;
  profile: ReviewProfile;
  reviewLevel: ReviewLevel;
  requiredChecks: string[];
  advisoryChecks: string[];
  severityRules: Record<string, string>;
}

export function buildPolicySnapshot(spec: PolicySpec): ReviewPolicySnapshot {
  const snapshot: ReviewPolicySnapshot = {
    policyVersion: spec.policyVersion,
    profile: spec.profile,
    reviewLevel: spec.reviewLevel,
    requiredChecks: [...spec.requiredChecks],
    advisoryChecks: [...spec.advisoryChecks],
    severityRules: { ...spec.severityRules },
    contentHash: "",
  };
  // hash over the frozen fields (contentHash excluded to avoid self-reference)
  const { contentHash: _omit, ...body } = snapshot;
  snapshot.contentHash = canonicalHash(body);
  return snapshot;
}

/** Default severity rules per profile (category -> severity). */
export const DEFAULT_SEVERITY_RULES: Record<string, string> = {
  INTEGRITY: "BLOCKER",
  SCHEMA: "HIGH",
  REPLAY: "HIGH",
  NUMERIC: "HIGH",
  SECURITY: "BLOCKER",
  TESTING: "MEDIUM",
  METHODOLOGY: "MEDIUM",
  EVIDENCE: "HIGH",
  SEMANTIC: "MEDIUM",
  COMPATIBILITY: "HIGH",
  PERFORMANCE: "MEDIUM",
  REQUIREMENT: "HIGH",
  EXECUTION: "HIGH",
};
