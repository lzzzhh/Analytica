/**
 * Evaluation harness for the Requirement Planning plugin — 20 curated cases.
 *
 * Drives the real tool (tool.ts) over experiments/requirement-planning/cases.jsonl
 * and checks each case's expected state. Reports a per-case pass/fail table and
 * a final score.
 *
 * Run: node --experimental-strip-types experiments/requirement-planning/evaluate.mts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFeatureResolver } from "../../src/features/resolver.ts";
import { buildPrepareBusinessTaskTool } from "../../src/requirement-planning/tool.ts";
import type { PrepareBusinessTaskRequest } from "../../src/requirement-planning/contracts.ts";

interface Case {
  caseId: string;
  category: string;
  request: string;
  answers: Array<{ questionId: string; field: string; value: unknown }>;
  expectState: string;
  features?: Record<string, boolean>;
  feedback?: string[];
  note?: string;
}

const BASE_FEATURES: Record<string, boolean> = {
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
};

function toolFor(caseItem: Case) {
  const features = { ...BASE_FEATURES, ...(caseItem.features ?? {}) };
  const f = createFeatureResolver({ features });
  return buildPrepareBusinessTaskTool({
    snapshot: f.getEffectiveFeatureSnapshot(),
    modelId: "eval-fake-model",
    enabled: {
      advisor: false,
      clarification: true,
      planGate: true,
      validation: true,
      parallel: true,
      replanning: true,
      domainPack: true,
    },
  });
}

/** Compare actual state against the expected pattern. */
function matches(actual: string, expected: string): boolean {
  switch (expected) {
    case "LIGHTWEIGHT_OR_READY":
      return actual === "PLAN_READY" || actual === "READY_TO_PLAN";
    case "REPLAN_OK":
      return actual === "PLAN_READY";
    default:
      return actual === expected;
  }
}

const path = join(import.meta.dirname, "cases.jsonl");
const cases: Case[] = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

let passed = 0;
let failed = 0;
const failures: Array<{ caseId: string; expected: string; actual: string }> = [];

console.log(`[eval] ${cases.length} cases\n`);
for (const caseItem of cases) {
  const tool = toolFor(caseItem);

  let request: PrepareBusinessTaskRequest = {
    mode: "ANALYZE",
    request: caseItem.request,
    answers: caseItem.answers as never,
  };

  // Replan cases: first get a real plan, then feed feedback back.
  if (caseItem.category === "replan") {
    const first = await (tool.execute as any)(
      "c1", request, undefined, undefined, { cwd: process.cwd() } as never,
    );
    const plan = (first as any).details?.taskPlan;
    if (!plan) {
      failed += 1;
      failures.push({ caseId: caseItem.caseId, expected: "REPLAN_OK (needs plan first)", actual: "no plan" });
      console.log(`  FAIL ${caseItem.caseId}: initial plan missing`);
      continue;
    }
    request = {
      mode: "REPLAN",
      request: caseItem.request,
      answers: caseItem.answers as never,
      previousState: { plan },
      taskFeedback: plan.tasks.map((t: any, i: number) => ({
        taskId: t.taskId,
        status: caseItem.feedback![i] ?? "EMPTY",
      })) as never,
    };
  }

  const r = await (tool.execute as any)("c1", request, undefined, undefined, { cwd: process.cwd() } as never);
  const d = (r as any).details ?? r;
  const actual = d.state;

  if (matches(actual, caseItem.expectState)) {
    passed += 1;
    console.log(`  ok   ${caseItem.caseId} [${caseItem.category}] → ${actual}${caseItem.note ? ` (${caseItem.note})` : ""}`);
  } else {
    failed += 1;
    failures.push({ caseId: caseItem.caseId, expected: caseItem.expectState, actual });
    console.log(`  FAIL ${caseItem.caseId} [${caseItem.category}] expected=${caseItem.expectState} actual=${actual}${caseItem.note ? ` (${caseItem.note})` : ""}`);
  }
}

console.log(`\n[eval] score: ${passed}/${cases.length} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("failures:");
  for (const f of failures) console.log(`  - ${f.caseId}: expected ${f.expected}, got ${f.actual}`);
  process.exitCode = 1;
}
