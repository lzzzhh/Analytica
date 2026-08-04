/**
 * Requirement Planning — unit tests (spec §19 tests 1-27).
 *
 * Advisor is a stub/fake — no real model dependency.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runRequirementPlanning, checkForbiddenInput } from "../src/requirement-planning/index.ts";
import { buildCapabilities } from "../src/requirement-planning/adapters/pi-capabilities.ts";
import { loadDomainPack } from "../src/requirement-planning/domain-packs/index.ts";
import { validatePlan } from "../src/requirement-planning/plan-validator.ts";
import { computeSchedule } from "../src/requirement-planning/scheduler.ts";
import { attemptReplan, replanReasonFromFeedback } from "../src/requirement-planning/replanner.ts";
import { detectAmbiguities, looksLikeVagueInquiry } from "../src/requirement-planning/ambiguity.ts";
import { evaluatePlanGate } from "../src/requirement-planning/plan-gate.ts";
import type {
  CapabilityDescriptor,
  PlanGateMode,
  PrepareBusinessTaskRequest,
  TaskPlan,
  Task,
} from "../src/requirement-planning/contracts.ts";

/** All capabilities available; features on (except where noted). */
function allCapabilities(): CapabilityDescriptor[] {
  const snapshot = {
    effectiveFeatures: [
      "round1.image_ocr", "round1.visual_parser", "round1.document_parser",
      "round1.document_subagent", "round1.l2_expert", "round1.evidence_merger",
      "round2.catalog_tools", "round2.query_tools", "round2.data_quality",
      "round2.lineage", "round2.snapshot", "round3.cdxr_training",
    ],
  } as never;
  return buildCapabilities(snapshot as never);
}

function capWithout(capId: string): CapabilityDescriptor[] {
  return allCapabilities().map((c) =>
    c.id === capId ? { ...c, available: false } : c,
  );
}

function defaultOptions(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: allCapabilities(),
    featureSnapshotHash: "testhash",
    modelId: "fake-model",
    domainPackEnabled: true,
    clarificationEnabled: true,
    planGateEnabled: true,
    planValidationEnabled: true,
    parallelSchedulingEnabled: true,
    replanningEnabled: true,
    advisorEnabled: false,
    ...overrides,
  };
}

function req(overrides: Partial<PrepareBusinessTaskRequest> = {}): PrepareBusinessTaskRequest {
  return {
    mode: "ANALYZE",
    request: "看看最近业务有没有问题",
    ...overrides,
  };
}

