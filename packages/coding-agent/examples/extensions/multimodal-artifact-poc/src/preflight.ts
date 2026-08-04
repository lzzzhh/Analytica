/**
 * Static risk preflight for document analysis.
 *
 * Computes a risk score BEFORE the L1 agent runs, so clearly-over-budget tasks
 * go straight to the expert path ("pre-route"), while borderline tasks start on
 * the standard path and may escalate at runtime.
 */

export type RouteDecision = "expert-direct" | "standard" | "standard-with-escalation-risk";

export interface PreflightResult {
  route: RouteDecision;
  riskScore: number;
  estimatedTokens: number;
  chapterCount: number;
  tableCount: number;
  pageCount: number;
  reasons: string[];
}

/** Safe context budget for the L1 agent (fraction of model context window). */
export const SAFE_CONTEXT_BUDGET = 6000; // tokens — leaves room for system prompt, question, output

const HEADING_RE = /^#{1,3}\s/u;
const TABLE_LINE_RE = /^\s*\|.*\|\s*$/u;
const PAGE_RE = /\f/gu;

export function preflight(documentText: string, documentId: string): PreflightResult {
  const estimatedTokens = Math.ceil(documentText.length / 3.5); // zh-heavy docs ≈ 3.5 chars/token
  const lines = documentText.split("\n");
  const chapterCount = lines.filter((l) => HEADING_RE.test(l)).length;
  const tableCount = lines.filter((l) => TABLE_LINE_RE.test(l)).length;
  const pageCount = Math.max(1, documentText.split(PAGE_RE).length);
  const reasons: string[] = [];

  let riskScore = 0;

  // Hard signals
  if (estimatedTokens > SAFE_CONTEXT_BUDGET) {
    riskScore += 40;
    reasons.push(`CONTEXT_BUDGET_EXCEEDED (${estimatedTokens} tok > ${SAFE_CONTEXT_BUDGET})`);
  }
  if (estimatedTokens > SAFE_CONTEXT_BUDGET * 2) {
    riskScore += 30;
    reasons.push("LARGE_DOCUMENT (≥2× budget)");
  }

  // Complexity signals
  if (chapterCount > 10) {
    riskScore += 10;
    reasons.push(`HIGH_CHAPTER_COUNT (${chapterCount})`);
  }
  if (tableCount > 15) {
    riskScore += 10;
    reasons.push(`HIGH_TABLE_COUNT (${tableCount})`);
  }
  if (pageCount > 15) {
    riskScore += 5;
    reasons.push(`HIGH_PAGE_COUNT (${pageCount})`);
  }

  let route: RouteDecision;
  if (riskScore >= 50) {
    route = "expert-direct";
    reasons.push("ROUTE: expert-direct");
  } else if (riskScore >= 30) {
    route = "standard-with-escalation-risk";
    reasons.push("ROUTE: standard (escalation likely)");
  } else {
    route = "standard";
    reasons.push("ROUTE: standard");
  }

  return { route, riskScore, estimatedTokens, chapterCount, tableCount, pageCount, reasons };
}
