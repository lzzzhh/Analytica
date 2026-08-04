/**
 * Document analysis orchestrator.
 *
 * Pipeline:
 *   1. preflight (static risk score) → route decision
 *   2. L1 standard agent analyzes (with runtime escalation judgement)
 *   3. If escalation required → L2 expert agent analyzes ONLY the escalated scope
 *   4. Deterministic Evidence Merger combines both packets
 *   5. Returns merged evidence + packets to the main agent
 *
 * Expert results never pass through the standard agent — they are merged
 * deterministically by the orchestrator.
 */

import { mergeEvidence, type EvidencePacket, type MergedResult } from "./evidence.ts";
import { preflight, type PreflightResult } from "./preflight.ts";
import { runL1Agent, runL2Agent } from "./doc-agents.ts";
import { assessEvidenceQuality, computeQualityScore, decideGate, gateReason, type EvidenceQuality, type GateVerdict } from "./quality-gate.ts";
import { getDefaultFeatureResolver } from "./features/resolver.ts";

/** Short documents (low budget) never escalate on quality-gate failure alone —
 *  the packet is selected by quality, not replaced by an expensive expert.
 *  Escalation for them requires a hard signal (truncation / explicit agent
 *  failure) or a special-case request. (User spec: estimatedTokens <= 2000.) */
const SHORT_DOCUMENT_TOKENS = 2000;

/** Special cases that may still escalate a short document (user spec):
 *  explicit deep-analysis request / conflicting facts / cross-document
 *  comparison / complex reasoning / deterministic parse failure. */
const SPECIAL_CASE_RE = /(深度|深入|详细|全面|完整|复杂).{0,12}(分析|推理|评估|解读|审核)|跨文档|交叉|对比|比较|compare|推理|推算|条款|矛盾/u;

export interface AttemptRecord {
  passed: boolean;
  qualityScore: number;
  gateReason: string;
}

export interface DecisionLog {
  documentId: string;
  documentChars: number;
  estimatedTokens: number;
  shortDocument: boolean;
  attempt1: AttemptRecord;
  attempt2?: AttemptRecord;
  bestAttempt: "attempt1" | "attempt2";
  selectionReason: string;
  expertTriggered: boolean;
  expertUsed: boolean;
  expertScore?: number;
  expertDiscardReason?: string;
}

export interface OrchestratedResult {
  documentId: string;
  route: PreflightResult;
  standardPacket?: EvidencePacket;
  expertPacket?: EvidencePacket;
  merged: MergedResult;
  escalation: boolean;
  decision: DecisionLog;
  /** Raw first-attempt packet (pre-gate) — for counterfactual analysis */
  attempt1Packet?: EvidencePacket;
  /** Raw retry packet, when a retry happened */
  attempt2Packet?: EvidencePacket;
  durationMs: number;
  tokens: { l1: number; l2: number };
  error?: string;
  /** Ablation experiment record (feature-driven pipeline switches) */
  experiment?: {
    experimentId: string | null;
    qualityGate: boolean;
    l1Retry: boolean;
    bestAttemptSelection: boolean;
    l2Expert: boolean;
    evidenceMerger: boolean;
  };
}

/** Ablation switches resolved from the feature registry once per call. */
function pipelineSwitches(): {
  qualityGate: boolean;
  l1Retry: boolean;
  bestAttemptSelection: boolean;
  l2Expert: boolean;
  evidenceMerger: boolean;
  experimentId: string | null;
} {
  const f = getDefaultFeatureResolver();
  return {
    qualityGate: f.isEffective("round1.quality_gate"),
    l1Retry: f.isEffective("round1.l1_retry"),
    bestAttemptSelection: f.isEffective("round1.best_attempt_selection"),
    l2Expert: f.isEffective("round1.l2_expert"),
    evidenceMerger: f.isEffective("round1.evidence_merger"),
    experimentId: f.getEffectiveFeatureSnapshot().experimentId,
  };
}

/** Agent runners (injectable for tests; never overridden in prod paths). */
let agentRunners: {
  runL1: typeof runL1Agent;
  runL2: typeof runL2Agent;
} = { runL1: runL1Agent, runL2: runL2Agent };

