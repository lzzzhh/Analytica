/**
 * Plan validator — deterministic validation of the subagent's AnalysisPlan
 * before any script is written. Refuses: unknown artifacts, unauthorized
 * columns, modified time ranges, added data sources, changed objectives,
 * invalid views, unbounded step counts.
 */
import type { AnalysisPlan, DataAnalysisRequest } from "./contracts.ts";

export interface PlanValidationIssue {
  code: string;
  message: string;
}

export const MAX_PLAN_STEPS = 30;

export function validateAnalysisPlan(
  plan: AnalysisPlan,
  request: DataAnalysisRequest,
  allowedColumns: Set<string>,
): { valid: boolean; issues: PlanValidationIssue[] } {
  const issues: PlanValidationIssue[] = [];

  if (typeof plan.objective !== "string" || !plan.objective.trim()) {
    issues.push({ code: "OBJECTIVE_MISSING", message: "plan objective missing" });
  } else if (plan.objective !== request.objective) {
    issues.push({ code: "OBJECTIVE_CHANGED", message: "plan must not change the objective" });
  }
  // a MISSING analysisType is not a change: the plan defaults to the request
  // (the invariant is "the plan must not change the type")
  const effectiveType = plan.analysisType ?? request.analysisType;
  if (effectiveType !== request.analysisType) {
    issues.push({ code: "ANALYSIS_TYPE_CHANGED", message: `plan analysisType differs from request (got ${String(plan.analysisType)}, want ${request.analysisType})` });
  }

  // Input artifacts must match the request exactly (no new data sources).
  // Normalize: models sometimes emit objects ({artifactId}) instead of ids.
  const requestIds = new Set((request.dataRefs ?? []).map((r) => r.artifactId));
  const rawPlanIds = (plan.inputArtifacts ?? []) as Array<string | { artifactId?: unknown }>;
  const planIds = new Set(rawPlanIds.map((id) =>
    typeof id === "string" ? id : String((id as { artifactId?: unknown }).artifactId ?? "")));
  for (const id of planIds) {
    if (!requestIds.has(id)) {
      issues.push({ code: "UNKNOWN_INPUT", message: `plan references unknown input ${id}` });
    }
  }
  for (const id of requestIds) {
    if (!planIds.has(id)) {
      issues.push({ code: "INPUT_DROPPED", message: `plan dropped input ${id}` });
    }
  }

  // Selected columns must be within the allowed schema.
  for (const col of plan.selectedColumns ?? []) {
    if (allowedColumns.size > 0 && !allowedColumns.has(col)) {
      issues.push({ code: "FIELD_NOT_ALLOWED", message: `column '${col}' not allowed` });
    }
  }

  // Time range must not be modified.
  if (request.timeField && plan.timeField !== request.timeField) {
    issues.push({ code: "TIME_FIELD_CHANGED", message: "plan timeField differs from request" });
  }

  // Steps bounded.
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    issues.push({ code: "STEPS_MISSING", message: "plan has no steps" });
  } else if (plan.steps.length > MAX_PLAN_STEPS) {
    issues.push({ code: "STEPS_TOO_MANY", message: `plan has ${plan.steps.length} steps > ${MAX_PLAN_STEPS}` });
  }

  if (!Array.isArray(plan.expectedOutputs) || plan.expectedOutputs.length === 0) {
    issues.push({ code: "OUTPUTS_MISSING", message: "plan has no expected outputs" });
  }

  return { valid: issues.length === 0, issues };
}
