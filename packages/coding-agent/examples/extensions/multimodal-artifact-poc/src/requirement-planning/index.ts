/**
 * Requirement Planning — core orchestration entry.
 *
 * Pure deterministic flow (advisor optional, injected):
 *   ANALYZE  → detect ambiguity → NEEDS_CLARIFICATION | plan gate → plan
 *   CONTINUE → merge answers → re-analyze → plan gate → plan
 *   REPLAN   → apply feedback → bounded replan → new plan version
 *
 * The core never executes business tools, never writes data, never approves
 * assumptions, and never mutates the user's final goal.
 */
import type {
  AdvisorOutput,
  BusinessRequirementCard,
  BusinessPlanningState,
  CapabilityDescriptor,
  ClarificationQuestion,
  PlanGateResult,
  PlanSchedule,
  PlanValidationResult,
  PrepareBusinessTaskRequest,
  PrepareBusinessTaskResult,
  ReplanRecord,
  RequirementPlanningDecisionLog,
  TaskPlan,
} from "./contracts.ts";
import { DEFAULT_CONSTRAINTS, FORBIDDEN_INPUT_PATTERNS } from "./contracts.ts";
import { analyzeRequirement, newRequestId, summarizeRequest } from "./requirement-analyzer.ts";
import { answeredFields } from "./ambiguity.ts";
import { assumptionsFromAnswers, mergeAssumptions } from "./assumptions.ts";
import { evaluatePlanGate } from "./plan-gate.ts";
import { buildTaskPlan, schedulePlan } from "./task-plan-builder.ts";
import { validatePlan } from "./plan-validator.ts";
import { computeSchedule } from "./scheduler.ts";
import { attemptReplan } from "./replanner.ts";
import { selectDomainPack } from "./domain-packs/index.ts";
import type { DomainPack } from "./domain-packs/contracts.ts";

export interface PlanningOptions {
  capabilities: CapabilityDescriptor[];
  featureSnapshotHash: string;
  modelId: string;
  domainPackEnabled: boolean;
  clarificationEnabled: boolean;
  planGateEnabled: boolean;
  planValidationEnabled: boolean;
  parallelSchedulingEnabled: boolean;
  replanningEnabled: boolean;
  advisorEnabled: boolean;
  advisorCaller?: (prompt: string) => Promise<{ ok: boolean; text: string; error?: string }>;
  rawTextStoreEnabled?: boolean;
}

export interface CoreState {
  card: BusinessRequirementCard;
  questions: ClarificationQuestion[];
  planGate: PlanGateResult;
  plan?: TaskPlan;
  validation?: PlanValidationResult;
  schedule?: PlanSchedule;
  replan?: ReplanRecord;
  state: PrepareBusinessTaskResult["state"];
  warnings: string[];
  missingCapabilities: string[];
  advisorOutput?: AdvisorOutput | null;
  advisorReasonCodes: string[];
  rawRequest: string;
  answeredQuestionIds: string[];
  replanCount: number;
  requirementVersion: string;
  planVersion: number | null;
}

/** Deterministic input safety gate — executable content never reaches the core. */
export function checkForbiddenInput(request: PrepareBusinessTaskRequest): string | null {
  const text = [request.request ?? "", request.conversationSummary ?? ""].join("\n");
  for (const pattern of FORBIDDEN_INPUT_PATTERNS) {
    if (pattern.test(text)) {
      return `input rejected: contains executable content matching ${pattern}`;
    }
  }
  return null;
}

export function toPlanningState(state: CoreState): BusinessPlanningState {
  return {
    requestId: state.card.requestId,
    requirement: state.card,
    plan: state.plan,
    validation: state.validation,
    schedule: state.schedule,
    replanCount: state.replanCount,
    answeredQuestionIds: state.answeredQuestionIds,
  };
}

/**
 * Run the requirement planning pipeline for one invocation.
 */
