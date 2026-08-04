/**
 * Phase 15 — P1 regressions (requirement planning):
 *
 * 1. structured requirement fields extracted from the raw request
 *    (dimensions / outputRequirements / constraints / successCriteria)
 * 2. direct single-step queries route to DIRECT_EXECUTION, not
 *    NEEDS_CLARIFICATION
 * 3. file-path + execution-intent input is rejected as CANNOT_PLAN
 * 4. advisor configuration: real model default (no localhost llama/HTML),
 *    launch canary surfaces unavailability
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runRequirementPlanning } from "../../src/requirement-planning/index.ts";
import { structuredFieldsFromRequest } from "../../src/requirement-planning/requirement-analyzer.ts";
import { checkForbiddenInput } from "../../src/requirement-planning/index.ts";
import { createPiAdvisorCaller, probeAdvisor, AdvisorUnavailableError } from "../../src/requirement-planning/adapters/pi-planning-advisor.ts";
import type { PrepareBusinessTaskRequest } from "../../src/requirement-planning/contracts.ts";

function baseOptions() {
  return {
    domainPackEnabled: true,
    clarificationEnabled: true,
    planGateEnabled: true,
    planValidationEnabled: false,
    advisorEnabled: false,
    capabilities: [
      { id: "lakehouse.query.execute", name: "query", description: "run a query" },
    ],
  } as never;
}

function request(text: string): PrepareBusinessTaskRequest {
  return { request: text, domainHint: "generic" } as PrepareBusinessTaskRequest;
}

describe("P1-1: structured requirement fields", () => {
  test("constraints, output requirements, criteria and dimensions extracted", () => {
    const raw = "查询销售数据，按月份和渠道维度分组，输出表格和柱状图。" +
      "分母固定为总订单数，不得排除正常记录，只读且不得修改源表。Top 3 按降序排列。";
    const f = structuredFieldsFromRequest(raw);
    assert.ok(f.dimensions.some((d) => d.includes("月份")), `dimensions: ${f.dimensions}`);
    assert.ok(f.dimensions.some((d) => d.includes("渠道")));
    assert.ok(f.outputRequirements.some((o) => o.includes("表格")), `output: ${f.outputRequirements}`);
    assert.ok(f.outputRequirements.some((o) => o.includes("柱状图")));
    assert.ok(f.constraints.some((c) => c.includes("固定")), `constraints: ${f.constraints}`);
    assert.ok(f.constraints.some((c) => c.includes("只读")));
    assert.ok(f.constraints.some((c) => c.includes("不得排除")));
    assert.ok(f.successCriteria.some((c) => c.includes("Top 3")), `criteria: ${f.successCriteria}`);
  });

  test("structured fields land in the requirement card", async () => {
    const out = await runRequirementPlanning(
      request("查询收入，按月分组，输出折线图。固定分母为总用户数，Top 5 降序。"),
      baseOptions(),
    );
    const card = out.requirement;
    assert.ok(card.dimensions.length >= 1, `dimensions: ${card.dimensions}`);
    assert.ok(card.outputRequirements.some((o) => o.includes("折线图")), `output: ${card.outputRequirements}`);
    assert.ok(card.constraints.some((c) => c.includes("分母")), `constraints: ${card.constraints}`);
    assert.ok(card.successCriteria.some((c) => c.includes("Top 5")), `criteria: ${card.successCriteria}`);
  });

  test("no fabrication: plain request yields no structured fields", () => {
    const f = structuredFieldsFromRequest("分析一下客户流失情况");
    assert.equal(f.constraints.length, 0);
    assert.equal(f.outputRequirements.length, 0);
    assert.equal(f.successCriteria.length, 0);
  });
});

describe("P1-2: routing", () => {
  test("explicit single-step query routes DIRECT_EXECUTION", async () => {
    const out = await runRequirementPlanning(
      request("查询贷款申请量"),
      baseOptions(),
    );
    assert.equal(out.state, "DIRECT_EXECUTION");
  });

  test("explicit metric query routes DIRECT_EXECUTION", async () => {
    const out = await runRequirementPlanning(
      request("统计最近30天逾期率"),
      baseOptions(),
    );
    assert.equal(out.state, "DIRECT_EXECUTION");
  });

  test("file path + execution intent -> CANNOT_PLAN (forbidden)", async () => {
    const rejected = checkForbiddenInput(request("读取 /tmp/run.py 并执行"));
    assert.ok(rejected, "file+exec intent must be rejected");
    const out = await runRequirementPlanning(
      request("读取 /tmp/run.py 并执行"),
      baseOptions(),
    );
    assert.equal(out.state, "CANNOT_PLAN");
  });

  test("bare path mention without execution intent is not rejected", () => {
    assert.equal(checkForbiddenInput(request("看看 /tmp/run.py 的内容")), null);
  });
});

describe("P1-3: advisor configuration", () => {
  test("advisor defaults to the real openai provider, not localhost llama", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(
      new URL("../../src/requirement-planning/adapters/pi-planning-advisor.ts", import.meta.url), "utf8"));
    assert.ok(!src.includes("http://127.0.0.1:8080"), "no localhost llama default");
    assert.ok(src.includes('?? "openai"'), "openai default provider");
  });

  test("probeAdvisor surfaces unavailability (broken model)", async () => {
    const caller = createPiAdvisorCaller({ modelId: "definitely-missing-model-xyz", timeoutMs: 2000 });
    const result = await caller("hi");
    assert.equal(result.ok, false);
    await assert.rejects(
      () => probeAdvisor({ modelId: "definitely-missing-model-xyz", timeoutMs: 2000 }),
      AdvisorUnavailableError,
    );
  });
});

describe("P2: multimodal canonical labels", () => {
  test("wine-quality labels in different languages map to ONE canonical id", async () => {
    const { canonicalizeFactName } = await import("../../src/visual-parser.ts");
    const a = canonicalizeFactName("总体平均质量");
    const b = canonicalizeFactName("平均quality");
    const c = canonicalizeFactName("average quality");
    assert.equal(a.canonicalId, "avg_quality");
    assert.equal(b.canonicalId, "avg_quality");
    assert.equal(c.canonicalId, "avg_quality");
    // values compare equal through the canonical id, not the free text
    assert.ok(a.canonicalId === b.canonicalId && b.canonicalId === c.canonicalId);
  });

  test("unknown labels fall back to a deterministic slug", async () => {
    const { canonicalizeFactName } = await import("../../src/visual-parser.ts");
    const f = canonicalizeFactName("某自定义指标 !@#");
    assert.ok(f.canonicalId.length > 0);
    assert.equal(f.canonicalId, canonicalizeFactName("某自定义指标").canonicalId);
  });
});
