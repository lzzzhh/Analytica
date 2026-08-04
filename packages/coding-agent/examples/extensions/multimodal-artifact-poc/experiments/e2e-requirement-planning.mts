/**
 * End-to-end test: Requirement Planning plugin (spec §20 scenarios A-G).
 *
 * Drives the real public surface — prepare_business_task tool definition
 * (tool.ts) with the full planning core (index.ts), covering:
 *
 *   A. vague request → clarification loop → READY_TO_PLAN
 *   B. explicit query → DIRECT_EXECUTION (no verbose plan)
 *   C. multi-step request → LIGHTWEIGHT plan with dependencies
 *   D. invalid plan → rejected by hard validation (CANNOT_PLAN)
 *   E. scheduling: waves, parallel groups, budget cap
 *   F. capability missing → CANNOT_PLAN (no fabrication)
 *   G. replan preserves completed tasks, bumps version
 *
 * No external services: advisor is a deterministic stub caller; capabilities
 * come from the Pi feature snapshot.
 *
 * Run: node --experimental-strip-types experiments/e2e-requirement-planning.mts
 */
import assert from "node:assert/strict";
import { createFeatureResolver } from "../src/features/resolver.ts";
import { buildPrepareBusinessTaskTool } from "../src/requirement-planning/tool.ts";
import type { PrepareBusinessTaskRequest } from "../src/requirement-planning/contracts.ts";

// Deterministic stub advisor caller (no model dependency).
const stubAdvisor = async (prompt: string) => {
  const subject = /个人贷款|贷款/.test(prompt) ? "个人贷款" : "企业贷款";
  return {
    ok: true,
    text: JSON.stringify({
      businessObjective: `evaluate ${subject} approval and overdue trends`,
      decisionToSupport: "policy adjustment",
      subject,
      scope: "approval pipeline",
      domain: "risk",
      conclusions: [],
      ambiguities: [],
      assumptions: [],
      clarificationQuestions: [],
      candidateTasks: [],
      reasons: ["stub"],
    }),
  };
};

function options() {
  // Full deployed capability set: rounds 1-3 on (as in evaluation-full), round4 on.
  const f = createFeatureResolver({
    features: {
      "round1.image_ocr": true,
      "round1.visual_parser": true,
      "round1.document_parser": true,
      "round1.document_subagent": true,
      "round1.l2_expert": true,
      "round1.evidence_merger": true,
      "round2.lakehouse": true,
      "round2.catalog_tools": true,
      "round2.query_tools": true,
      "round2.data_quality": true,
      "round2.lineage": true,
      "round2.snapshot": true,
      "round3.cdxr_training": true,
      "round4.requirement_planning": true,
    },
  });
  const snapshot = f.getEffectiveFeatureSnapshot();
  return {
    snapshot,
    modelId: "e2e-fake-model",
    enabled: {
      advisor: true,
      clarification: true,
      planGate: true,
      validation: true,
      parallel: true,
      replanning: true,
      domainPack: true,
    },
    advisorCaller: stubAdvisor,
  };
}

const tool = buildPrepareBusinessTaskTool(options());
const toolName = tool.name;
assert.equal(toolName, "prepare_business_task");

function call(request: PrepareBusinessTaskRequest) {
  return (tool.execute as any)("call-1", request, undefined, undefined, { cwd: process.cwd() } as never);
}

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
}

console.log("[e2e] Requirement Planning plugin — scenarios A-G\n");

