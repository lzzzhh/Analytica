import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createFeatureResolver } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/features/resolver.ts";
import { buildCapabilities } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/requirement-planning/adapters/pi-capabilities.ts";
import { runRequirementPlanning, type PlanningOptions } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/requirement-planning/index.ts";

interface ExpectedSlot { kind: string; value: string }
interface Scenario { id: string; request: string; answers: Array<{ questionId: string; field: string; value: string | string[] }>; expectedState: string; expectedSlots: ExpectedSlot[] }
interface Standards { scenarios: Scenario[] }

const root = resolve("evaluation/phase3-agent-evaluation");
const outputDir = resolve(root, "results/requirement");
mkdirSync(outputDir, { recursive: true });
const standards = JSON.parse(readFileSync(resolve(root, "scenarios/requirement.json"), "utf8")) as Standards;
const resolver = createFeatureResolver({ runtimeProfile: "all-enabled" });
const snapshot = resolver.getEffectiveFeatureSnapshot({ modelId: "deterministic", datasetSnapshot: "phase2-retest" });
const options: PlanningOptions = {
  capabilities: buildCapabilities(snapshot),
  featureSnapshotHash: snapshot.effectiveFeatureHash,
  modelId: "deterministic",
  domainPackEnabled: true,
  clarificationEnabled: true,
  planGateEnabled: true,
  planValidationEnabled: true,
  parallelSchedulingEnabled: true,
  replanningEnabled: true,
  advisorEnabled: false,
};

function norm(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[\s_=-]+/gu, " ").trim();
}

function slotHaystack(kind: string, result: Awaited<ReturnType<typeof runRequirementPlanning>>): string {
  const card = result.requirement;
  if (kind === "dataset") return norm([card.subject, card.scope].join(" "));
  if (kind === "metric") return norm(card.metrics.map((m) => [m.name, m.definition].filter(Boolean).join(" ")).join(" "));
  if (kind === "time_range") return norm([card.timeRange.relative, card.timeRange.start, card.timeRange.end].filter(Boolean).join(" "));
  if (kind === "dimension") return norm(card.dimensions.join(" "));
  if (kind === "comparison") return norm(card.comparisonBaselines.join(" "));
  if (kind === "output") return norm(card.outputRequirements.join(" "));
  if (kind === "constraint") return norm(card.constraints.join(" "));
  return "";
}

function matches(slot: ExpectedSlot, result: Awaited<ReturnType<typeof runRequirementPlanning>>): boolean {
  if (slot.value === "reject executable input") {
    return result.state === "CANNOT_PLAN" && result.warnings.some((warning) => /input rejected/u.test(warning));
  }
  const actual = slotHaystack(slot.kind, result);
  const expected = norm(slot.value);
  const tokens = expected.split(" ").filter((token) => token.length > 1);
  return actual.includes(expected) || (tokens.length > 0 && tokens.every((token) => actual.includes(token)));
}

const records = [];
let routeCorrect = 0;
let slotsFound = 0;
let slotsTotal = 0;
for (const scenario of standards.scenarios) {
  const result = await runRequirementPlanning({ mode: "ANALYZE", request: scenario.request, answers: scenario.answers }, options);
  const slotResults = scenario.expectedSlots.map((slot) => ({ ...slot, found: matches(slot, result) }));
  const routePass = result.state === scenario.expectedState;
  if (routePass) routeCorrect++;
  slotsFound += slotResults.filter((slot) => slot.found).length;
  slotsTotal += slotResults.length;
  const record = { id: scenario.id, status: routePass ? "PASS" : "FAIL", expectedState: scenario.expectedState, actualState: result.state, slotResults, result };
  records.push(record);
  writeFileSync(resolve(outputDir, `${scenario.id}.json`), JSON.stringify(record, null, 2) + "\n");
}
const metrics = {
  status: "PASS",
  routeAccuracy: routeCorrect / standards.scenarios.length,
  routeCorrect,
  routeTotal: standards.scenarios.length,
  constraintRecall: slotsTotal === 0 ? null : slotsFound / slotsTotal,
  slotsFound,
  slotsTotal,
  featureSnapshotHash: snapshot.effectiveFeatureHash,
  records,
};
writeFileSync(resolve(outputDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
writeFileSync(resolve(outputDir, "standards.sha256"), createHash("sha256").update(readFileSync(resolve(root, "scenarios/requirement.json"))).digest("hex") + "\n");
process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
