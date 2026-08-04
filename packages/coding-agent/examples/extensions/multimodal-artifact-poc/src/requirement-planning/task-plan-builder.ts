/**
 * Task plan builder — deterministic candidate TaskPlan generation.
 *
 * Maps a BusinessRequirementCard + plan gate mode to a task list. Uses only
 * abstract capabilities (capability-registry.ts). Never invents business
 * semantics; the plan is a candidate that the main agent may accept.
 */
import type {
  AdvisorCandidateTask,
  BusinessRequirementCard,
  PlanGateMode,
  PlanSchedule,
  Task,
  TaskPlan,
} from "./contracts.ts";
import { TASK_TYPE_CAPABILITIES } from "./capability-registry.ts";

export interface BuildPlanInput {
  card: BusinessRequirementCard;
  gateMode: PlanGateMode;
  capabilities: Map<string, boolean>;
  constraints: { maxTasks: number; maxToolCalls: number; maxSubagents: number; maxReplans: number };
  candidateTasks: AdvisorCandidateTask[];
  /** Existing plan tasks to preserve (REPLAN only). */
  preservedTasks?: Task[];
}

let planSeq = 0;

function nextPlanId(requestId: string): string {
  planSeq += 1;
  return `plan_${requestId.replace(/^req_/, "")}_${planSeq}`;
}

/** Deterministic availability check: any capability in the family available. */
function familyAvailable(taskType: string, capabilities: Map<string, boolean>): boolean {
  const family = TASK_TYPE_CAPABILITIES[taskType] ?? [];
  return family.length > 0 && family.some((c) => capabilities.get(c) === true);
}

function pickCapability(taskType: string, capabilities: Map<string, boolean>): string | null {
  const family = TASK_TYPE_CAPABILITIES[taskType] ?? [];
  for (const c of family) {
    if (capabilities.get(c) === true) return c;
  }
  return family[0] ?? null;
}

/**
 * Build a candidate plan:
 *  - DIRECT mode → single QUERY task (no verbose plan)
 *  - LIGHTWEIGHT → 2-3 tasks
 *  - FORMAL → full discovery → extract/query → validate → analyze → synthesize
 */
