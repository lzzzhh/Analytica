/**
 * Evidence Quality Gate v2 — relative quality judgement.
 *
 * v1 lesson (experiment 4): "thin evidence" ≠ "collapsed output". A resume is
 * fact-dense — its core information IS a few facts. Judging it by absolute
 * evidence length (500 chars) misfires. v2 rules:
 *
 *   - The packet's quality is decided by INFORMATION COVERAGE, not length.
 *   - Length is only a fallback: evidenceChars < max(300, documentChars*0.04).
 *   - Short document + enough facts + complete citations → pass even when the
 *     packet is short (marked low_confidence at most, never escalated).
 *   - A deterministic quality score supports best-attempt selection:
 *     schema + fact coverage + citation coverage + answer coverage
 *     - truncation penalty - generic-answer penalty - conflict penalty.
 */

import type { EvidencePacket } from "./evidence.ts";

export interface EvidenceQuality {
  /** Completion tokens of the L1 call (0 when unknown) */
  outputTokens: number;
  /** Total characters of fact values + inference claims (proxy for real content) */
  evidenceChars: number;
  factCount: number;
  /** facts with kind="cited" or kind="parse" (has a source reference) */
  citationCount: number;
  /** ratio of facts carrying an `evidence` source string */
  evidenceCoverage: number;
  /** ratio of facts that carry kind="cited" (source-grounded) */
  citationCoverage: number;
  unresolvedCount: number;
  schemaValid: boolean;
  truncated: boolean;
  emptyOrGeneric: boolean;
  /** facts requested by the question that are covered (proxy: factCount scaled) */
  requiredFieldsCoverage: number;
  /** facts whose value is numeric / clearly numeric strings */
  numericFactCount: number;
  /** duplicate claim with conflicting values inside this packet */
  hasConflictingFacts: boolean;
  /** Deterministic quality score for best-attempt selection */
  qualityScore: number;
  scoreBreakdown: {
    schemaScore: number;
    factCoverageScore: number;
    citationCoverageScore: number;
    answerCoverageScore: number;
    truncationPenalty: number;
    genericAnswerPenalty: number;
    conflictPenalty: number;
  };
}

export type GateVerdict = "pass" | "retry" | "escalate";

/**
 * Deterministic quality score — comparable ACROSS attempts (attempt1 vs
 * attempt2 vs expert), so the orchestrator can keep the best packet instead
 * of blindly using the last one.
 */
export function computeQualityScore(
  packet: EvidencePacket,
  opts: { documentChars: number; truncated: boolean },
): EvidenceQuality["scoreBreakdown"] & { total: number } {
  const facts = packet.facts ?? [];
  const inferences = packet.inferences ?? [];
  const unknowns = packet.unknowns ?? [];
  const schemaValid = facts.length > 0 || inferences.length > 0 || unknowns.length > 0;

  // 1. Schema: packet is structurally usable
  const schemaScore = schemaValid ? 1 : 0;

  // 2. Fact coverage: enough facts for a 3-fact question (5 facts = full marks)
  const factCoverageScore = Math.min(1, facts.length / 5);

  // 3. Citation coverage: grounded facts outweight inferred ones
  const citationCoverage = facts.length
    ? facts.filter((f) => f.kind === "cited" || f.kind === "parse").length / facts.length
    : 0;
  const citationCoverageScore = citationCoverage;

  // 4. Answer coverage: facts present, few unknowns, some inference for synthesis
  const answerCoverageScore =
    (facts.length > 0 ? 0.5 + Math.min(0.3, facts.length / 10) : 0) +
    Math.min(0.2, inferences.length / 3) -
    Math.min(0.2, unknowns.length / 5);

  // 5. Penalties
  const truncationPenalty = opts.truncated ? 0.3 : 0;
  const emptyOrGeneric = facts.length === 0 && (inferences.length === 0 || (inferences.length === 1 && inferences[0]!.claim.length < 60 && unknowns.length === 0));
  const genericAnswerPenalty = emptyOrGeneric ? 0.6 : 0;
  const byClaim = new Map<string, Set<string>>();
  let conflictPenalty = 0;
  for (const f of facts) {
    const v = String(f.value).toLowerCase();
    if (byClaim.has(f.claim.toLowerCase())) {
      if (!byClaim.get(f.claim.toLowerCase())!.has(v)) conflictPenalty = 0.25;
    } else {
      byClaim.set(f.claim.toLowerCase(), new Set([v]));
    }
  }

  return {
    schemaScore,
    factCoverageScore,
    citationCoverageScore,
    answerCoverageScore,
    truncationPenalty,
    genericAnswerPenalty,
    conflictPenalty,
    total: schemaScore + factCoverageScore + citationCoverageScore + answerCoverageScore
      - truncationPenalty - genericAnswerPenalty - conflictPenalty,
  };
}

/**
 * Assess packet quality against deterministic signals.
 */