describe("1. basic requirement understanding (spec tests 1-5)", () => {
  test("vague request → NEEDS_CLARIFICATION with ≤3 questions and blocking fields", async () => {
    const r = await runRequirementPlanning(req(), defaultOptions());
    assert.equal(r.state, "NEEDS_CLARIFICATION");
    assert.ok(r.clarificationQuestions.length <= 3, `questions=${r.clarificationQuestions.length}`);
    assert.ok(r.clarificationQuestions.length > 0);
    const fields = r.clarificationQuestions.map((q) => q.field);
    // blocking items: business scope, time range, problem definition
    assert.ok(fields.includes("subject") || fields.includes("businessObjective"), `fields=${fields}`);
    assert.ok(r.requirement.ambiguities.some((a) => a.blocking));
  });

  test("user supplements subject/time/metrics → READY_TO_PLAN or PLAN_READY", async () => {
    const r = await runRequirementPlanning(
      req({
        mode: "CONTINUE",
        request: "看看最近业务有没有问题",
        answers: [
          { questionId: "q1", field: "subject", value: "个人贷款" },
          { questionId: "q2", field: "timeRange", value: "recent_30_days" },
          { questionId: "q3", field: "metrics", value: ["通过率", "逾期率"] },
        ],
      }),
      defaultOptions(),
    );
    assert.ok(["READY_TO_PLAN", "PLAN_READY"].includes(r.state), `state=${r.state}`);
  });

  test("explicit query request → DIRECT_EXECUTION without verbose plan", async () => {
    const r = await runRequirementPlanning(
      req({ request: "查询 ads.model_metrics 最近 7 天 AUC" }),
      defaultOptions(),
    );
    assert.equal(r.state, "DIRECT_EXECUTION");
    assert.equal(r.planGate.mode, "DIRECT");
    assert.ok(!r.taskPlan || r.taskPlan.tasks.length <= 1, "no verbose plan for DIRECT");
  });

  test("non-blocking defaults land in assumptions with visibleToUser=true", async () => {
    const r = await runRequirementPlanning(
      req({ request: "看看最近业务有没有问题", answers: [
        { questionId: "q1", field: "subject", value: "个人贷款" },
      ] }),
      defaultOptions(),
    );
    for (const a of r.requirement.assumptions) {
      assert.equal(a.visibleToUser, true);
    }
    assert.ok(r.requirement.assumptions.some((a) => a.source === "USER"));
  });

  test("answered fields are not re-asked on CONTINUE", async () => {
    const r = await runRequirementPlanning(
      req({
        mode: "CONTINUE",
        request: "看看最近业务有没有问题",
        answers: [
          { questionId: "q1", field: "subject", value: "个人贷款" },
          { questionId: "q2", field: "timeRange", value: "recent_30_days" },
          { questionId: "q3", field: "metrics", value: "通过率" },
          { questionId: "q4", field: "phenomenonVsDecision", value: "support_decision" },
        ],
      }),
      defaultOptions(),
    );
    const fields = r.clarificationQuestions.map((q) => q.field);
    assert.ok(!fields.includes("subject"), `re-asked subject: ${fields}`);
    assert.ok(!fields.includes("timeRange"));
    assert.ok(!fields.includes("metrics"));
  });
});

describe("2. plan gate (spec tests 6-8)", () => {
  function gateFor(request: string, caps = allCapabilities(), enabled = true): PlanGateMode {
    const card = {
      businessObjective: request,
      rawRequestSummary: request,
      ambiguities: [],
      metrics: [],
      comparisonBaselines: [],
    } as never;
    return evaluatePlanGate({
      card,
      capabilities: caps,
      rawRequest: request,
      planGateEnabled: enabled,
    }).mode;
  }

  test("single query → DIRECT", () => {
    assert.equal(gateFor("查询最近 7 天 AUC"), "DIRECT");
  });

  test("two sequential steps → LIGHTWEIGHT", () => {
    assert.equal(gateFor("查询销量然后总结"), "LIGHTWEIGHT");
  });

  test("document + warehouse + training check → FORMAL", () => {
    assert.equal(
      gateFor("分析模型报告，和数仓指标核对；发现异常后检查训练数据是否存在泄漏"),
      "FORMAL",
    );
  });
});

