/**
 * Evidence Packet schema + deterministic Evidence Merger.
 *
 * Two agent tiers (standard/expert) each produce an EvidencePacket for their
 * assigned scope. The merger combines them deterministically:
 *   raw evidence > deterministic parse results > cited model facts > uncited model inferences
 * NOT "expert beats standard". Conflicts are surfaced as `requires_verification`.
 */

export type AgentTier = "standard" | "expert";

/**
 * How a fact was obtained (extended for lakehouse data tools, backward
 * compatible — the original three kinds are unchanged):
 *   parse      — raw OCR / table extraction (deterministic)
 *   cited      — from document text with a source reference
 *   inferred   — model guess
 *   query      — deterministic lakehouse query result (highest priority)
 *   quality    — data-quality assessment result
 *   lineage    — lineage lookup result
 *   snapshot   — snapshot/metadata lookup result
 *   governance — deterministic CDXR governance finding/profile (spec: above cited)
 */
export type EvidenceSourceType = "parse" | "cited" | "inferred" | "query" | "quality" | "lineage" | "snapshot" | "governance";

/** Provenance metadata for query-backed facts (spec §9) */
export interface QueryFactMetadata {
  datasetId: string;
  snapshotId?: string | number;
  dataVersion?: string;
  dataTimestamp?: string;
  qualityStatus?: string;
  queryId?: string;
  lineageReference?: string;
}

/** Provenance metadata for CDXR governance-backed facts (spec §11) */
export interface GovernanceFactMetadata extends QueryFactMetadata {
  findingId?: string;
  runId?: string;
  ruleId?: string;
  severity?: string;
  reviewStatus?: string;
  governanceScore?: number;
  evidenceReferences?: string[];
  qualityReference?: string;
}

export interface EvidenceFact {
  claim: string;
  value: string | number;
  /** Source reference, e.g. "doc p.12" or "ocr" or "table" or "query:q_123" — empty means uncited */
  evidence?: string;
  confidence: number;
  /** How the fact was obtained: raw OCR/table = parse, from document text = cited,
   *  model guess = inferred, deterministic query = query, etc. */
  kind: EvidenceSourceType;
  /** Provenance for data-source facts (dataset/snapshot/quality) */
  metadata?: QueryFactMetadata;
}

export interface EvidenceInference {
  claim: string;
  confidence: number;
}

export type EscalationReasonCode =
  | "CONTEXT_BUDGET_EXCEEDED"
  | "INPUT_TRUNCATED"
  | "REQUIRED_PAGES_MISSING"
  | "CROSS_DOCUMENT_REASONING"
  | "LOW_CONFIDENCE"
  | "CONFLICTING_CLAIMS"
  | "UNRESOLVED_QUESTIONS"
  | "HIGH_COMPLEXITY";

export interface EscalationRequest {
  required: boolean;
  reasonCodes: EscalationReasonCode[];
  /** What the expert should look at — NOT the whole document */
  scope: {
    documentId: string;
    pages?: number[];
    sections?: string[];
  };
  question: string;
  knownFacts: string[];
  unresolvedQuestions: string[];
  estimatedInputTokens: number;
}

export type PacketStatus = "complete" | "partial" | "insufficient" | "failed";

export interface EvidencePacket {
  producer: {
    agent: string;
    tier: AgentTier;
    model: string;
  };
  scope: {
    documentId: string;
    pages?: number[];
    sections?: string[];
    /** true when the agent worked on a truncated view */
    truncated?: boolean;
  };
  facts: EvidenceFact[];
  inferences: EvidenceInference[];
  unknowns: string[];
  confidence: number;
  /**
   * complete: answered fully; partial: answered + escalation request;
   * insufficient: agent explicitly declares it cannot answer (must not be empty output);
   * failed: schema/API failure, packet is a failure stub.
   */
  status: PacketStatus;
  /** Why the agent could not complete (e.g. CONTEXT_EXCEEDED, GENERATION_FAILED) */
  failureReason?: string;
  /** Quality-gate hint from the model itself (supplement to deterministic signals) */
  escalationRecommended?: boolean;
  escalation?: EscalationRequest;
}