export async function runRequirementPlanning(
  request: PrepareBusinessTaskRequest,
  options: PlanningOptions,
): Promise<PrepareBusinessTaskResult> {
  const started = Date.now();
  const warnings: string[] = [];

  const rejected = checkForbiddenInput(request);
  if (rejected) {
    warnings.push(rejected);
    return buildResult(request, options, {
      state: "CANNOT_PLAN",
      warnings: [rejected],
      card: emptyCard(request),
      questions: [],
      planGate: { mode: "DIRECT", score: 0, reasons: [] },
      missingCapabilities: [],
      advisorReasonCodes: ["ADVISOR_OUTPUT_INVALID"],
      rawRequest: request.request ?? "",
      answeredQuestionIds: [],
      replanCount: 0,
      requirementVersion: `req_v1_${request.request ?? ""}`,
      planVersion: null,
    }, started);
  }

  // --- domain selection -------------------------------------------------
  const domainPackEnabled = options.domainPackEnabled;
  const { pack: domainPack, adoptedHint } = selectDomainPack(
    request.request ?? "",
    request.domainHint,
    domainPackEnabled,
  );

  // --- advisor (optional, isolated) --------------------------------------
  let advisorOutput: AdvisorOutput | null = null;
  let advisorReasonCodes: string[] = [];
  if (options.advisorEnabled && options.advisorCaller && request.request) {
    const result = await runAdvisorInternal(options, request, domainPack.packId);
    advisorOutput = result.output;
    advisorReasonCodes = result.reasonCodes;
    if (result.error) warnings.push(result.error);
  }

  // --- analysis ----------------------------------------------------------
  const answered = answeredFields(request.answers);
  const analyzed = analyzeRequirement({
    rawRequest: request.request ?? "",
    domainHint: request.domainHint,
    answers: request.answers,
    domainPack,
    domainPackAdopted: adoptedHint,
  });

  const card = analyzed.card;
  let questions = analyzed.questions;
  const blocking = analyzed.blockingAmbiguities;
  let state: PrepareBusinessTaskResult["state"] = "READY_TO_PLAN";

  // clarification off → blocking ambiguity returns CANNOT_PLAN (no guessing)
  const clarificationEnabled = options.clarificationEnabled;
  if (blocking.length > 0 && !clarificationEnabled) {
    warnings.push(
      `clarification disabled and ${blocking.length} blocking ambiguity(ies) present — refusing to guess`,
    );
    state = "CANNOT_PLAN";
  } else if (blocking.length > 0) {
    state = "NEEDS_CLARIFICATION";
    // max questions bound
    const maxQuestions = request.constraints?.maxQuestions ?? DEFAULT_CONSTRAINTS.maxQuestions;
    questions = questions.slice(0, maxQuestions);
  }

  // --- plan gate ----------------------------------------------------------
  const gate = evaluatePlanGate({
    card,
    capabilities: options.capabilities,
    rawRequest: request.request ?? "",
    planGateEnabled: options.planGateEnabled,
  });

  // --- task plan -----------------------------------------------------------
  let plan: TaskPlan | undefined;
  let validation: PlanValidationResult | undefined;
  let schedule: PlanSchedule | undefined;
  let replan: ReplanRecord | undefined;

  const availableCaps = new Map(options.capabilities.map((c) => [c.id, c.available]));
  const missingCaps = options.capabilities
    .filter((c) => !c.available)
    .map((c) => c.id);
  const requiredCaps = advisorOutput?.candidateTasks
    ?.map((t) => t.capability)
    .filter((c) => !availableCaps.get(c)) ?? [];

  const allMissing = [...new Set([...missingCaps, ...requiredCaps])];

  // cannot plan when the required capability family is entirely unavailable
  const coreFamilyMissing = ["lakehouse.query.execute", "document.analyze", "training.assess", "agent.synthesize"]
    .filter((c) => options.capabilities.some((cap) => cap.id === c) && !availableCaps.get(c));

  if (state === "READY_TO_PLAN") {
    const gateMode = gate.mode;

    // Direct queries (single explicit query, no blocking ambiguity) run
    // immediately without a verbose task plan.
    if (gateMode === "DIRECT") {
      state = "DIRECT_EXECUTION";
    } else if (gateMode === "LIGHTWEIGHT" || gateMode === "FORMAL") {
      const constraints = {
        maxTasks: request.constraints?.maxTasks ?? DEFAULT_CONSTRAINTS.maxTasks,
        maxToolCalls: request.constraints?.maxToolCalls ?? DEFAULT_CONSTRAINTS.maxToolCalls,
        maxSubagents: request.constraints?.maxSubagents ?? DEFAULT_CONSTRAINTS.maxSubagents,
        maxReplans: request.constraints?.maxReplans ?? DEFAULT_CONSTRAINTS.maxReplans,
      };

      const taskPlan = buildTaskPlan({
        card,
        gateMode,
        capabilities: availableCaps,
        constraints,
        candidateTasks: advisorOutput?.candidateTasks ?? [],
      });

      plan = taskPlan;

      const hardValid = validatePlan({
        plan: taskPlan,
        goal: card.businessObjective || card.rawRequestSummary,
        capabilities: options.capabilities,
        semanticValidation: options.planValidationEnabled,
      });

      // capability unavailability → cannot honestly execute
      if (hardValid.issues.some((i) => i.code === "CAPABILITY_UNAVAILABLE")) {
        state = "CANNOT_PLAN";
        warnings.push("required capability unavailable — refusing to fabricate an executable plan");
        validation = hardValid;
      } else {
        validation = hardValid;
        if (hardValid.valid) {
          state = "PLAN_READY";
          const completed = new Set<string>();
          const failed = new Set<string>();
          for (const f of request.taskFeedback ?? []) {
            if (f.status === "SUCCEEDED") completed.add(f.taskId);
            if (f.status === "FAILED" || f.status === "EMPTY" || f.status === "BLOCKED") failed.add(f.taskId);
          }
          schedule = computeSchedule(taskPlan, {
            completedTaskIds: completed,
            failedTaskIds: failed,
            capabilitiesAvailable: new Set(options.capabilities.filter((c) => c.available).map((c) => c.id)),
            budgetExceeded: taskPlan.tasks.length > taskPlan.budget.maxTasks,
            parallelSchedulingEnabled: options.parallelSchedulingEnabled,
          });
        } else {
          state = "CANNOT_PLAN";
        }
      }
    }
  }

  // --- replan --------------------------------------------------------------
  let replanCount = 0;
  if (request.mode === "REPLAN" && request.taskFeedback && request.taskFeedback.length > 0) {
    replanCount = 1;
    const feedbackCompleted = new Set<string>();
    for (const f of request.taskFeedback) {
      if (f.status === "SUCCEEDED") feedbackCompleted.add(f.taskId);
    }
    // deterministically attempt a replan (buildNewPlan = rebuild from preserved tasks)
    const replanAttempt = attemptReplan({
      previousPlan: request.previousState?.plan ?? emptyPlan(card),
      previousVersion: request.previousState?.plan?.version ?? 1,
      card,
      feedback: request.taskFeedback,
      maxReplans: request.constraints?.maxReplans ?? DEFAULT_CONSTRAINTS.maxReplans,
      replanningEnabled: options.replanningEnabled,
      buildNewPlan: (preservedTasks) => {
        const base = buildTaskPlan({
          card,
          gateMode: gate.mode,
          capabilities: availableCaps,
          constraints: {
            maxTasks: request.constraints?.maxTasks ?? DEFAULT_CONSTRAINTS.maxTasks,
            maxToolCalls: request.constraints?.maxToolCalls ?? DEFAULT_CONSTRAINTS.maxToolCalls,
            maxSubagents: request.constraints?.maxSubagents ?? DEFAULT_CONSTRAINTS.maxSubagents,
            maxReplans: request.constraints?.maxReplans ?? DEFAULT_CONSTRAINTS.maxReplans,
          },
          candidateTasks: advisorOutput?.candidateTasks ?? [],
          preservedTasks,
        });
        base.version = (request.previousState?.plan?.version ?? 1) + 1;
        return base;
      },
    });

    if (replanAttempt.canReplan && replanAttempt.newPlan && replanAttempt.replan) {
      plan = replanAttempt.newPlan;
      replan = replanAttempt.replan;
      const replanValidation = validatePlan({
        plan,
        goal: card.businessObjective || card.rawRequestSummary,
        capabilities: options.capabilities,
        semanticValidation: options.planValidationEnabled,
        completedTaskIds: feedbackCompleted,
      });
      validation = replanValidation;
      if (replanValidation.valid) {
        state = "PLAN_READY";
        schedule = computeSchedule(plan, {
          completedTaskIds: feedbackCompleted,
          failedTaskIds: new Set(),
          capabilitiesAvailable: new Set(options.capabilities.filter((c) => c.available).map((c) => c.id)),
          budgetExceeded: plan.tasks.length > plan.budget.maxTasks,
          parallelSchedulingEnabled: options.parallelSchedulingEnabled,
        });
      } else {
        state = "CANNOT_PLAN";
      }
    } else {
      warnings.push(replanAttempt.reason || "replan not possible");
      if (plan && request.previousState?.plan) {
        // keep original plan status visible; report failure only
        state = plan.tasks.length > 0 ? "PLAN_READY" : "CANNOT_PLAN";
      }
    }
  }

  // --- result ----------------------------------------------------------------
  const coreState: CoreState = {
    card,
    questions,
    planGate: gate,
    plan,
    validation,
    schedule,
    replan,
    state,
    warnings,
    missingCapabilities: allMissing,
    advisorOutput,
    advisorReasonCodes,
    rawRequest: request.request ?? "",
    answeredQuestionIds: [...answered],
    replanCount,
    requirementVersion: `req_v1_${card.requestId}`,
    planVersion: plan?.version ?? null,
  };

  return buildResult(request, options, coreState, started);
}