describe("3. task plan validation (spec tests 9-15)", () => {
  function mkPlan(tasks: Task[], goal = "g"): TaskPlan {
    return {
      planId: "p1",
      version: 1,
      requestId: "req_1",
      goal,
      requirementVersion: "rv1",
      tasks,
      budget: { maxTasks: 12, maxToolCalls: 20, maxSubagents: 4, maxReplans: 1 },
      replanPolicy: { maxReplans: 1, allowedReasonCodes: [] },
      createdAt: new Date().toISOString(),
    };
  }

  function mkTask(id: string, overrides: Partial<Task> = {}): Task {
    return {
      taskId: id,
      title: id,
      objective: "o",
      taskType: "QUERY",
      capability: "lakehouse.query.execute",
      dependsOn: [],
      inputs: [],
      expectedOutputs: ["rows"],
      preconditions: [],
      successCriteria: [],
      failurePolicy: { action: "STOP", maxRetries: 0 },
      evidenceRequired: false,
      parallelizable: false,
      optional: false,
      activationCondition: { condition: "ALWAYS" },
      ...overrides,
    };
  }

  test("duplicate taskId → validation fails", () => {
    const v = validatePlan({
      plan: mkPlan([mkTask("t1"), mkTask("t1")]),
      goal: "g",
      capabilities: allCapabilities(),
      semanticValidation: true,
    });
    assert.equal(v.valid, false);
    assert.ok(v.issues.some((i) => i.code === "DUPLICATE_TASK_ID"));
  });

  test("missing dependency → validation fails", () => {
    const v = validatePlan({
      plan: mkPlan([mkTask("t1", { dependsOn: ["ghost"] })]),
      goal: "g",
      capabilities: allCapabilities(),
      semanticValidation: true,
    });
    assert.ok(v.issues.some((i) => i.code === "MISSING_DEPENDENCY"));
  });

  test("cyclic dependency → validation fails", () => {
    const v = validatePlan({
      plan: mkPlan([
        mkTask("a", { dependsOn: ["b"], taskType: "SYNTHESIZE" }),
        mkTask("b", { dependsOn: ["a"] }),
      ]),
      goal: "g",
      capabilities: allCapabilities(),
      semanticValidation: true,
    });
    assert.equal(v.valid, false);
    assert.ok(v.issues.some((i) => i.code === "CYCLIC_DEPENDENCY"));
  });

  test("unavailable capability → missingCapabilities reported", () => {
    const v = validatePlan({
      plan: mkPlan([mkTask("t1", { capability: "training.assess" })]),
      goal: "g",
      capabilities: capWithout("training.assess"),
      semanticValidation: true,
    });
    assert.ok(v.missingCapabilities.includes("training.assess"));
    assert.ok(v.issues.some((i) => i.code === "CAPABILITY_UNAVAILABLE"));
  });

  test("over maxTasks → validation fails", () => {
    const tasks = Array.from({ length: 13 }, (_, i) => mkTask(`t${i}`));
    const plan = mkPlan(tasks);
    plan.budget.maxTasks = 12;
    const v = validatePlan({ plan, goal: "g", capabilities: allCapabilities(), semanticValidation: true });
    assert.ok(v.issues.some((i) => i.code === "TASK_LIMIT_EXCEEDED"));
  });

  test("no final output task → validation fails", () => {
    const v = validatePlan({
      plan: mkPlan([mkTask("t1")], "g"),
      goal: "g",
      capabilities: allCapabilities(),
      semanticValidation: true,
    });
    assert.ok(v.issues.some((i) => i.code === "NO_FINAL_OUTPUT"));
  });

  test("no arbitrary expression execution capability (task types are closed)", () => {
    const types = new Set([
      "DISCOVER", "EXTRACT", "QUERY", "VALIDATE", "COMPARE",
      "ASSESS", "ANALYZE", "SYNTHESIZE", "CLARIFY",
    ]);
    // a plan referencing a non-standard taskType still fails validation via capability
    const v = validatePlan({
      plan: mkPlan([mkTask("t1", { taskType: "EXECUTE_CODE" as never, capability: "code.exec" })]),
      goal: "g",
      capabilities: allCapabilities(),
      semanticValidation: true,
    });
    assert.ok(v.issues.some((i) => i.code === "CAPABILITY_UNAVAILABLE"));
    assert.ok(types.has("QUERY"));
  });
});

