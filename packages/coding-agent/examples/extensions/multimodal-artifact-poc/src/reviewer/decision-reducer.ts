/**
 * Deterministic Decision Reducer (§13).
 *
 * The LLM NEVER chooses the final verdict. It only produces semantic checks
 * and findings; this reducer computes the verdict from deterministic rules:
 *
 *   INTEGRITY failure  -> REJECT
 *   required UNAVAILABLE -> ABSTAIN
 *   required FAILED or BLOCKER/HIGH finding -> CHANGES_REQUIRED
 *   otherwise -> PASS
 *
 * Confidence never overrides a failed deterministic check.
 */
import type { ReviewCheckResult, ReviewFinding, ReviewVerdict } from "./contracts/index.ts";

export interface ReduceInput {
  checks: ReviewCheckResult[];
  findings: ReviewFinding[];
}

export function reduceReviewDecision(input: ReduceInput): ReviewVerdict {
  const { checks, findings } = input;

  const integrityFailure = checks.some(
    (check) => check.required && check.checkClass === "INTEGRITY" && check.status === "FAILED",
  );
  if (integrityFailure) {
    return "REJECT";
  }

  const requiredUnavailable = checks.some(
    (check) => check.required && check.status === "UNAVAILABLE",
  );
  if (requiredUnavailable) {
    return "ABSTAIN";
  }

  const requiredFailed = checks.some(
    (check) => check.required && check.status === "FAILED",
  );
  const blockingFinding = findings.some(
    (finding) => finding.severity === "BLOCKER" || finding.severity === "HIGH",
  );

  if (requiredFailed || blockingFinding) {
    return "CHANGES_REQUIRED";
  }

  return "PASS";
}

/** Machine-readable reason breakdown for auditability. */
export function reduceReason(input: ReduceInput): {
  verdict: ReviewVerdict;
  reasons: string[];
} {
  const reasons: string[] = [];
  const { checks, findings } = input;

  const integrity = checks.filter(
    (c) => c.required && c.checkClass === "INTEGRITY" && c.status === "FAILED",
  );
  if (integrity.length) reasons.push(`integrity failure: ${integrity.map((c) => c.checkId).join(",")}`);

  const unavailable = checks.filter((c) => c.required && c.status === "UNAVAILABLE");
  if (unavailable.length) reasons.push(`required tool unavailable: ${unavailable.map((c) => c.checkId).join(",")}`);

  const failed = checks.filter((c) => c.required && c.status === "FAILED");
  if (failed.length) reasons.push(`required check failed: ${failed.map((c) => c.checkId).join(",")}`);

  const blocking = findings.filter((f) => f.severity === "BLOCKER" || f.severity === "HIGH");
  if (blocking.length) reasons.push(`blocking finding: ${blocking.map((f) => f.findingId).join(",")}`);

  return { verdict: reduceReviewDecision(input), reasons };
}