function emptyPlan(card: BusinessRequirementCard): TaskPlan {
  return {
    planId: `plan_${card.requestId}`,
    version: 1,
    requestId: card.requestId,
    goal: card.rawRequestSummary,
    requirementVersion: `req_v1_${card.requestId}`,
    tasks: [],
    budget: { maxTasks: 12, maxToolCalls: 20, maxSubagents: 4, maxReplans: 1 },
    replanPolicy: { maxReplans: 1, allowedReasonCodes: [] },
    createdAt: new Date().toISOString(),
  };
}

function emptyCard(request: PrepareBusinessTaskRequest): BusinessRequirementCard {
  return {
    requestId: request.previousState?.requirement.requestId ?? newRequestId(request.request ?? ""),
    rawRequestSummary: summarizeRequest(request.request ?? ""),
    domain: "general",
    businessObjective: "",
    decisionToSupport: "",
    subject: "",
    scope: "",
    timeRange: { source: "UNKNOWN" },
    metrics: [],
    dimensions: [],
    comparisonBaselines: [],
    successCriteria: [],
    outputRequirements: [],
    constraints: [],
    assumptions: [],
    ambiguities: [],
    confidence: 0,
    status: "REJECTED",
  };
}

async function runAdvisorInternal(
  options: PlanningOptions,
  request: PrepareBusinessTaskRequest,
  domainPackId: string,
): Promise<{ output: AdvisorOutput | null; reasonCodes: string[]; error?: string }> {
  // inline to avoid circular imports; same logic as advisor.runAdvisor
  const { runAdvisor } = await import("./advisor.ts");
  const result = await runAdvisor(
    {
      modelId: options.modelId,
      domainPackId,
      enabled: options.advisorEnabled,
      caller: options.advisorCaller!,
    },
    request,
  );
  return {
    output: result.output,
    reasonCodes: result.reasonCode === "ADVISOR_OUTPUT_INVALID" ? ["ADVISOR_OUTPUT_INVALID"] : [],
    error: result.error,
  };
}

