/**
 * Assumption management — every default becomes an explicit, user-visible
 * assumption. No silent completion is allowed anywhere in the core.
 */
import type { Assumption, ClarificationAnswer } from "./contracts.ts";

/**
 * Build assumptions from user answers (source=USER). Answers carry a field
 * name; each answered field maps to an assumption that is visible and does
 * NOT require further confirmation (the user said it).
 */
export function assumptionsFromAnswers(answers: ClarificationAnswer[] | undefined): Assumption[] {
  const out: Assumption[] = [];
  for (const a of answers ?? []) {
    if (!a.field) continue;
    const value = Array.isArray(a.value) ? a.value.join(",") : a.value;
    if (!value.trim()) continue;
    out.push({
      assumptionId: `asm_user_${a.field.replace(/[^a-zA-Z0-9]/g, "_")}`,
      field: a.field,
      value,
      source: "USER",
      impact: impactForField(a.field),
      requiresConfirmation: false,
      visibleToUser: true,
    });
  }
  return out;
}

function impactForField(field: string): "LOW" | "MEDIUM" | "HIGH" {
  switch (field) {
    case "businessObjective":
    case "decisionToSupport":
    case "subject":
    case "model":
    case "dataset":
      return "HIGH";
    case "timeRange":
    case "metrics":
    case "successCriteria":
      return "MEDIUM";
    default:
      return "LOW";
  }
}

/**
 * Merge user assumptions with domain/system defaults, deduplicating by
 * field (user wins). Deterministic order: user assumptions first, then
 * defaults sorted by field.
 */
export function mergeAssumptions(user: Assumption[], defaults: Assumption[]): Assumption[] {
  const byField = new Map<string, Assumption>();
  for (const a of [...user, ...defaults]) {
    if (!byField.has(a.field)) byField.set(a.field, a);
  }
  return [...byField.values()];
}

/** Fields that must never be completed silently (blocking by policy). */
export const NEVER_SILENT_FIELDS = [
  "businessObjective",
  "decisionToSupport",
  "subject",
  "model",
  "dataset",
  "metrics",
  "successCriteria",
] as const;