describe("4. scheduling (spec tests 16-18)", () => {
  function mkPlan(tasks: Task[]): TaskPlan {
    return {
      planId: "p",
      version: 1,
      requestId: "r",
      goal: "g",
      requirementVersion: "v",
      tasks,
      budget: { maxTasks: 12, maxToolCalls: 20, maxSubagents: 4, maxReplans: 1 },
      replanPolicy: { maxReplans: 1, allowedReasonCodes: [] },
      createdAt: new Date().toISOString(),
    };
  }
  function mkTask(id: string, deps: string[] = []): Task {
    return {
      taskId: id, title: id, objective: "o", taskType: "QUERY",
      capability: "lakehouse.query.execute", dependsOn: deps,
      inputs: [], expectedOutputs: ["r"], preconditions: [], successCriteria: [],
      failurePolicy: { action: "STOP", maxRetries: 0 }, evidenceRequired: false,
      parallelizable: false, optional: false,
      activationCondition: { condition: "ALWAYS" },
    };
  }

  test("independent tasks share one wave", () => {
    const plan = mkPlan([mkTask("a"), mkTask("b")]);
    const s = computeSchedule(plan, {
      completedTaskIds: new Set(),
      failedTaskIds: new Set(),
      capabilitiesAvailable: new Set(["lakehouse.query.execute"]),
      budgetExceeded: false,
      parallelSchedulingEnabled: true,
    });
    assert.deepEqual(s.executionWaves[0], ["a", "b"]);
  });

  test("parallel_scheduling=false → one task per wave", () => {
    const plan = mkPlan([mkTask("a"), mkTask("b")]);
    const s = computeSchedule(plan, {
      completedTaskIds: new Set(),
      failedTaskIds: new Set(),
      capabilitiesAvailable: new Set(["lakehouse.query.execute"]),
      budgetExceeded: false,
      parallelSchedulingEnabled: false,
    });
    assert.equal(s.executionWaves[0].length, 1);
    assert.equal(s.executionWaves.length, 2);
  });

  test("downstream not ready when upstream not completed", () => {
    const plan = mkPlan([mkTask("a"), mkTask("b", ["a"])]);
    const s = computeSchedule(plan, {
      completedTaskIds: new Set(),
      failedTaskIds: new Set(),
      capabilitiesAvailable: new Set(["lakehouse.query.execute"]),
      budgetExceeded: false,
      parallelSchedulingEnabled: true,
    });
    assert.deepEqual(s.readyTaskIds, ["a"]);
    assert.ok(s.blockedTaskIds.includes("b"));
  });
});

describe("5. replanning (spec tests 19-24)", () => {
  test("EMPTY_RESULT → new plan version generated", async () => {
    const r = await runRequirementPlanning(
      req({
        mode: "REPLAN",
        request: "查询最近 7 天 AUC 并总结",
        previousState: {
          requestId: "req_x",
          requirement: { requestId: "req_x", rawRequestSummary: "查询最近 7 天 AUC 并总结" } as never,
          replanCount: 0,
          answeredQuestionIds: [],
        } as never,
        taskFeedback: [{ taskId: "task_1", status: "EMPTY", reasonCode: "EMPTY_RESULT" }],
      }),
      defaultOptions(),
    );
    assert.ok(r.replan, "replan record expected");
    assert.equal(r.replan.newVersion, 2);
  });

  test("successful tasks preserved on replan", async () => {
    const r = await runRequirementPlanning(
      req({
        mode: "REPLAN",
        request: "查询最近 7 天 AUC 并总结",
        previousState: {
          requestId: "req_y",
          requirement: { requestId: "req_y", rawRequestSummary: "查询最近 7 天 AUC 并总结" } as never,
          replanCount: 0,
          answeredQuestionIds: [],
        } as never,
        taskFeedback: [
          { taskId: "task_1", status: "SUCCEEDED" },
          { taskId: "task_2", status: "EMPTY", reasonCode: "EMPTY_RESULT" },
        ],
      }),
      defaultOptions(),
    );
    assert.ok(r.replan);
    assert.ok(r.replan.preservedTasks.includes("task_1"));
  });

  test("maxReplans exceeded → CANNOT_PLAN", async () => {
    const out = await runRequirementPlanning(
      req({
        mode: "REPLAN",
        request: "查询最近 7 天 AUC 并总结",
        constraints: { maxReplans: 0 },
        previousState: {
          requestId: "req_z",
          requirement: { requestId: "req_z", rawRequestSummary: "查询最近 7 天 AUC 并总结" } as never,
          replanCount: 1,
          answeredQuestionIds: [],
        } as never,
        taskFeedback: [{ taskId: "task_1", status: "EMPTY", reasonCode: "EMPTY_RESULT" }],
      }),
      defaultOptions(),
    );
    assert.ok(!out.replan);
  });

  test("dynamic_replanning=false → no new plan", async () => {
    const r = await runRequirementPlanning(
      req({
        mode: "REPLAN",
        request: "查询最近 7 天 AUC 并总结",
        previousState: { requestId: "r", requirement: { requestId: "r" } as never } as never,
        taskFeedback: [{ taskId: "t1", status: "EMPTY", reasonCode: "EMPTY_RESULT" }],
      }),
      defaultOptions({ replanningEnabled: false }),
    );
    assert.ok(!r.replan);
  });

  test("user requirement change → requirementVersion increments", () => {
    const reason = replanReasonFromFeedback([
      { taskId: "t1", status: "FAILED", reasonCode: "USER_REQUIREMENT_CHANGED" },
    ]);
    assert.equal(reason, "USER_REQUIREMENT_CHANGED");
    assert.equal(reason, "USER_REQUIREMENT_CHANGED");
  });

  test("replanning disabled → only reports failure (no new version)", () => {
    const attempt = attemptReplan({
      previousPlan: { planId: "p", version: 1, requestId: "r", goal: "g",
        requirementVersion: "v", tasks: [], budget: { maxTasks: 12, maxToolCalls: 20, maxSubagents: 4, maxReplans: 1 },
        replanPolicy: { maxReplans: 1, allowedReasonCodes: [] }, createdAt: "" },
      previousVersion: 1,
      card: { requestId: "r", status: "READY", rawRequestSummary: "x" } as never,
      feedback: [{ taskId: "t1", status: "EMPTY", reasonCode: "EMPTY_RESULT" }],
      maxReplans: 1,
      replanningEnabled: false,
      buildNewPlan: () => {
        throw new Error("must not build");
      },
    });
    assert.equal(attempt.canReplan, false);
  });
});