/** Test hook: replace the agent runners (mirrors _setDefaultFeatureResolver). */
export function _setAgentRunners(runners: Partial<typeof agentRunners> | null): void {
  agentRunners = runners === null
    ? { runL1: runL1Agent, runL2: runL2Agent }
    : { ...agentRunners, ...runners };
}

/** Split document into section chunks by headings, for L2 scope extraction. */
function splitSections(documentText: string): { heading: string; text: string }[] {
  const lines = documentText.split("\n");
  const sections: { heading: string; text: string }[] = [];
  let current: { heading: string; text: string[] } | null = null;
  for (const line of lines) {
    if (/^#{1,3}\s/u.test(line)) {
      if (current && current.text.length) sections.push({ heading: current.heading, text: current.text.join("\n") });
      current = { heading: line.trim(), text: [] };
    } else if (current) {
      current.text.push(line);
    }
  }
  if (current && current.text.length) sections.push({ heading: current.heading, text: current.text.join("\n") });
  return sections;
}

export async function orchestrateDocumentAnalysis(params: {
  documentId: string;
  documentText: string;
  question: string;
}): Promise<OrchestratedResult> {
  const started = Date.now();
  const { documentId, documentText, question } = params;

  try {
    // 1. Pre-route by static risk
    const risk = preflight(documentText, documentId);

    // 2. L1 standard agent — input truncated when over the L1 budget
    const truncated = risk.estimatedTokens > 6000; // L1 gets a truncated view when over budget
    const l1Input = truncated ? documentText.slice(0, 6000 * 3.5) : documentText;
    const shortDocument = risk.estimatedTokens <= SHORT_DOCUMENT_TOKENS;

    const l1 = await agentRunners.runL1({ documentId, documentText: l1Input, question, truncated });

    // Ablation switches (feature-driven; round1.* runtime defaults are ON).
    const abl = pipelineSwitches();

    // 3. Evidence Quality Gate (v2, relative judgement) + best-attempt selection.
    //    attempt1 → gate: pass→use it; retry→differentiated retry; escalate→expert.
    //    The BEST attempt (by deterministic quality score) is selected, never the
    //    last one — a good attempt1 must not be overwritten by a bad attempt2.
    //    Ablations: quality_gate=false → no gate assessment (attempt1 passes
    //    through); l1_retry=false → no attempt2; best_attempt_selection=false →
    //    keep the LAST attempt (retry always wins).
    let l1Final = l1;
    let verdict: GateVerdict = "pass";
    let reason = "pass";
    let reason1 = "pass";
    let retried = false;
    let q2: EvidenceQuality | undefined;
    let l1b: Awaited<ReturnType<typeof runL1Agent>> | undefined;

    const q1 = abl.qualityGate
      ? assessEvidenceQuality(l1.packet, {
          documentChars: l1Input.length,
          outputTokens: l1.completionTokens,
          question,
        })
      : undefined;
    if (q1 !== undefined) {
      verdict = decideGate(q1, l1.packet, { documentChars: l1Input.length, shortDocument });
      reason1 = gateReason(verdict, q1, l1.packet, { documentChars: l1Input.length });
      reason = reason1;
    } else {
      reason1 = "quality_gate_disabled";
      reason = reason1;
    }

    if (q1 !== undefined && verdict === "retry" && abl.l1Retry) {
      // Differentiated retry: reduced prompt, low temperature, larger cap.
      // A retry that repeats the original call tends to re-collapse.
      retried = true;
      l1b = await agentRunners.runL1({ documentId, documentText: l1Input, question, truncated, reduced: true });
      q2 = assessEvidenceQuality(l1b.packet, {
        documentChars: l1Input.length,
        outputTokens: l1b.completionTokens,
        question,
      });
      const v2 = decideGate(q2, l1b.packet, { documentChars: l1Input.length, shortDocument });
      const reason2 = gateReason(v2, q2, l1b.packet, { documentChars: l1Input.length });

      // Best-attempt selection: keep the higher-quality packet, not the last
      // one (ablation: best_attempt_selection=false → keep the LAST attempt).
      l1Final = abl.bestAttemptSelection
        ? (q2.qualityScore > q1.qualityScore ? l1b : l1)
        : l1b;
      if (v2 === "pass" && (abl.bestAttemptSelection ? q2.qualityScore > q1.qualityScore : true)) {
        verdict = "pass";
        reason = `recovered_after_retry(${q2.qualityScore.toFixed(2)}>${q1.qualityScore.toFixed(2)})`;
      } else {
        // retry failed or attempt1 still better — gate escalate, but short
        // documents do NOT escalate on quality alone (see step 4)
        verdict = "escalate";
        reason = `retry_failed:${reason2}`;
      }
    }

    // 4. Escalation decision (v2): hard signals always escalate; quality-gate
    //    failure escalates only for non-short documents (or special cases).
    //    Ablation: l2_expert=false → never start L2 (hard signals still
    //    recorded in the escalation field but no expert run happens).
    const agentDeclared = l1.packet.status === "insufficient" || l1.packet.status === "failed"
      || Boolean(l1.packet.escalation?.required) || Boolean(l1Final.packet.status === "insufficient" || l1Final.packet.status === "failed");
    const specialCase = shortDocument && SPECIAL_CASE_RE.test(question);
    const parseFailedTwice = verdict === "escalate" && q1 !== undefined && (!q1.schemaValid && (q2 ? !q2.schemaValid : true));
    const qualityEscalate = verdict === "escalate";
    const needsEscalation = truncated || agentDeclared
      || (qualityEscalate && (!shortDocument || specialCase || parseFailedTwice));

    const esc: EvidencePacket["escalation"] | undefined = needsEscalation
      ? {
          required: true,
          reasonCodes: truncated ? ["INPUT_TRUNCATED"] : ["LOW_CONFIDENCE"],
          scope: { documentId, sections: [] },
          question: truncated
            ? `${question}\n（L1 仅看到文档前 6000 tokens，请覆盖文档其余部分）`
            : `${question}\n（L1 输出未通过质量门${reason ? `: ${reason}` : ""}，请基于文档重新给出确证答案）`,
          knownFacts: l1Final.packet.facts.map((f) => `${f.claim}: ${f.value}`),
          unresolvedQuestions: truncated
            ? ["L1 输入被截断，专家需要覆盖未看到的文档部分"]
            : l1Final.packet.unknowns,
          estimatedInputTokens: Math.ceil(documentText.length / 3.5),
        }
      : l1Final.packet.escalation;

    const escalation = Boolean(esc?.required) || needsEscalation;
    let expertPacket: EvidencePacket | undefined;
    let expertScore: number | undefined;
    let l2Tokens = 0;

    // 4. Escalate to L2 with NARROW scope (only what L1 flagged).
    //    Ablation: l2_expert=false → L2 never starts; escalation is recorded
    //    in the decision log for counterfactual analysis but no expert runs.
    if (escalation && esc && abl.l2Expert) {
      const sections = splitSections(documentText);

      let scopeText: string;
      if (esc.scope.sections?.length) {
        scopeText = sections
          .filter((s) => esc.scope.sections!.some((t) => s.heading.toLowerCase().includes(t.toLowerCase())))
          .map((s) => `${s.heading}\n${s.text}`)
          .join("\n\n");
        if (!scopeText.trim()) scopeText = sections.map((s) => `${s.heading}\n${s.text}`).join("\n\n");
      } else {
        // Fall back to the tail of the document (beyond what L1 saw)
        scopeText = documentText.slice(6000 * 3.5);
        if (!scopeText.trim()) scopeText = documentText;
      }

      const l2 = await agentRunners.runL2({
        documentId,
        scopeText,
        question: esc.question ?? question,
        knownFacts: esc.knownFacts ?? [],
      });
      expertPacket = l2.packet;
      l2Tokens = l2.promptTokens + l2.completionTokens;
      expertScore = computeQualityScore(l2.packet, { documentChars: scopeText.length, truncated: false }).total;
      if (l2.packet.scope.sections === undefined) {
        l2.packet.scope.sections = esc.scope.sections;
      }
    }

    // 5. Expert gating: the expert's packet is merged only when it scores
    //    ABOVE the best standard attempt. A worse expert must not pollute the
    //    result — the merger would not override facts, but its unverified
    //    additions would still be noise. With quality_gate disabled there is
    //    no reference score, so the expert is never used.
    const bestScore = q1 === undefined ? undefined
      : (q2 ? Math.max(q1.qualityScore, q2.qualityScore) : q1.qualityScore);
    const expertUsed = Boolean(expertPacket && bestScore !== undefined && expertScore !== undefined && expertScore > bestScore);
    const expertDiscardReason = expertPacket && !expertUsed
      ? bestScore === undefined
        ? "quality_gate_disabled_no_reference_score"
        : `expert_score_${expertScore!.toFixed(2)}_not_above_best_standard_${bestScore.toFixed(2)}`
      : undefined;

    // 6. Deterministic merge (merger never lets the expert override a
    //    higher-priority fact — conflicts surface as requires_verification).
    //    Ablation: evidence_merger=false → no merger call; the kept packet is
    //    projected directly into the merged shape (facts/inferences/unknowns).
    const merged = abl.evidenceMerger
      ? mergeEvidence(l1Final.packet, expertUsed ? expertPacket : undefined)
      : {
          facts: [...l1Final.packet.facts],
          inferences: [...l1Final.packet.inferences],
          unknowns: [...l1Final.packet.unknowns],
          conflicts: [],
          confidence: l1Final.packet.confidence,
        };

    // 7. Decision log — per-document audit trail
    const bestAttempt = retried ? (q2!.qualityScore > q1!.qualityScore ? "attempt2" : "attempt1") : "attempt1";
    const decision: DecisionLog = {
      documentId,
      documentChars: documentText.length,
      estimatedTokens: risk.estimatedTokens,
      shortDocument,
      attempt1: {
        passed: q1 === undefined || reason1 === "pass" || reason1 === "pass_thin_but_covered",
        qualityScore: q1?.qualityScore ?? 0,
        gateReason: reason1,
      },
      ...(q2 ? {
        attempt2: {
          passed: Boolean(reason.startsWith("recovered")),
          qualityScore: q2.qualityScore,
          gateReason: reason,
        },
      } : {}),
      bestAttempt,
      selectionReason: bestAttempt === "attempt2"
        ? `attempt2_score_${q2!.qualityScore.toFixed(2)}_gt_attempt1_${q1!.qualityScore.toFixed(2)}`
        : retried
          ? `attempt1_score_${q1!.qualityScore.toFixed(2)}_gt_attempt2_${q2!.qualityScore.toFixed(2)}`
          : "single_attempt",
      expertTriggered: Boolean(expertPacket),
      expertUsed,
      ...(expertScore !== undefined ? { expertScore } : {}),
      ...(expertDiscardReason ? { expertDiscardReason } : {}),
    };

    return {
      documentId,
      route: risk,
      standardPacket: l1Final.packet,
      expertPacket,
      merged,
      escalation: needsEscalation,
      decision,
      attempt1Packet: l1.packet,
      ...(retried && l1b ? { attempt2Packet: l1b.packet } : {}),
      durationMs: Date.now() - started,
      tokens: { l1: l1Final.promptTokens + l1Final.completionTokens, l2: l2Tokens },
      experiment: {
        experimentId: abl.experimentId,
        qualityGate: abl.qualityGate,
        l1Retry: abl.l1Retry,
        bestAttemptSelection: abl.bestAttemptSelection,
        l2Expert: abl.l2Expert,
        evidenceMerger: abl.evidenceMerger,
      },
    };
  } catch (error) {
    return {
      documentId,
      route: { route: "standard", riskScore: 0, estimatedTokens: 0, chapterCount: 0, tableCount: 0, pageCount: 0, reasons: [] },
      merged: { facts: [], inferences: [], unknowns: [], conflicts: [], confidence: 0 },
      escalation: false,
      decision: {
        documentId,
        documentChars: 0,
        estimatedTokens: 0,
        shortDocument: false,
        attempt1: { passed: false, qualityScore: 0, gateReason: "orchestrator_error" },
        bestAttempt: "attempt1",
        selectionReason: "orchestrator_error",
        expertTriggered: false,
        expertUsed: false,
      },
      durationMs: Date.now() - started,
      tokens: { l1: 0, l2: 0 },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