export function buildTaskPlan(input: BuildPlanInput): TaskPlan {
  const { card, gateMode, capabilities, constraints } = input;
  const createdAt = new Date().toISOString();
  const tasks: Task[] = [];
  const preservedIds = new Set((input.preservedTasks ?? []).map((t) => t.taskId));
  let taskSeq = 0;
  const nextTask = () => {
    taskSeq += 1;
    // Never reuse an id of a preserved (already completed) task.
    while (preservedIds.has(`task_${taskSeq}`)) taskSeq += 1;
    return `task_${taskSeq}`;
  };

  const plan: TaskPlan = {
    planId: nextPlanId(card.requestId),
    version: 1,
    requestId: card.requestId,
    goal: card.businessObjective || card.rawRequestSummary,
    requirementVersion: `req_v1_${card.requestId}`,
    tasks: [],
    budget: {
      maxTasks: constraints.maxTasks,
      maxToolCalls: constraints.maxToolCalls,
      maxSubagents: constraints.maxSubagents,
      maxReplans: constraints.maxReplans,
    },
    replanPolicy: { maxReplans: constraints.maxReplans, allowedReasonCodes: [] },
    createdAt,
  };

  if (gateMode === "DIRECT") {
    const cap = pickCapability("QUERY", capabilities);
    if (cap) {
      tasks.push({
        taskId: nextTask(),
        title: "query requested data",
        objective: "execute the explicit query and return results",
        taskType: "QUERY",
        capability: cap,
        dependsOn: [],
        inputs: [card.rawRequestSummary],
        expectedOutputs: ["query_result"],
        preconditions: [],
        successCriteria: ["rows_returned"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: true,
        parallelizable: false,
        optional: false,
        activationCondition: { condition: "ALWAYS" },
      });
    }
  } else if (gateMode === "LIGHTWEIGHT") {
    // 2-3 steps: query → synthesize (order preserved when dependencies exist)
    const queryCap = pickCapability("QUERY", capabilities);
    const synthCap = pickCapability("SYNTHESIZE", capabilities);
    if (queryCap) {
      tasks.push({
        taskId: nextTask(),
        title: "query business data",
        objective: "fetch the requested metrics/values",
        taskType: "QUERY",
        capability: queryCap,
        dependsOn: [],
        inputs: [card.rawRequestSummary],
        expectedOutputs: ["query_result"],
        preconditions: [],
        successCriteria: ["rows_returned"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: true,
        parallelizable: false,
        optional: false,
        activationCondition: { condition: "ALWAYS" },
      });
    }
    if (synthCap) {
      tasks.push({
        taskId: nextTask(),
        title: "synthesize answer",
        objective: "summarize findings into the final answer",
        taskType: "SYNTHESIZE",
        capability: synthCap,
        dependsOn: tasks.length ? [tasks[0]!.taskId] : [],
        inputs: ["query_result"],
        expectedOutputs: ["final_answer"],
        preconditions: [],
        successCriteria: ["answer_produced"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: false,
        parallelizable: false,
        optional: false,
        activationCondition: { condition: "ALWAYS" },
      });
    }
  } else {
    // FORMAL: full pipeline.
    const id = nextTask;
    const hasDoc = card.domain === "general" || input.candidateTasks.some((c) => c.capability.startsWith("document."));
    const candidateByType = new Map<string, AdvisorCandidateTask>();
    for (const c of input.candidateTasks) candidateByType.set(c.taskType, c);

    // 1) discover
    const discoverCap = pickCapability("DISCOVER", capabilities);
    if (discoverCap) {
      tasks.push({
        taskId: id(),
        title: "discover relevant data sources",
        objective: "locate datasets covering the subject and metrics",
        taskType: "DISCOVER",
        capability: discoverCap,
        dependsOn: [],
        inputs: [card.subject || "unknown subject"],
        expectedOutputs: ["dataset_candidates"],
        preconditions: [],
        successCriteria: ["candidates_found"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: false,
        parallelizable: false,
        optional: false,
        activationCondition: { condition: "ALWAYS" },
      });
    }

    // 2) document analysis when requested
    let docTaskId: string | null = null;
    if (hasDoc && capabilities.get("document.analyze") === true) {
      docTaskId = id();
      tasks.push({
        taskId: docTaskId,
        title: "analyze report document",
        objective: "extract business facts from the report",
        taskType: "EXTRACT",
        capability: "document.analyze",
        dependsOn: [],
        inputs: ["report_document"],
        expectedOutputs: ["document_facts"],
        preconditions: [],
        successCriteria: ["facts_extracted"],
        failurePolicy: { action: "ASK_USER", maxRetries: 0 },
        evidenceRequired: true,
        parallelizable: true,
        optional: false,
        activationCondition: { condition: "ALWAYS" },
      });
    }

    // 3) query metrics
    const queryCap = pickCapability("QUERY", capabilities);
    if (queryCap) {
      tasks.push({
        taskId: id(),
        title: "query business metrics",
        objective: "fetch metrics from the warehouse",
        taskType: "QUERY",
        capability: queryCap,
        dependsOn: docTaskId ? [docTaskId] : [],
        inputs: [card.metrics.map((m) => m.name).join(", ") || "metrics"],
        expectedOutputs: ["metric_values"],
        preconditions: [],
        successCriteria: ["rows_returned"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: true,
        parallelizable: false,
        optional: false,
        activationCondition: { condition: "ALWAYS" },
      });
    }

    // 4) compare with baseline / cross-source validation
    const compareCap = pickCapability("COMPARE", capabilities);
    if (compareCap && card.comparisonBaselines.length > 0) {
      const compareId = id();
      tasks.push({
        taskId: compareId,
        title: "compare against baseline",
        objective: "contrast current metrics with the baseline period",
        taskType: "COMPARE",
        capability: compareCap,
        dependsOn: [tasks[1]?.taskId ?? ""].filter(Boolean),
        inputs: ["metric_values", "baseline"],
        expectedOutputs: ["comparison_result"],
        preconditions: [],
        successCriteria: ["comparison_produced"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: true,
        parallelizable: false,
        optional: false,
        activationCondition: { condition: "ALWAYS" },
      });
    }

    // 5) conditional training check (only when anomaly found).
    //    The task is added whenever the request signals training-data
    //    concerns; if the capability is unavailable the plan validator
    //    rejects the plan (CAPABILITY_UNAVAILABLE) instead of silently
    //    skipping the check.
    if (/训练|泄漏/.test(card.rawRequestSummary)) {
      tasks.push({
        taskId: id(),
        title: "assess training data",
        objective: "check the training dataset for leakage when anomalies are found",
        taskType: "ASSESS",
        capability: "training.assess",
        dependsOn: [tasks[tasks.length - 1]?.taskId ?? ""].filter(Boolean),
        inputs: ["dataset_candidates", "document_facts"],
        expectedOutputs: ["training_assessment"],
        preconditions: [],
        successCriteria: ["assessment_produced"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: true,
        parallelizable: false,
        optional: /训练|泄漏/.test(card.rawRequestSummary) && !/评估|检查|质量/.test(card.rawRequestSummary),
        activationCondition: { condition: "ALWAYS" },
      });
    }

    // 6) analyze
    const analyzeCap = pickCapability("ANALYZE", capabilities);
    if (analyzeCap) {
      tasks.push({
        taskId: id(),
        title: "analyze anomalies and causes",
        objective: "reason over the evidence to explain anomalies",
        taskType: "ANALYZE",
        capability: analyzeCap,
        dependsOn: [tasks[1]?.taskId ?? ""].filter(Boolean),
        inputs: ["metric_values", "comparison_result"],
        expectedOutputs: ["anomaly_analysis"],
        preconditions: [],
        successCriteria: ["analysis_produced"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: false,
        parallelizable: false,
        optional: false,
        activationCondition: { condition: "ALWAYS" },
      });
    }

    // 7) synthesize (final output task — required by validation)
    const synthCap = pickCapability("SYNTHESIZE", capabilities);
    if (synthCap) {
      tasks.push({
        taskId: id(),
        title: "synthesize final answer",
        objective: "combine all evidence into the final business answer",
        taskType: "SYNTHESIZE",
        capability: synthCap,
        dependsOn: [tasks[tasks.length - 1]?.taskId ?? ""].filter(Boolean),
        inputs: ["anomaly_analysis", "comparison_result"],
        expectedOutputs: ["final_answer"],
        preconditions: [],
        successCriteria: ["answer_produced"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: false,
        parallelizable: false,
        optional: false,
        activationCondition: { condition: "ALWAYS" },
      });
    }
  }

  // Candidate advisor tasks that fit available capabilities (FORMAL only).
  if (gateMode === "FORMAL") {
    for (const c of input.candidateTasks) {
      if (tasks.length >= constraints.maxTasks) break;
      if (tasks.some((t) => t.title === c.title)) continue;
      const cap = pickCapability(c.taskType, capabilities);
      if (!cap) continue;
      const last = tasks[tasks.length - 1];
      tasks.push({
        taskId: nextTask(),
        title: c.title,
        objective: c.objective,
        taskType: c.taskType,
        capability: cap,
        dependsOn: c.dependsOn.length ? c.dependsOn : last ? [last.taskId] : [],
        inputs: [],
        expectedOutputs: ["result"],
        preconditions: [],
        successCriteria: ["result_produced"],
        failurePolicy: { action: "STOP", maxRetries: 0 },
        evidenceRequired: false,
        parallelizable: c.taskType === "EXTRACT" || c.taskType === "DISCOVER",
        optional: c.optional,
        activationCondition: { condition: "ALWAYS" },
      });
    }
  }

  plan.tasks = tasks.slice(0, constraints.maxTasks);
  return plan;
}

/**
 * Compute execution schedule (ready/blocked/waves) WITHOUT executing
 * anything. A task is ready when all deps are satisfied. parallel_scheduling
 * ablation: one task per wave.
 */
export function schedulePlan(
  plan: TaskPlan,
  completed: Set<string>,
  parallelSchedulingEnabled: boolean,
): PlanSchedule {
  const taskById = new Map(plan.tasks.map((t) => [t.taskId, t]));
  const readyTaskIds: string[] = [];
  const blockedTaskIds: string[] = [];
  const executionWaves: string[][] = [];

  const remaining = new Set(plan.tasks.map((t) => t.taskId));
  while (remaining.size > 0) {
    const wave: string[] = [];
    for (const t of plan.tasks) {
      if (!remaining.has(t.taskId)) continue;
      const depsOk = t.dependsOn.every((d) => completed.has(d) || !taskById.has(d));
      if (depsOk) wave.push(t.taskId);
    }
    if (wave.length === 0) {
      // cycle or unresolvable deps: everything left is blocked
      for (const id of remaining) blockedTaskIds.push(id);
      break;
    }
    for (const id of wave) remaining.delete(id);
    executionWaves.push(wave);
  }

  const processed = new Set<string>();
  for (const wave of executionWaves) for (const id of wave) processed.add(id);
  for (const t of plan.tasks) {
    if (!processed.has(t.taskId)) blockedTaskIds.push(t.taskId);
  }

  const ready = executionWaves[0] ?? [];
  const allReady = [...ready];
  return {
    readyTaskIds: allReady,
    blockedTaskIds: [...new Set(blockedTaskIds)],
    executionWaves: parallelSchedulingEnabled
      ? executionWaves
      : executionWaves.map((w) => w.slice(0, 1)),
    parallelGroups: parallelSchedulingEnabled ? executionWaves : executionWaves.map((w) => w.slice(0, 1)),
  };
}
