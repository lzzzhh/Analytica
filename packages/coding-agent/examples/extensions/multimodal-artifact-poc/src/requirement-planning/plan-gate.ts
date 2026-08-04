/**
 * Plan gate — decides DIRECT / LIGHTWEIGHT / FORMAL.
 *
 * Deterministic, no LLM. DIRECT requests must not get a verbose plan; they
 * are routed to direct execution.
 */
import type {
  Ambiguity,
  BusinessRequirementCard,
  CapabilityDescriptor,
  PlanGateResult,
} from "./contracts.ts";

export interface GateInput {
  card: BusinessRequirementCard;
  capabilities: CapabilityDescriptor[];
  rawRequest: string;
  /** ablation: plan_gate=false → non-DIRECT requests become FORMAL */
  planGateEnabled: boolean;
}

const CROSS_SOURCE_HINTS = /文档|报告|核对|验证|训练|泄漏|模型报告|图片|截图|pdf|excel|gateway|交叉验证|跨源|对一下|比对/i;
const CONDITIONAL_HINTS = /如果|若|异常|发现|检查.*(泄漏|质量)|不一致|missing/i;
const MULTI_GOAL_HINTS = /和.*(核对|对比).*(泄漏|异常)|同时.*(分析|检查)|既.*又/i;

/**
 * Score + mode:
 *  DIRECT   — single goal, one capability, no cross-source, no branching
 *  LIGHTWEIGHT — 2-3 simple steps, single source, no sub-agents
 *  FORMAL   — cross-source, multi-goal, conditional branches, sub-agents
 */
export function evaluatePlanGate(input: GateInput): PlanGateResult {
  const reasons: string[] = [];
  let score = 0;

  const crossSource = CROSS_SOURCE_HINTS.test(input.rawRequest);
  const conditional = CONDITIONAL_HINTS.test(input.rawRequest);
  const multiGoal = MULTI_GOAL_HINTS.test(input.rawRequest);
  const blocking = input.card.ambiguities.some((a) => a.blocking);
  const metrics = input.card.metrics.length;
  const hasTrainingCheck = /训练|泄漏/.test(input.rawRequest);
  const hasDocAnalysis = /文档|报告|pdf/.test(input.rawRequest);
  const sequentialSteps = /然后|接着|之后|再总结|并.*总结|随后/.test(input.rawRequest);
  const queryOnly = /查询|查一下|select|AUC|最近.{0,10}(天|周|月)/i.test(input.rawRequest) &&
    !crossSource && !conditional && !hasDocAnalysis && !sequentialSteps;

  // DIRECT: single explicit query request with no ambiguity or cross-source.
  if (queryOnly && !crossSource && !conditional && !blocking) {
    reasons.push("single explicit query request");
    reasons.push("no cross-source verification");
    reasons.push("no conditional branching");
    return { mode: "DIRECT", score: 1, reasons };
  }

  if (crossSource) {
    score += 3;
    reasons.push("cross-source verification required");
  }
  if (conditional) {
    score += 2;
    reasons.push("conditional branching present");
  }
  if (multiGoal) {
    score += 2;
    reasons.push("multiple business goals");
  }
  if (hasTrainingCheck) {
    score += 2;
    reasons.push("training-data check involved");
  }
  if (hasDocAnalysis) {
    score += 2;
    reasons.push("document analysis involved");
  }
  if (blocking) {
    score += 1;
    reasons.push("blocking ambiguity present (clarify first)");
  }
  if (metrics >= 3) {
    score += 1;
    reasons.push("multiple metrics to compare");
  }

  if (!input.planGateEnabled) {
    // ablation: only DIRECT stays direct; everything else formal.
    if (score === 0 && queryOnly) {
      return { mode: "DIRECT", score: 1, reasons: ["plan_gate ablated: simple request stays direct"] };
    }
    reasons.push("plan_gate ablated: forcing FORMAL");
    return { mode: "FORMAL", score: Math.max(score, 4), reasons };
  }

  if (score <= 1) {
    reasons.push("fewer than 2 complexity signals");
    return { mode: "LIGHTWEIGHT", score: 2, reasons };
  }
  reasons.push(`complexity score ${score} ≥ 2`);
  return { mode: "FORMAL", score, reasons };
}
