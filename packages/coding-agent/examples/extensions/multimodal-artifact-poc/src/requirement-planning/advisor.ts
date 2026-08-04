/**
 * Planning Advisor — isolated business-semantics analysis.
 *
 * The advisor is NOT the decision maker: it only produces candidate field
 * conclusions, ambiguities, assumptions, clarification questions and
 * candidate tasks, all strictly JSON. The main agent owns the final plan.
 *
 * Output rules:
 *  - strict JSON only
 *  - schema-validated
 *  - first invalid JSON → ONE repair request allowed
 *  - second invalid JSON → ADVISOR_OUTPUT_INVALID, CANNOT_PLAN upstream
 *  - no chain-of-thought in the output
 */
import type {
  AdvisorOutput,
  AdvisorReasonCode,
  ClarificationAnswer,
  PrepareBusinessTaskRequest,
  ReplanReasonCode,
} from "./contracts.ts";

export interface AdvisorCaller {
  (prompt: string): Promise<{ ok: boolean; text: string; error?: string }>;
}

export interface AdvisorOptions {
  modelId: string;
  domainPackId: string;
  /** enabled=false (planning_advisor off) → never invoke the sub-agent */
  enabled: boolean;
  caller: AdvisorCaller;
}

export interface AdvisorResult {
  output: AdvisorOutput | null;
  reasonCode: AdvisorReasonCode | "ADVISOR_OUTPUT_INVALID";
  repairCount: number;
  modelId: string;
  error?: string;
}

/** Minimal structural validation of an advisor output. */
export function isAdvisorOutput(value: unknown): value is AdvisorOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.businessObjective !== "string") return false;
  if (typeof v.subject !== "string") return false;
  if (!Array.isArray(v.ambiguities)) return false;
  if (!Array.isArray(v.assumptions)) return false;
  if (!Array.isArray(v.clarificationQuestions)) return false;
  if (!Array.isArray(v.candidateTasks)) return false;
  return true;
}

/** Best-effort JSON repair: trim fences, strip trailing commas, normalize. */
export function repairJsonText(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  // remove trailing commas
  t = t.replace(/,\s*([}\]])/g, "$1");
  return t;
}

export function parseAdvisorOutput(text: string): AdvisorOutput | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isAdvisorOutput(parsed) ? parsed : null;
  } catch {
    try {
      const parsed = JSON.parse(repairJsonText(text)) as unknown;
      return isAdvisorOutput(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export function advisorPrompt(request: PrepareBusinessTaskRequest, domainPackId: string): string {
  const safeRequest = (request.request ?? "").slice(0, 2000);
  const safeSummary = (request.conversationSummary ?? "").slice(0, 1000);
  const answers = (request.answers ?? []).map((a) => `${a.field ?? a.questionId}: ${Array.isArray(a.value) ? a.value.join(", ") : a.value}`).join("\n");
  return `You are a requirement planning advisor. Analyze the user's business request and return STRICT JSON only (no prose, no markdown fences, no reasoning).

You are NOT the decision maker: your output is a candidate analysis. Never output chain-of-thought.

Domain pack: ${domainPackId}

Request: ${safeRequest}
Conversation summary: ${safeSummary}
User answers:
${answers || "(none)"}

Return exactly this JSON shape:
{
  "businessObjective": string,
  "decisionToSupport": string,
  "subject": string,
  "scope": string,
  "domain": "general" | "risk",
  "conclusions": [{"field": string, "value": string, "reasonCode": "OBJECTIVE_CLARIFIED" | "SUBJECT_KNOWN" | "SUBJECT_UNKNOWN" | "METRICS_KNOWN" | "METRICS_UNKNOWN" | "TIME_UNKNOWN" | "DOMAIN_SIGNAL" | "NO_DOMAIN_SIGNAL"}],
  "ambiguities": [{"field": string, "type": "MISSING" | "MULTIPLE_INTERPRETATIONS" | "VAGUE_RANGE" | "UNKNOWN_METRIC" | "UNKNOWN_BASELINE" | "UNKNOWN_SUCCESS_CRITERIA" | "DOMAIN_AMBIGUITY", "reason": string, "blocking": boolean, "candidateValues": string[] | null}],
  "assumptions": [{"field": string, "value": string, "source": "USER" | "DOMAIN_DEFAULT" | "SYSTEM_DEFAULT", "impact": "LOW" | "MEDIUM" | "HIGH", "requiresConfirmation": boolean}],
  "clarificationQuestions": [{"field": string, "question": string, "whyNeeded": string, "answerType": "TEXT" | "SINGLE_CHOICE" | "MULTI_CHOICE" | "DATE_RANGE" | "NUMBER", "options": string[] | null}],
  "candidateTasks": [{"title": string, "objective": string, "taskType": "DISCOVER" | "EXTRACT" | "QUERY" | "VALIDATE" | "COMPARE" | "ASSESS" | "ANALYZE" | "SYNTHESIZE" | "CLARIFY", "capability": string, "dependsOn": string[], "optional": boolean}],
  "reasons": [string]
}`;
}

/**
 * Run the advisor with one repair attempt.
 * Returns null output when the advisor is disabled (caller handles fallback).
 */
export async function runAdvisor(
  options: AdvisorOptions,
  request: PrepareBusinessTaskRequest,
): Promise<AdvisorResult> {
  const started = Date.now();
  if (!options.enabled) {
    return {
      output: null,
      reasonCode: "NO_DOMAIN_SIGNAL",
      repairCount: 0,
      modelId: options.modelId,
      error: "planning_advisor disabled — deterministic fallback used",
    };
  }

  let repairCount = 0;
  let result = await options.caller(advisorPrompt(request, options.domainPackId));
  if (!result.ok) {
    return {
      output: null,
      reasonCode: "ADVISOR_OUTPUT_INVALID",
      repairCount,
      modelId: options.modelId,
      error: result.error ?? "advisor call failed",
    };
  }

  let output = parseAdvisorOutput(result.text);
  if (!output) {
    // one repair attempt: re-ask with the invalid output flagged
    repairCount += 1;
    const repairPrompt = `${advisorPrompt(request, options.domainPackId)}\n\nYour previous output was NOT valid JSON. Return ONLY valid JSON matching the shape above. Previous output:\n${result.text.slice(0, 1500)}`;
    result = await options.caller(repairPrompt);
    if (result.ok) {
      output = parseAdvisorOutput(result.text);
    }
    if (!output) {
      return {
        output: null,
        reasonCode: "ADVISOR_OUTPUT_INVALID",
        repairCount,
        modelId: options.modelId,
        error: "advisor returned invalid JSON twice",
      };
    }
  }

  return {
    output,
    reasonCode: output.domain === "risk" ? "DOMAIN_SIGNAL" : "NO_DOMAIN_SIGNAL",
    repairCount,
    modelId: options.modelId,
  };
}

/** Reasons usable for the decision log. */
export function advisorReasonCodes(output: AdvisorOutput | null): string[] {
  if (!output) return [];
  return output.conclusions.map((c) => c.reasonCode);
}

export type { ReplanReasonCode, ClarificationAnswer };
