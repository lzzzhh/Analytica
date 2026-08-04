/**
 * Replanner — bounded, deterministic replanning from task feedback.
 *
 * Rules:
 *  - max 1 replan by default (maxReplans from constraints)
 *  - replanReason is always recorded
 *  - completed tasks are preserved, never re-scheduled
 *  - user goal changes produce a new requirementVersion
 *  - plan version increments
 *  - when replanning is disabled → report failure only, no new plan
 *  - when maxReplans is exhausted → CANNOT_PLAN
 */
import type {
  BusinessRequirementCard,
  PlanValidationResult,
  ReplanReasonCode,
  ReplanRecord,
  TaskExecutionFeedback,
  TaskPlan,
} from "./contracts.ts";

export const REPLANNABLE_REASON_CODES: ReplanReasonCode[] = [
  "EMPTY_RESULT",
  "MISSING_CAPABILITY",
  "PRECONDITION_FAILED",
  "CONFLICTING_EVIDENCE",
  "DATASET_NOT_FOUND",
  "FIELD_NOT_FOUND",
  "USER_REQUIREMENT_CHANGED",
  "TOOL_UNAVAILABLE",
];

export interface ReplanInput {
  previousPlan: TaskPlan;
  previousVersion: number;
  card: BusinessRequirementCard;
  feedback: TaskExecutionFeedback[];
  maxReplans: number;
  replanningEnabled: boolean;
  /** provided by the plan builder on demand */
  buildNewPlan: (preservedTasks: TaskPlan["tasks"]) => TaskPlan;
}

export interface ReplanOutcome {
  canReplan: boolean;
  reason: string;
  replan?: ReplanRecord;
  newPlan?: TaskPlan;
  newRequirementVersion?: string;
  removedTasks: string[];
  addedTasks: string[];
}

/** Extract a reason code from feedback; null when not replannable. */
export function replanReasonFromFeedback(feedback: TaskExecutionFeedback[]): ReplanReasonCode | null {
  for (const f of feedback) {
    if (f.reasonCode && REPLANNABLE_REASON_CODES.includes(f.reasonCode)) {
      return f.reasonCode;
    }
    if (f.status === "EMPTY") return "EMPTY_RESULT";
    if (f.status === "BLOCKED") return "TOOL_UNAVAILABLE";
  }
  return null;
}

/** Successful task ids from feedback. */
export function completedTaskIdsFromFeedback(feedback: TaskExecutionFeedback[]): Set<string> {
  const out = new Set<string>();
  for (const f of feedback) {
    if (f.status === "SUCCEEDED") out.add(f.taskId);
  }
  return out;
}

/**
 * Attempt a replan.
 *  - replanning disabled → no new plan
 *  - no replannable reason → no new plan
 *  - replan count >= maxReplans → no new plan (CANNOT_PLAN upstream)
 *  - USER_REQUIREMENT_CHANGED → new requirementVersion
 */
export function attemptReplan(input: ReplanInput): ReplanOutcome {
  if (!input.replanningEnabled) {
    return { canReplan: false, reason: "dynamic_replanning disabled", removedTasks: [], addedTasks: [] };
  }

  const reason = replanReasonFromFeedback(input.feedback);
  if (!reason) {
    return { canReplan: false, reason: "no replannable reason code in feedback", removedTasks: [], addedTasks: [] };
  }

  if (input.previousPlan.version >= input.maxReplans + 1) {
    return { canReplan: false, reason: `maxReplans (${input.maxReplans}) exhausted`, removedTasks: [], addedTasks: [] };
  }

  const completed = completedTaskIdsFromFeedback(input.feedback);
  const previousIds = new Set(input.previousPlan.tasks.map((t) => t.taskId));

  // Preserve every completed task id (they must not be re-scheduled);
  // the new plan must not contain them again.
  const preservedTaskIds = [...completed];
  const preserved = input.previousPlan.tasks.filter((t) => completed.has(t.taskId));

  const newPlan = input.buildNewPlan(preserved);

  const removedTasks = input.previousPlan.tasks
    .filter((t) => !preservedTaskIds.includes(t.taskId))
    .map((t) => t.taskId);
  const newIds = new Set(newPlan.tasks.map((t) => t.taskId));
  const addedTasks = [...newIds].filter((id) => !previousIds.has(id));
  const changedTasks = newPlan.tasks
    .filter((t) => previousIds.has(t.taskId))
    .filter((t) => {
      const old = input.previousPlan.tasks.find((p) => p.taskId === t.taskId);
      return old !== undefined && (old.dependsOn.join() !== t.dependsOn.join() || old.capability !== t.capability);
    })
    .map((t) => t.taskId);

  const replan: ReplanRecord = {
    previousPlanId: input.previousPlan.planId,
    previousVersion: input.previousPlan.version,
    newPlanId: newPlan.planId,
    newVersion: input.previousPlan.version + 1,
    reasonCode: reason,
    preservedTasks: preservedTaskIds,
    removedTasks,
    addedTasks,
    changedTasks,
    generatedAt: new Date().toISOString(),
  };

  const requirementChanged = reason === "USER_REQUIREMENT_CHANGED";

  return {
    canReplan: true,
    reason,
    replan,
    newPlan,
    newRequirementVersion: requirementChanged
      ? `req_v${(Number(input.card.status === "PLANNED" ? 2 : 1))}_${input.card.requestId}`
      : undefined,
    removedTasks,
    addedTasks,
  };
}

/** Validate the resulting replan: completed tasks must be preserved. */
export function assertPreserved(
  replan: ReplanRecord | undefined,
  completed: Set<string>,
  validation: PlanValidationResult | undefined,
): PlanValidationResult {
  if (!replan || !validation) return validation ?? { valid: true, issues: [], warnings: [], missingCapabilities: [] };
  for (const id of completed) {
    if (!replan.preservedTasks.includes(id)) {
      return {
        ...validation,
        valid: false,
        issues: [
          ...validation.issues,
          { code: "DUPLICATE_TASK_ID", message: `completed task '${id}' was dropped on replan` },
        ],
      };
    }
  }
  return validation;
}