export function assessEvidenceQuality(
  packet: EvidencePacket,
  opts: { documentChars: number; outputTokens?: number; question?: string },
): EvidenceQuality {
  const facts = packet.facts ?? [];
  const inferences = packet.inferences ?? [];
  const unknowns = packet.unknowns ?? [];

  const evidenceChars = facts.reduce((s, f) => s + String(f.claim).length + String(f.value).length, 0)
    + inferences.reduce((s, i) => s + String(i.claim).length, 0);

  const citationCount = facts.filter((f) => f.kind === "cited" || f.kind === "parse").length;
  const evidenceCoverage = facts.length ? facts.filter((f) => f.evidence).length / facts.length : 0;
  const citationCoverage = facts.length ? citationCount / facts.length : 0;
  const numericFactCount = facts.filter((f) => typeof f.value === "number" || /^[\d.,%]+$/u.test(String(f.value))).length;

  const byClaim = new Map<string, string>();
  let hasConflictingFacts = false;
  for (const f of facts) {
    const key = f.claim.toLowerCase();
    const v = String(f.value).toLowerCase();
    if (byClaim.has(key) && byClaim.get(key) !== v) hasConflictingFacts = true;
    else byClaim.set(key, v);
  }

  const truncated = Boolean(packet.scope?.truncated);
  const scoreBreakdown = computeQualityScore(packet, { documentChars: opts.documentChars, truncated });

  return {
    outputTokens: opts.outputTokens ?? 0,
    evidenceChars,
    factCount: facts.length,
    citationCount,
    evidenceCoverage,
    citationCoverage,
    unresolvedCount: unknowns.length,
    schemaValid: facts.length > 0 || inferences.length > 0 || unknowns.length > 0,
    truncated,
    emptyOrGeneric: facts.length === 0 && (inferences.length === 0 || (inferences.length === 1 && inferences[0]!.claim.length < 60 && unknowns.length === 0)),
    requiredFieldsCoverage: Math.min(1, facts.length / 3),
    numericFactCount,
    hasConflictingFacts,
    qualityScore: scoreBreakdown.total,
    scoreBreakdown,
  };
}

/** Relative minimum evidence length: length is a fallback, not the primary judge */
export function minimumEvidenceChars(documentChars: number): number {
  return Math.max(300, documentChars * 0.04);
}

/**
 * v2 gate decision. Rules (pre-registered):
 *   - agent-declared insufficient/failed / partial+escalation → escalate
 *   - truncated input → escalate (coverage hard signal, not a quality guess)
 *   - schema invalid / empty / generic → retry
 *   - question demands facts but factCount = 0 → retry
 *   - numeric facts with zero citations → retry
 *   - length fallback: below relative minimum AND not (enough facts + complete
 *     citations) → retry; short-but-covered → pass (low confidence at most)
 */
export function decideGate(
  quality: EvidenceQuality,
  packet: EvidencePacket,
  opts: { documentChars: number; shortDocument: boolean },
): GateVerdict {
  // 1. Explicit agent declarations beat heuristics
  if (packet.status === "insufficient" || packet.status === "failed") return "escalate";
  if (packet.status === "partial" && packet.escalation?.required) return "escalate";

  // 2. Truncation is a coverage hard signal
  if (quality.truncated) return "escalate";

  // 3. Degenerate output
  if (!quality.schemaValid || quality.emptyOrGeneric) return "retry";

  // 4. Question asked for facts but none extracted
  if (quality.factCount === 0) return "retry";

  // 5. Numeric facts without any source grounding
  if (quality.numericFactCount > 0 && quality.citationCount === 0) return "retry";

  // 6. Length is only a fallback: below relative minimum → check coverage.
  //    Facts + complete citations mean the packet is thin but complete —
  //    information coverage decides, not length. (v1's 500-char misfire.)
  if (quality.evidenceChars < minimumEvidenceChars(opts.documentChars)) {
    if (quality.factCount >= 2 && quality.citationCoverage >= 0.6) return "pass"; // thin-but-covered
    return "retry";
  }

  return "pass";
}

/** Human-readable reason for logging / diagnostics */
export function gateReason(verdict: GateVerdict, quality: EvidenceQuality, packet: EvidencePacket, opts?: { documentChars: number }): string {
  if (verdict === "pass") {
    if (opts && quality.evidenceChars < minimumEvidenceChars(opts.documentChars)) return "pass_thin_but_covered";
    return "pass";
  }
  if (packet.status === "insufficient") return `escalate:agent_declared_insufficient(${packet.failureReason ?? "?"})`;
  if (packet.status === "failed") return "escalate:agent_failed";
  if (packet.status === "partial" && packet.escalation?.required) return "escalate:agent_escalation_request";
  if (quality.truncated) return "escalate:truncated_input";
  if (!quality.schemaValid) return "retry:schema_invalid";
  if (quality.emptyOrGeneric) return "retry:empty_or_generic";
  if (quality.factCount === 0) return "retry:no_facts";
  if (quality.numericFactCount > 0 && quality.citationCount === 0) return "retry:no_citations";
  if (quality.evidenceChars < minimumEvidenceChars(opts?.documentChars ?? 0)) return "retry:evidence_below_relative_min";
  return "pass";
}
