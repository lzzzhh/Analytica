/**
 * Plan validator — deterministic hard invariants.
 *
 * Hard checks (never disabled, even under ablation):
 *   - JSON/schema shape (taskId unique, required fields)
 *   - dependency existence
 *   - cycle detection
 *   - task count <= budget
 *   - capability availability
 *   - activationCondition / failurePolicy validity
 *   - maxRetries bounded
 *   - final SYNTHESIZE or explicit output task exists
 *   - user goal not silently replaced
 *   - completed tasks not duplicated on replan
 *
 * Semantic enhancement checks (ablatable with plan_validation=false):
 *   - input availability from upstream tasks
 *   - condition references valid tasks
 */
import type {
  CapabilityDescriptor,
  PlanValidationResult,
  TaskPlan,
  ValidationIssue,
} from "./contracts.ts";

const VALID_CONDITIONS = new Set([
  "ALWAYS",
  "ON_TASK_SUCCESS",
  "ON_TASK_FAILURE",
  "ON_RESULT_EMPTY",
  "ON_EVIDENCE_CONFLICT",
  "ON_REASON_CODE",
]);

const VALID_FAILURE_ACTIONS = new Set(["STOP", "SKIP", "ASK_USER", "REPLAN", "RETRY"]);
const MAX_RETRIES = 3;

export interface ValidatePlanInput {
  plan: TaskPlan;
  goal: string;
  capabilities: CapabilityDescriptor[];
  semanticValidation: boolean;
  /** tasks already completed (REPLAN): must not be re-scheduled */
  completedTaskIds?: Set<string>;
}

export function validatePlan(input: ValidatePlanInput): PlanValidationResult {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const missingCapabilities: string[] = [];
  const { plan } = input;

  const ids = plan.tasks.map((t) => t.taskId);
  const idSet = new Set(ids);

  // 1) duplicate task ids
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) issues.push({ code: "DUPLICATE_TASK_ID", message: `duplicate taskId '${id}'` });
    seen.add(id);
  }

  // 2) dependencies exist
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      if (!idSet.has(d)) {
        issues.push({
          code: "MISSING_DEPENDENCY",
          message: `task '${t.taskId}' depends on unknown task '${d}'`,
          taskId: t.taskId,
        });
      }
    }
  }

  // 3) cycle detection (DFS)
  const cycle = findCycle(plan);
  if (cycle) {
    issues.push({ code: "CYCLIC_DEPENDENCY", message: `cyclic dependency: ${cycle.join(" -> ")}` });
  }

  // 4) task count budget
  if (plan.tasks.length > plan.budget.maxTasks) {
    issues.push({
      code: "TASK_LIMIT_EXCEEDED",
      message: `task count ${plan.tasks.length} exceeds budget ${plan.budget.maxTasks}`,
    });
  }

  // 5) capability availability (hard)
  const capById = new Map(input.capabilities.map((c) => [c.id, c]));
  for (const t of plan.tasks) {
    const cap = capById.get(t.capability);
    if (!cap) {
      missingCapabilities.push(t.capability);
      issues.push({
        code: "CAPABILITY_UNAVAILABLE",
        message: `task '${t.taskId}' requires unknown capability '${t.capability}'`,
        taskId: t.taskId,
      });
    } else if (!cap.available) {
      missingCapabilities.push(t.capability);
      issues.push({
        code: "CAPABILITY_UNAVAILABLE",
        message: `task '${t.taskId}' requires unavailable capability '${t.capability}'`,
        taskId: t.taskId,
      });
    }
  }

  // 6) failurePolicy validity (hard)
  for (const t of plan.tasks) {
    if (!VALID_FAILURE_ACTIONS.has(t.failurePolicy.action)) {
      issues.push({
        code: "INVALID_FAILURE_POLICY",
        message: `task '${t.taskId}' has invalid failure action '${t.failurePolicy.action}'`,
        taskId: t.taskId,
      });
    }
    if (t.failurePolicy.maxRetries < 0 || t.failurePolicy.maxRetries > MAX_RETRIES) {
      issues.push({
        code: "INVALID_FAILURE_POLICY",
        message: `task '${t.taskId}' has unbounded retries (${t.failurePolicy.maxRetries})`,
        taskId: t.taskId,
      });
    }
  }

  // 7) activationCondition validity (semantic unless hard-broken shape)
  for (const t of plan.tasks) {
    const cond = t.activationCondition;
    if (!cond || !VALID_CONDITIONS.has(cond.condition)) {
      issues.push({
        code: "INVALID_CONDITION",
        message: `task '${t.taskId}' has invalid condition '${cond?.condition}'`,
        taskId: t.taskId,
      });
    }
    if (cond?.taskId !== undefined && !idSet.has(cond.taskId)) {
      issues.push({
        code: "INVALID_CONDITION",
        message: `task '${t.taskId}' condition references unknown task '${cond.taskId}'`,
        taskId: t.taskId,
      });
    }
  }

  // 8) inputs available (semantic; ablatable)
  if (input.semanticValidation) {
    const outputsByTask = new Map<string, Set<string>>();
    for (const t of plan.tasks) {
      outputsByTask.set(t.taskId, new Set(t.expectedOutputs));
    }
    const userProvided = new Set<string>([...plan.tasks.map((t) => t.inputs)].flat());
    for (const t of plan.tasks) {
      for (const inputName of t.inputs) {
        const provided = [...outputsByTask.values()].some((s) => s.has(inputName));
        if (!provided && !userProvided.has(inputName) && t.dependsOn.length === 0) {
          warnings.push(`task '${t.taskId}' input '${inputName}' may require user or upstream data`);
        }
      }
    }
  }

  // 9) final output task (hard)
  const hasFinal = plan.tasks.some((t) => t.taskType === "SYNTHESIZE" || !t.optional);
  if (!hasFinal || !plan.tasks.some((t) => t.taskType === "SYNTHESIZE")) {
    issues.push({ code: "NO_FINAL_OUTPUT", message: "plan has no SYNTHESIZE final output task" });
  }

  // 10) goal unchanged (hard)
  if (plan.goal && input.goal && plan.goal !== input.goal) {
    issues.push({
      code: "GOAL_CHANGED",
      message: `plan goal '${plan.goal}' differs from user goal '${input.goal}'`,
    });
  }

  // 11) completed tasks not re-scheduled (hard, replan only)
  if (input.completedTaskIds) {
    for (const t of plan.tasks) {
      if (input.completedTaskIds.has(t.taskId)) {
        issues.push({
          code: "DUPLICATE_TASK_ID",
          message: `completed task '${t.taskId}' is scheduled again on replan`,
          taskId: t.taskId,
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    missingCapabilities: [...new Set(missingCapabilities)],
    cycle: cycle ?? undefined,
  };
}

/** Find a dependency cycle, or null. */
function findCycle(plan: TaskPlan): string[] | null {
  const adj = new Map<string, string[]>();
  for (const t of plan.tasks) adj.set(t.taskId, [...t.dependsOn]);

  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const dfs = (id: string): string[] | null => {
    if (done.has(id)) return null;
    if (visiting.has(id)) {
      const i = stack.indexOf(id);
      return [...stack.slice(i), id];
    }
    visiting.add(id);
    stack.push(id);
    for (const d of adj.get(id) ?? []) {
      const found = dfs(d);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };

  for (const id of plan.tasks.map((t) => t.taskId)) {
    const found = dfs(id);
    if (found) return found;
  }
  return null;
}
