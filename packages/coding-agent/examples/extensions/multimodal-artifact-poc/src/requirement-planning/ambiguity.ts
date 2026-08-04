/**
 * Ambiguity detection — deterministic, rule-based.
 *
 * Distinguishes blocking ambiguities (subject, objective, model, decision
 * framing) from non-blocking ones (time range, baseline, trend granularity)
 * that can be resolved with explicit, user-visible assumptions.
 *
 * Pure: no imports outside the core. No silent completion ever — every
 * default lands in assumptions with source + visibleToUser=true.
 */
import type {
  Ambiguity,
  AmbiguityType,
  Assumption,
  AssumptionImpact,
  ClarificationAnswer,
  ClarificationQuestion,
} from "./contracts.ts";
import type { DomainPack } from "./domain-packs/contracts.ts";

export interface DetectInput {
  rawRequest: string;
  domainHint?: string;
  answeredFields: Set<string>;
  /** Fields already given by the user in the raw request. */
  explicitFields: Set<string>;
  domainPack: DomainPack;
}

export interface DetectOutput {
  ambiguities: Ambiguity[];
  blocking: Ambiguity[];
  nonBlocking: Ambiguity[];
  questions: ClarificationQuestion[];
  assumptions: Assumption[];
}

let ambiguitySeq = 0;

function nextAmbiguityId(field: string): string {
  ambiguitySeq += 1;
  return `amb_${field.replace(/[^a-zA-Z0-9]/g, "_")}_${ambiguitySeq}`;
}

let questionSeq = 0;

function nextQuestionId(field: string): string {
  questionSeq += 1;
  return `q_${field.replace(/[^a-zA-Z0-9]/g, "_")}_${questionSeq}`;
}

let assumptionSeq = 0;

function nextAssumptionId(field: string): string {
  assumptionSeq += 1;
  return `asm_${field.replace(/[^a-zA-Z0-9]/g, "_")}_${assumptionSeq}`;
}

/** Which fields the user has already answered via clarification answers. */
export function answeredFields(answers: ClarificationAnswer[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const a of answers ?? []) {
    if (a.field) out.add(a.field);
  }
  return out;
}

const BLOCKING_AMBIGUITY_FIELDS = new Set([
  "subject",
  "businessObjective",
  "decisionToSupport",
  "model",
  "dataset",
  "phenomenonVsDecision",
]);

/**
 * Detect ambiguities from a raw request + domain pack.
 * Rules:
 *  - blocking fields (subject/objective/model/...) never get silent defaults;
 *    they always surface as questions (unless the user already provided them)
 *  - non-blocking fields (timeRange/baseline) get LOW-risk defaults from the
 *    domain pack; MEDIUM+ defaults or unlisted fields stay questions
 *  - answered fields are never re-asked
 */
