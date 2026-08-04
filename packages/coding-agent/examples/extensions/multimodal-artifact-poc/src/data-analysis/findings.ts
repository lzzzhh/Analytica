/**
 * Findings — structured findings produced by the script; the main agent
 * never derives findings from numbers. Findings carry evidenceRefs that point
 * at frontend-visible values/charts instead of copying numbers.
 */
import type { AnalysisFinding } from "./contracts.ts";

export interface FindingsFile {
  schemaVersion: string;
  runId: string;
  findings: AnalysisFinding[];
}

export function validateFindings(raw: unknown): { valid: boolean; findings: AnalysisFinding[]; issues: string[] } {
  const issues: string[] = [];
  if (raw === null || typeof raw !== "object") {
    return { valid: false, findings: [], issues: ["findings file is not an object"] };
  }
  const f = raw as Partial<FindingsFile>;
  if (!Array.isArray(f.findings)) {
    return { valid: false, findings: [], issues: ["findings must be an array"] };
  }
  const findings: AnalysisFinding[] = [];
  const seen = new Set<string>();
  for (const item of f.findings) {
    const x = item as Partial<AnalysisFinding>;
    if (typeof x.findingId !== "string" || seen.has(x.findingId)) {
      issues.push(`finding with missing/duplicate findingId`);
      continue;
    }
    if (typeof x.claim !== "string" || !x.claim) {
      issues.push(`finding ${x.findingId}: claim missing`);
      continue;
    }
    if ((x as { causalClaim?: boolean }).causalClaim === true) {
      issues.push(`finding ${x.findingId}: causalClaim must be false in round 4`);
      continue;
    }
    seen.add(x.findingId);
    findings.push({
      findingId: x.findingId,
      code: typeof x.code === "string" ? x.code : "UNKNOWN",
      claim: x.claim,
      category: (x.category ?? "DATA_LIMITATION") as AnalysisFinding["category"],
      direction: x.direction as AnalysisFinding["direction"],
      severity: (x.severity ?? "INFO") as AnalysisFinding["severity"],
      evidenceRefs: Array.isArray(x.evidenceRefs) ? x.evidenceRefs : [],
      method: typeof x.method === "string" ? x.method : "",
      confidence: typeof x.confidence === "number" ? Math.min(1, Math.max(0, x.confidence)) : 0,
      limitations: Array.isArray(x.limitations) ? x.limitations : [],
      causalClaim: false,
    });
  }
  return { valid: issues.length === 0, findings, issues };
}