function buildResult(
  request: PrepareBusinessTaskRequest,
  options: PlanningOptions,
  core: CoreState,
  startedMs: number,
): PrepareBusinessTaskResult {
  const durationMs = Date.now() - startedMs;
  const log: RequirementPlanningDecisionLog = {
    requestId: core.card.requestId,
    mode: request.mode,
    requirementVersion: core.requirementVersion,
    planVersion: core.planVersion,
    modelId: options.modelId,
    domainPack: core.card.domain,
    featureSnapshotHash: options.featureSnapshotHash,
    planGateMode: core.planGate.mode,
    ambiguityCount: core.card.ambiguities.length,
    blockingAmbiguityCount: core.card.ambiguities.filter((a) => a.blocking).length,
    clarificationQuestionCount: core.questions.length,
    assumptionCount: core.card.assumptions.length,
    taskCount: core.plan?.tasks.length ?? 0,
    missingCapabilities: core.missingCapabilities,
    replanCount: core.replanCount,
    reasonCodes: core.advisorReasonCodes,
    durationMs,
  };

  const userAssumptions = mergeAssumptions(
    assumptionsFromAnswers(request.answers),
    core.card.assumptions,
  );

  const result: PrepareBusinessTaskResult = {
    requestId: core.card.requestId,
    state: core.state,
    requirement: core.card,
    clarificationQuestions: core.questions,
    planGate: core.planGate,
    taskPlan: core.plan,
    validation: core.validation,
    schedule: core.schedule,
    replan: core.replan,
    availableCapabilities: options.capabilities.filter((c) => c.available).map((c) => c.id),
    missingCapabilities: core.missingCapabilities,
    featureSnapshotHash: options.featureSnapshotHash,
    warnings: core.warnings,
    decisionLog: log,
  };

  if (userAssumptions.length > core.card.assumptions.length) {
    result.requirement.assumptions = userAssumptions;
  }

  return result;
}
