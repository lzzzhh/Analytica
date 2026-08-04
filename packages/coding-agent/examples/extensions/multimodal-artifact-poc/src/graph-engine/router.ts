/**
 * Graph Engine — deterministic feedback router.
 *
 * CHANGES_REQUIRED / ABSTAIN findings map through STRUCTURED reason codes to
 * target node families. The router never lets an LLM pick the return path.
 */
export type FeedbackTarget =
  | "REQUIREMENT"
  | "PREFLIGHT"
  | "DATA_ANALYSIS"
  | "REPORT_SKILL"
  | "HUMAN_GATE";

export type FeedbackReasonCode =
  | "REQUIREMENT"
  | "AMBIGUITY"
  | "GOAL"
  | "INPUT"
  | "ARTIFACT"
  | "SCHEMA"
  | "QUALITY"
  | "SNAPSHOT"
  | "MASKING"
  | "LINEAGE"
  | "METHOD"
  | "CALCULATION"
  | "SCRIPT"
  | "RESULT_SCHEMA"
  | "REPLAY_MISMATCH"
  | "KPI_MISMATCH"
  | "REPORT_CONTENT"
  | "REPORT_PROVENANCE"
  | "REPORT_QA"
  | "PRESENTATION_QA"
  | "PERMISSION"
  | "BUDGET"
  | "MISSING_REQUIRED_EVIDENCE"
  | "POLICY";

export const REASON_TO_TARGET: Record<FeedbackReasonCode, FeedbackTarget> = {
  REQUIREMENT: "REQUIREMENT",
  AMBIGUITY: "REQUIREMENT",
  GOAL: "REQUIREMENT",
  INPUT: "PREFLIGHT",
  ARTIFACT: "PREFLIGHT",
  SCHEMA: "PREFLIGHT",
  QUALITY: "PREFLIGHT",
  SNAPSHOT: "PREFLIGHT",
  MASKING: "PREFLIGHT",
  LINEAGE: "PREFLIGHT",
  METHOD: "DATA_ANALYSIS",
  CALCULATION: "DATA_ANALYSIS",
  SCRIPT: "DATA_ANALYSIS",
  RESULT_SCHEMA: "DATA_ANALYSIS",
  REPLAY_MISMATCH: "DATA_ANALYSIS",
  KPI_MISMATCH: "DATA_ANALYSIS",
  REPORT_CONTENT: "REPORT_SKILL",
  REPORT_PROVENANCE: "REPORT_SKILL",
  REPORT_QA: "REPORT_SKILL",
  PRESENTATION_QA: "REPORT_SKILL",
  PERMISSION: "HUMAN_GATE",
  BUDGET: "HUMAN_GATE",
  MISSING_REQUIRED_EVIDENCE: "HUMAN_GATE",
  POLICY: "HUMAN_GATE",
};

export interface FeedbackDecision {
  verdict: "PASS" | "CHANGES_REQUIRED" | "REJECT" | "ABSTAIN" | "UNREVIEWED_LOW_RISK";
  reasonCodes: FeedbackReasonCode[];
  target: FeedbackTarget | null;
  consumesRevisionCycle: boolean;
}

/** Deterministic routing for a reviewer verdict + structured reason codes. */
export function routeFeedback(verdict: FeedbackDecision["verdict"], reasonCodes: FeedbackReasonCode[]): FeedbackDecision {
  switch (verdict) {
    case "PASS":
      return { verdict, reasonCodes, target: null, consumesRevisionCycle: false };
    case "UNREVIEWED_LOW_RISK":
      return { verdict, reasonCodes, target: null, consumesRevisionCycle: false };
    case "REJECT":
      // REJECT stops the graph; no automatic revision
      return { verdict, reasonCodes, target: null, consumesRevisionCycle: false };
    case "ABSTAIN": {
      // temporary unavailability -> retry; evidence/budget -> human gate
      const humanCodes = reasonCodes.filter((c) => REASON_TO_TARGET[c] === "HUMAN_GATE");
      return {
        verdict,
        reasonCodes,
        target: humanCodes.length > 0 ? "HUMAN_GATE" : null,
        consumesRevisionCycle: false,
      };
    }
    case "CHANGES_REQUIRED": {
      if (reasonCodes.length === 0) {
        return { verdict, reasonCodes, target: "DATA_ANALYSIS", consumesRevisionCycle: true };
      }
      // first code wins deterministically
      const target = REASON_TO_TARGET[reasonCodes[0]!] ?? "DATA_ANALYSIS";
      return { verdict, reasonCodes, target, consumesRevisionCycle: true };
    }
  }
}