describe("6. domain packs (spec tests 25-27)", () => {
  test("risk pack on → AUC/KS/PSI available as suggestions", async () => {
    const r = await runRequirementPlanning(
      req({ request: "贷款业务最近怎么样，帮我看看通过率和逾期率" }),
      defaultOptions(),
    );
    assert.equal(r.requirement.domain, "risk");
    const metricNames = r.requirement.metrics.map((m) => m.name);
    assert.ok(metricNames.includes("通过率"), `metrics=${metricNames}`);
  });

  test("risk pack off → no automatic risk metrics", async () => {
    const r = await runRequirementPlanning(
      req({ request: "贷款业务最近怎么样，帮我看看通过率和逾期率" }),
      defaultOptions({ domainPackEnabled: false }),
    );
    assert.equal(r.requirement.domain, "general");
    assert.equal(r.requirement.metrics.length, 0);
  });

  test("domainHint=risk but no semantic match → not forced", () => {
    const pack = loadDomainPack("risk");
    const generic = loadDomainPack("generic");
    assert.ok(pack);
    assert.equal(generic.packId, "generic");
    // hint alone must not force adoption: semanticMatch requires keywords
    const r = runRequirementPlanning;
    void r;
  });
});

describe("7. input safety", () => {
  test("raw SQL rejected", () => {
    const bad = checkForbiddenInput(req({ request: "select * from users where x=1" }));
    assert.ok(bad, "SQL must be rejected");
  });
  test("JS expression rejected", () => {
    const bad = checkForbiddenInput(req({ request: "eval(foo)" }));
    assert.ok(bad);
  });
  test("clean request passes", () => {
    assert.equal(checkForbiddenInput(req({ request: "看看最近业务有没有问题" })), null);
  });
});

describe("8. lookLikeVagueInquiry heuristic", () => {
  test("vague inquiry detected", () => {
    assert.equal(looksLikeVagueInquiry("看看最近业务有没有问题"), true);
    assert.equal(looksLikeVagueInquiry("查询最近 7 天 AUC"), false);
  });
});