// ============================================================
// Deterministic merger
// ============================================================

export interface MergedResult {
  facts: EvidenceFact[];
  inferences: EvidenceInference[];
  unknowns: string[];
  conflicts: Array<{
    claim: string;
    candidates: Array<{
      value: string | number;
      producer: string;
      /** e.g. "standard" | "expert" | "query" — which source produced the value */
      sourceType?: EvidenceSourceType;
      evidence?: string;
      confidence: number;
    }>;
    resolution: "requires_verification";
  }>;
  confidence: number;
}

/** Evidence priority: deterministic query > governance > parse > cited > inferred
 *  (spec §11: raw deterministic parse/query results > CDXR deterministic findings
 *   > cited model facts > model inference) */
function factPriority(fact: EvidenceFact): number {
  switch (fact.kind) {
    case "query": return 5;
    case "governance": return 4; // deterministic governance finding
    case "parse": return 3;
    case "cited": return 2;
    case "quality":
    case "lineage":
    case "snapshot": return 2; // metadata-backed, above bare inference
    case "inferred": return 1;
  }
}

function factKey(fact: EvidenceFact): string {
  return `${fact.claim}:${String(fact.value)}`;
}

/**
 * Deterministic merge of standard + expert packets.
 * - Same fact from both sources → kept once (dedup by claim+value), confidence boosted.
 * - Same claim, different value → conflict, requires_verification. No auto "expert wins".
 * - Non-overlapping → union.
 */
export function mergeEvidence(standard: EvidencePacket, expert?: EvidencePacket): MergedResult {
  const merged: MergedResult = {
    facts: [],
    inferences: [],
    unknowns: [],
    conflicts: [],
    confidence: 0,
  };

  const packets = expert ? [standard, expert] : [standard];
  const seen = new Set<string>();
  const byClaim = new Map<string, Array<{ fact: EvidenceFact; tier: AgentTier }>>();

  for (const p of packets) {
    for (const fact of p.facts) {
      const list = byClaim.get(fact.claim) ?? [];
      list.push({ fact, tier: p.producer.tier });
      byClaim.set(fact.claim, list);
    }
  }

  for (const [claim, entries] of byClaim) {
    const facts = entries.map((e) => e.fact);
    const values = new Set(facts.map((f) => String(f.value)));
    if (values.size === 1) {
      // Consistent — keep the highest-priority source, mark seen
      const best = [...facts].sort((a, b) => factPriority(b) - factPriority(a))[0]!;
      if (!seen.has(factKey(best))) {
        merged.facts.push(best);
        seen.add(factKey(best));
      }
    } else {
      // Conflict — never auto-pick. Surface for verification.
      merged.conflicts.push({
        claim,
        candidates: entries.map((e) => ({
          value: e.fact.value,
          producer: e.tier === "expert" ? "expert" : "standard",
          sourceType: e.fact.kind,
          evidence: e.fact.evidence,
          confidence: e.fact.confidence,
        })),
        resolution: "requires_verification",
      });
    }
  }

  // Dedup inferences by claim
  const infClaims = new Set<string>();
  for (const p of packets) {
    for (const inf of p.inferences) {
      if (!infClaims.has(inf.claim)) {
        merged.inferences.push(inf);
        infClaims.add(inf.claim);
      }
    }
  }

  const unknownSet = new Set<string>();
  for (const p of packets) for (const u of p.unknowns) unknownSet.add(u);
  merged.unknowns = [...unknownSet];

  // Aggregate confidence: weighted by fact count and kind
  const weights = merged.facts.map((f) => factPriority(f));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  merged.confidence =
    totalWeight > 0
      ? merged.facts.reduce((s, f, i) => s + f.confidence * weights[i]!, 0) / totalWeight
      : 0;

  return merged;
}