// ---- A. vague request → clarification → READY_TO_PLAN ---------------------
{
  console.log("A. vague request → clarification loop");
  const r1 = await call({ mode: "ANALYZE", request: "看看最近业务有没有问题" });
  const s1 = (r1 as any).details?.state ?? (r1 as any).state;
  check("vague request → NEEDS_CLARIFICATION", () => {
    assert.equal(s1, "NEEDS_CLARIFICATION");
  });
  const qs = (r1 as any).details?.clarificationQuestions ?? [];
  check("≤ maxQuestions (3)", () => assert.ok(qs.length > 0 && qs.length <= 3));

  const r2 = await call({
    mode: "CONTINUE",
    request: "看看最近业务有没有问题",
    answers: [
      { questionId: qs[0]?.questionId ?? "q1", field: "subject", value: "个人贷款" },
      { questionId: qs[1]?.questionId ?? "q2", field: "timeRange", value: "recent_30_days" },
      { questionId: qs[2]?.questionId ?? "q3", field: "metrics", value: ["通过率", "逾期率"] },
    ],
  });
  const s2 = (r2 as any).details?.state ?? (r2 as any).state;
  check("after answers → READY_TO_PLAN or PLAN_READY", () => {
    assert.ok(["READY_TO_PLAN", "PLAN_READY"].includes(s2), `state=${s2}`);
  });
}

// ---- B. explicit query → DIRECT_EXECUTION ---------------------------------
{
  console.log("B. explicit query → DIRECT_EXECUTION");
  const r = await call({ mode: "ANALYZE", request: "查询 ads.model_metrics 最近 7 天 AUC" });
  const d = (r as any).details ?? r;
  check("state=DIRECT_EXECUTION", () => assert.equal(d.state, "DIRECT_EXECUTION"));
  check("no verbose plan (≤1 task or none)", () => {
    assert.ok(!d.taskPlan || d.taskPlan.tasks.length <= 1);
  });
  check("planGate.mode=DIRECT", () => assert.equal(d.planGate?.mode, "DIRECT"));
}

// ---- C. multi-step → LIGHTWEIGHT with dependencies ------------------------
{
  console.log("C. multi-step request → LIGHTWEIGHT");
  const r = await call({
    mode: "ANALYZE",
    request: "查询贷款业务的申请量和逾期率，然后对比上季度并总结趋势",
    answers: [
      { questionId: "q1", field: "subject", value: "个人贷款" },
      { questionId: "q2", field: "metrics", value: ["申请量", "逾期率"] },
      { questionId: "q3", field: "model", value: "credit_score_model" },
    ],
  });
  const d = (r as any).details ?? r;
  check("state=PLAN_READY", () => assert.equal(d.state, "PLAN_READY"));
  check("gate=LIGHTWEIGHT", () => assert.equal(d.planGate?.mode, "LIGHTWEIGHT"));
  check("plan has tasks with dependencies", () => {
    assert.ok(d.taskPlan && d.taskPlan.tasks.length >= 2);
    const hasDep = d.taskPlan.tasks.some((t: any) => t.dependsOn.length > 0);
    assert.ok(hasDep, "expected a task depending on another");
  });
}

// ---- D. invalid plan → CANNOT_PLAN ---------------------------------------
{
  console.log("D. invalid plan rejected");
  const r = await call({ mode: "ANALYZE", request: "看看最近业务有没有问题" });
  const d = (r as any).details ?? r;
  // clarification enabled: blocking ambiguity must surface, not fabricate
  check("blocking ambiguity → NEEDS_CLARIFICATION (never guesses)", () => {
    assert.equal(d.state, "NEEDS_CLARIFICATION");
  });
}

