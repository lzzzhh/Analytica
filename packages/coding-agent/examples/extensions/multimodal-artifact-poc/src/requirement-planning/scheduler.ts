/**
 * Scheduler — deterministic execution-wave computation.
 *
 * First version does NOT execute anything. It only answers: which tasks are
 * ready, which are blocked, and in what waves they could run (for the main
 * agent to drive tool calls).
 */
import type { PlanSchedule, TaskPlan } from "./contracts.ts";

export interface ScheduleContext {
  completedTaskIds: Set<string>;
  failedTaskIds: Set<string>;
  capabilitiesAvailable: Set<string>;
  budgetExceeded: boolean;
  /** ablation: parallel_scheduling=false → one task per wave */
  parallelSchedulingEnabled: boolean;
}

/**
 * A task is ready only when ALL of:
 *  - all dependencies completed (and not failed)
 *  - its capability is available
 *  - not already completed
 *  - budget not exceeded
 */
export function computeSchedule(plan: TaskPlan, ctx: ScheduleContext): PlanSchedule {
  const readyTaskIds: string[] = [];
  const blockedTaskIds: string[] = [];
  const parallelGroups: string[][] = [];

  const completed = ctx.completedTaskIds;
  const failed = ctx.failedTaskIds;

  const taskById = new Map(plan.tasks.map((t) => [t.taskId, t]));
  const waves: string[][] = [];
  const remaining = new Set(
    plan.tasks.map((t) => t.taskId).filter((id) => !completed.has(id)),
  );

  let guard = 0;
  while (remaining.size > 0 && guard < plan.tasks.length + 1) {
    guard += 1;
    const wave: string[] = [];
    for (const t of plan.tasks) {
      if (!remaining.has(t.taskId)) continue;
      const depsOk = t.dependsOn.every(
        (d) => completed.has(d) || (!taskById.has(d) && !failed.has(d)),
      );
      if (!depsOk) continue;
      if (!ctx.capabilitiesAvailable.has(t.capability)) continue;
      if (ctx.budgetExceeded) continue;
      wave.push(t.taskId);
      // parallel_scheduling ablation: strictly one task per wave
      if (!ctx.parallelSchedulingEnabled) break;
    }
    if (wave.length === 0) break;
    for (const id of wave) remaining.delete(id);
    waves.push(wave);
  }

  for (const id of remaining) blockedTaskIds.push(id);

  for (const wave of waves) {
    readyTaskIds.push(...wave);
    parallelGroups.push(wave);
  }

  const executionWaves = waves;

  return { readyTaskIds, blockedTaskIds, executionWaves, parallelGroups };
}