export function detectAmbiguities(input: DetectInput): DetectOutput {
  const ambiguities: Ambiguity[] = [];
  const questions: ClarificationQuestion[] = [];
  const assumptions: Assumption[] = [];
  const blocking: Ambiguity[] = [];
  const nonBlocking: Ambiguity[] = [];

  const addAmbiguity = (a: Ambiguity) => {
    ambiguities.push(a);
    if (a.blocking) blocking.push(a);
    else nonBlocking.push(a);
  };

  const domainAmbiguities = input.domainPack.knownAmbiguities;
  const byField = new Map<string, (typeof domainAmbiguities)[number]>();
  for (const d of domainAmbiguities) byField.set(d.field, d);

  // Fields the user already supplied via answers or the raw request.
  const knownFields = new Set([...input.answeredFields, ...input.explicitFields]);

  // 1) domain-pack ambiguities
  const modelMetricsRequested = /AUC|KS|PSI|评分|score|模型.*(表现|效果|质量)|模型表现/i.test(input.rawRequest);
  // a direct single-step query names its subject/metrics explicitly; other
  // domain fields must not block it into NEEDS_CLARIFICATION
  const directQuery = /^(查询|查一下|查|看看|统计|汇总|select|query|算一下|计算)[\s:：.]?/i.test(input.rawRequest);
  for (const d of domainAmbiguities) {
    if (input.answeredFields.has(d.field)) continue;
    if (input.explicitFields.has(d.field)) continue;

    // model ambiguity is only meaningful for model-quality metrics —
    // a plain query on a domain subject must not be blocked by it.
    if (d.field === "model" && !modelMetricsRequested) continue;

    // businessObjective is implied once subject + metrics are known —
    // downgrade it to a non-blocking, user-visible assumption instead of
    // re-asking (the objective can be safely inferred as "evaluate the
    // stated metrics for the stated subject").
    const objectiveInferable =
      d.field === "businessObjective" &&
      knownFields.has("subject") &&
      knownFields.has("metrics");
    // a direct query must not be blocked by domain fields other than the
    // subject/metrics it already names explicitly
    const directQueryDowngrade =
      directQuery && d.field !== "subject" && d.field !== "metrics";
    const blocking = objectiveInferable || directQueryDowngrade ? false : d.blocking;

    const ambiguity: Ambiguity = {
      ambiguityId: nextAmbiguityId(d.field),
      field: d.field,
      type: d.type,
      blocking,
      reason: d.whyNeeded,
      candidateValues: d.options,
    };
    addAmbiguity(ambiguity);

    // Non-blocking + adoptable low-risk default → assumption, no question.
    if (!blocking && d.defaultValue !== undefined && d.defaultRisk === "LOW") {
      assumptions.push({
        assumptionId: nextAssumptionId(d.field),
        field: d.field,
        value: d.defaultValue,
        source: input.domainPack.packId === "generic" ? "SYSTEM_DEFAULT" : "DOMAIN_DEFAULT",
        impact: (d.defaultValue.includes("30") ? "MEDIUM" : "LOW") as AssumptionImpact,
        requiresConfirmation: true,
        visibleToUser: true,
      });
      continue;
    }

    // Objective inferred from subject+metrics → visible assumption, no question.
    if (objectiveInferable) {
      assumptions.push({
        assumptionId: nextAssumptionId("businessObjective"),
        field: "businessObjective",
        value: `evaluate ${[...knownFields].filter((f) => f === "subject").join(",")} — inferred from stated subject and metrics`,
        source: "SYSTEM_DEFAULT",
        impact: "MEDIUM",
        requiresConfirmation: true,
        visibleToUser: true,
      });
      continue;
    }

    questions.push({
      questionId: nextQuestionId(d.field),
      field: d.field,
      question: d.question,
      whyNeeded: d.whyNeeded,
      blocking,
      priority: priorityForField(d.field),
      answerType: d.answerType,
      options: d.options,
    });
  }

  // 2) phenomenon-vs-decision framing: "看看有没有问题" type requests.
  //    Skipped when the user already stated a subject/objective (the intent
  //    is then clear enough to proceed).
  if (looksLikeVagueInquiry(input.rawRequest) &&
      !input.answeredFields.has("phenomenonVsDecision") &&
      !input.answeredFields.has("subject") &&
      !input.answeredFields.has("businessObjective")) {
    addAmbiguity({
      ambiguityId: nextAmbiguityId("phenomenonVsDecision"),
      field: "phenomenonVsDecision",
      type: "MULTIPLE_INTERPRETATIONS",
      blocking: true,
      reason:
        "The request could mean either describing a phenomenon or supporting a decision — these lead to different plans.",
      candidateValues: ["describe_phenomenon", "support_decision"],
    });
    questions.push({
      questionId: nextQuestionId("phenomenonVsDecision"),
      field: "phenomenonVsDecision",
      question: "Are you describing an observed phenomenon, or supporting a decision with this analysis?",
      whyNeeded: "Different intents lead to different data sources and plan shapes.",
      blocking: true,
      priority: 1,
      answerType: "SINGLE_CHOICE",
      options: ["describe_phenomenon", "support_decision"],
    });
  }

  // 3) model field (blocking, domain-dependent) — only when the request
  //    involves model-quality metrics (AUC/KS/PSI/score) and the domain pack
  //    does not already provide a model ambiguity (avoids duplicates).
  if (modelMetricsRequested && input.domainPack.packId !== "generic" && !byField.has("model") && !input.explicitFields.has("model")) {
    const modelAmbiguity = byField.get("model");
    if (modelAmbiguity) {
      addAmbiguity({
        ambiguityId: nextAmbiguityId("model"),
        field: "model",
        type: "MISSING",
        blocking: true,
        reason: modelAmbiguity.whyNeeded,
      });
      questions.push({
        questionId: nextQuestionId("model"),
        field: "model",
        question: modelAmbiguity.question,
        whyNeeded: modelAmbiguity.whyNeeded,
        blocking: true,
        priority: priorityForField("model"),
        answerType: modelAmbiguity.answerType,
      });
    }
  }

  return { ambiguities, blocking, nonBlocking, questions, assumptions };
}

/** Question priority: objective > data scope > metric > execution > display. */
function priorityForField(field: string): 1 | 2 | 3 | 4 | 5 {
  switch (field) {
    case "businessObjective":
    case "decisionToSupport":
    case "phenomenonVsDecision":
      return 1;
    case "subject":
    case "dataset":
    case "model":
    case "timeRange":
      return 2;
    case "metrics":
    case "successCriteria":
      return 3;
    case "comparisonBaseline":
      return 4;
    default:
      return 5;
  }
}

/** Heuristic for vague "is there a problem" requests. */
export function looksLikeVagueInquiry(raw: string): boolean {
  const t = raw.trim();
  if (t.length === 0) return false;
  return /问题|异常|情况|怎么样|趋势|表现|有没有|如何/.test(t) &&
    !/查询|对比|比较|计算|统计/.test(t);
}