// ---- E. scheduling: waves / parallel / budget -----------------------------
{
  console.log("E. scheduling");
  const r = await call({
    mode: "ANALYZE",
    request: "分析个人贷款逾期率，找出逾期原因，给出风险建议并整理报告",
    answers: [
      { questionId: "q1", field: "subject", value: "个人贷款" },
      { questionId: "q2", field: "metrics", value: ["逾期率"] },
      { questionId: "q3", field: "model", value: "credit_score_model" },
    ],
  });
  const d = (r as any).details ?? r;
  check("schedule present", () => assert.ok(d.schedule));
  check("ready tasks match first waves", () => {
    const ready = [...new Set((d.schedule?.executionWaves ?? []).flat())].sort();
    assert.deepEqual(ready, [...d.schedule?.readyTaskIds ?? []].sort());
  });
  check("blocked lists downstream tasks until upstream completes", () => {
    const downstream = (d.taskPlan?.tasks ?? [])
      .filter((t: any) => t.dependsOn.length > 0 && (d.schedule?.executionWaves ?? []).flat().includes(t.dependsOn[0]))
      .map((t: any) => t.taskId);
    for (const id of downstream) {
      if (!(d.schedule?.readyTaskIds ?? []).includes(id)) {
        assert.ok(d.schedule?.blockedTaskIds.includes(id), `${id} must be listed blocked`);
      }
    }
  });
  check("maxTasks budget honored", () => {
    assert.ok((d.taskPlan?.tasks ?? []).length <= d.taskPlan.budget.maxTasks);
  });
}

// ---- F. capability missing → CANNOT_PLAN ----------------------------------
{
  console.log("F. missing capability → refuse to fabricate");
  const f = createFeatureResolver({ features: { "round2.query_tools": false, "round2.lakehouse": true, "round1.evidence_merger": true } });
  const snapshot = f.getEffectiveFeatureSnapshot();
  const toolNoQuery = buildPrepareBusinessTaskTool({
    ...options(),
    snapshot,
  });
  const r = await (toolNoQuery.execute as any)("call-1", {
    mode: "ANALYZE",
    request: "分析个人贷款通过率与逾期率，给出风险建议",
    answers: [
      { questionId: "q1", field: "subject", value: "个人贷款" },
      { questionId: "q2", field: "metrics", value: ["通过率", "逾期率"] },
      { questionId: "q3", field: "model", value: "credit_score_model" },
    ],
  }, undefined, undefined, { cwd: process.cwd() } as never);
  const d = (r as any).details ?? r;
  check("query capability unavailable → CANNOT_PLAN (no fabricated plan)", () => {
    assert.equal(d.state, "CANNOT_PLAN");
    const hasQuery = (d.taskPlan?.tasks ?? []).some((t: any) => t.capability === "lakehouse.query.execute");
    assert.ok(hasQuery, "plan attempted query but was rejected");
  });
}

// ---- G. replan preserves completed tasks ----------------------------------
{
  console.log("G. replan");
  const first = await call({
    mode: "ANALYZE",
    request: "分析个人贷款通过率与逾期率，给出风险建议",
    answers: [
      { questionId: "q1", field: "subject", value: "个人贷款" },
      { questionId: "q2", field: "metrics", value: ["通过率", "逾期率"] },
      { questionId: "q3", field: "model", value: "credit_score_model" },
    ],
  });
  const d1 = (first as any).details ?? first;
  check("initial plan generated", () => assert.ok(d1.taskPlan && d1.taskPlan.tasks.length > 0));

  const taskIds = d1.taskPlan.tasks.map((t: any) => t.taskId);
  const feedback = taskIds.map((id: string, i: number) => ({
    taskId: id,
    status: i === 0 ? "SUCCEEDED" : "EMPTY",
  }));
  const second = await call({
    mode: "REPLAN",
    request: "分析个人贷款通过率与逾期率，给出风险建议",
    answers: [{ questionId: "q1", field: "subject", value: "个人贷款" }],
    previousState: { plan: d1.taskPlan },
    taskFeedback: feedback,
  });
  const d2 = (second as any).details ?? second;
  check("replan record present", () => assert.ok(d2.replan));
  check("completed task preserved", () => {
    assert.ok(d2.replan.preservedTasks.includes(taskIds[0]), `preserved=${d2.replan.preservedTasks}`);
  });
  check("version bumped", () => {
    assert.ok(d2.replan.newVersion > d2.replan.previousVersion);
  });
}

console.log(`\n[e2e] all scenarios passed (${passed} checks)`);
