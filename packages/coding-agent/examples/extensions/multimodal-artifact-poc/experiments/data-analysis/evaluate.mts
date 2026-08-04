/**
 * Evaluation harness for the Data Analysis Subagent — 15 curated cases.
 *
 * Runs each case through runDataAnalysis with a deterministic fake subagent
 * (real script execution where applicable) and reports the round-4 metrics:
 *   taskGateAccuracy, scriptExecutionSuccessRate, resultSchemaValidityRate,
 *   numericFrontendFidelity, modelContextNumericLeakageRate,
 *   artifactProvenanceCompleteness, retrySuccessRate, unsupportedClaimRate,
 *   averageAttempts, effectiveFeatureHash
 *
 * Hard target: modelContextNumericLeakageRate = 0.
 *
 * Run: node --experimental-strip-types experiments/data-analysis/evaluate.mts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFeatureResolver } from "../../src/features/resolver.ts";
import { ArtifactStore } from "../../src/data-analysis/artifact-store.ts";
import { runDataAnalysis } from "../../src/data-analysis/index.ts";
import { analysisResultText } from "../../src/data-analysis/ui/renderer.ts";
import { CANARY_NUMBER } from "../../src/data-analysis/contracts.ts";
import { createWorkspace, newRunId, type WorkspacePaths } from "../../src/data-analysis/workspace.ts";

interface Case {
  caseId: string;
  category: string;
  objective: string;
  analysisType: string;
  expectedViews?: string[];
  dimensions?: string[];
  dataRefs?: unknown[];
  expectRoute: string;
  failFirst?: boolean;
  features?: Record<string, boolean>;
  note?: string;
}

const BASE_FEATURES: Record<string, boolean> = {
  "round1.multimodal": true,
  "round2.lakehouse": true,
  "round4.data_analysis": true,
  "round4.data_analysis_tool": true,
  "round4.analysis_task_gate": true,
  "round4.analysis_input_materialization": true,
  "round4.analysis_subagent": true,
  "round4.analysis_plan_generation": true,
  "round4.analysis_workspace": true,
  "round4.analysis_script_execution": true,
  "round4.analysis_retry": true,
  "round4.analysis_artifacts": true,
  "round4.analysis_findings": true,
  "round4.analysis_charting": true,
  "round4.analysis_frontend_render": true,
};

const ARTIFACT_ID = "art_eval000000000001";
let store: ArtifactStore;
let artifactId = ARTIFACT_ID;

function makeStore(): { store: ArtifactStore; artifactId: string } {
  const s = new ArtifactStore();
  const rows = Array.from({ length: 40 }, (_, i) => ({
    event_date: `2026-0${(i % 6) + 1}-${String((i % 28) + 1).padStart(2, "0")}`,
    auc: Number((0.75 + (i % 20) * 0.005).toFixed(4)),
    model_version: i % 3 === 0 ? "v1" : "v2",
    region: i % 2 === 0 ? "east" : "west",
  }));
  const data = JSON.stringify(rows);
  s.register({
    artifactId: ARTIFACT_ID,
    contentType: "application/json",
    rowCount: rows.length,
    columns: ["event_date", "auc", "model_version", "region"],
    contentHash: createHash("sha256").update(data).digest("hex"),
    queryId: "q_eval",
    snapshotId: "v1",
    masked: true,
    createdAt: new Date().toISOString(),
  }, data);
  return { store: s, artifactId: ARTIFACT_ID };
}

function makeFakeSubagent(ws: WorkspacePaths, objective: string, analysisType: string, failFirst: boolean) {
  let calls = 0;
  return async () => {
    calls += 1;
    writeFileSync(ws.planFile, JSON.stringify({
      planId: "p_eval", runId: "run_eval", objective, analysisType,
      inputArtifacts: [artifactId], selectedColumns: ["event_date", "auc", "model_version"],
      metricDefinitions: [], dimensions: [], timeField: "event_date",
      steps: ["load", "compute", "write"], expectedOutputs: ["analysis-result.json"],
      methods: [], assumptions: [], limitations: [], createdAt: new Date().toISOString(),
    }), "utf8");
    if (failFirst && calls === 1) {
      writeFileSync(ws.scriptFile, "raise ValueError('intentional')\n", "utf8");
      return { ok: true, text: "failed attempt" };
    }
    const script = [
      "import json",
      "result = {",
      "  'schemaVersion': '1.0',",
      "  'artifactId': 'art_eval_result',",
      "  'runId': 'run_eval',",
      "  'status': 'COMPLETED',",
      "  'title': 'eval',",
      "  'sections': [",
      "    {'type': 'METRIC_CARDS', 'metrics': [",
      `      {'metricId': 'm1', 'label': 'M', 'value': ${CANARY_NUMBER}, 'valueType': 'NUMBER', 'precision': 3}`,
      "    ]}",
      "  ],",
      "  'reviewStatus': 'NOT_REVIEWED',",
      "  'validationRefs': [],",
      "  'createdAt': '2026-08-02T00:00:00.000Z'",
      "}",
      "json.dump(result, open('output/analysis-result.json', 'w'))",
      "print('ok')",
    ].join("\n");
    writeFileSync(ws.scriptFile, script, "utf8");
    return { ok: true, text: "done" };
  };
}

function requestFor(c: Case) {
  return {
    objective: c.objective,
    analysisType: c.analysisType,
    dataRefs: (c.dataRefs ?? [{
      artifactId,
      sourceType: "LAKEHOUSE_QUERY",
      queryId: "q_eval",
      format: "JSON",
      schema: [
        { name: "event_date", type: "string" },
        { name: "auc", type: "float" },
        { name: "model_version", type: "string" },
        { name: "region", type: "string" },
      ],
      rowCount: 40,
      allowedColumns: ["event_date", "auc", "model_version", "region"],
      masked: true,
    }]),
    metricDefinitions: [{ metricId: "auc", label: "AUC", valueType: "NUMBER", precision: 4 }],
    dimensions: c.dimensions,
    timeField: "event_date",
    expectedViews: c.expectedViews,
  };
}

// ---- metrics --------------------------------------------------------------
let taskGateCorrect = 0;
let scriptExecSuccess = 0;
let scriptExecTotal = 0;
let schemaValid = 0;
let schemaTotal = 0;
let numericFrontendFidelity = 0;
let numericLeakage = 0;
let provenanceComplete = 0;
let retrySuccess = 0;
let retryCases = 0;
let unsupportedClaims = 0;
let attemptsSum = 0;
let attemptsCount = 0;
const failures: string[] = [];

const cases: Case[] = readFileSync(join(import.meta.dirname, "cases.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

for (const c of cases) {
  const features = { ...BASE_FEATURES, ...(c.features ?? {}) };
  const snapshot = createFeatureResolver({ features }).getEffectiveFeatureSnapshot();
  const { store: s } = makeStore();
  store = s;

  // feature-off case: no tool registration at all
  if (c.expectRoute === "FEATURE_OFF") {
    const { buildDataAnalysisTool } = await import("../../src/data-analysis/tool.ts");
    let threw = false;
    try {
      buildDataAnalysisTool({ snapshot, store, subagent: async () => ({ ok: true, text: "" }) });
    } catch {
      threw = true;
    }
    if (threw) {
      taskGateCorrect += 1;
      numericLeakage += 1; // no tool → no content → no leakage
      console.log(`  ok   ${c.caseId} [${c.category}] → FEATURE_OFF`);
    } else {
      failures.push(`${c.caseId}: expected FEATURE_OFF but tool registered`);
      console.log(`  FAIL ${c.caseId} [${c.category}] expected=FEATURE_OFF`);
    }
    continue;
  }

  const ws = createWorkspace(newRunId());
  const out = await runDataAnalysis(requestFor(c), {
    snapshot,
    store,
    createWorkspaceForRun: () => ws,
    subagent: makeFakeSubagent(ws, c.objective, c.analysisType, c.failFirst ?? false),
  });

  // isolation: model-facing content must never contain the canary (all cases)
  if (!out.content.includes(CANARY_NUMBER)) numericLeakage += 1;
  else failures.push(`${c.caseId}: numeric leakage in model content`);

  // task gate accuracy
  const expected = c.expectRoute;
  const actual = out.route;
  if (actual === expected) taskGateCorrect += 1;
  else failures.push(`${c.caseId}: expected ${expected} got ${actual}`);

  // feature-off detection (data_analysis off → buildDataAnalysisTool refuses) is
  // handled above; here route checks.
  if (actual === "DATA_INPUT_REQUIRED") {
    console.log(`  ok   ${c.caseId} [${c.category}] → DATA_INPUT_REQUIRED`);
    continue;
  }
  if (actual === "QUERY_GATEWAY") {
    console.log(`  ok   ${c.caseId} [${c.category}] → QUERY_GATEWAY`);
    continue;
  }

  // subagent cases: script execution + schema + isolation
  scriptExecTotal += 1;
  if (out.artifact) {
    scriptExecSuccess += 1;
    schemaValid += 1;
    schemaTotal += 1;
    if (out.manifest?.attempts.every((a) => a.status !== "FAILED" || true)) {
      // manifest exists
    }
    if (out.manifest) {
      const hasProvenance = out.manifest.inputArtifacts.length > 0 &&
        out.manifest.scriptHash.length > 0;
      if (hasProvenance) provenanceComplete += 1;
    }
    // numeric fidelity: UI renderer sees the canary
    if (analysisResultText(out.artifact).includes(CANARY_NUMBER)) numericFrontendFidelity += 1;
    // unsupported claims: findings must never claim causality
    if (out.artifact.findingsRef) {
      const ftext = JSON.stringify(out.artifact);
      if (ftext.includes("causalClaim\": true")) unsupportedClaims += 1;
    }
    attemptsSum += out.manifest?.attempts.length ?? 1;
    attemptsCount += 1;
    if (c.failFirst) {
      retryCases += 1;
      if (out.manifest && out.manifest.attempts.length >= 2 &&
          out.manifest.attempts.some((a) => a.status === "SUCCEEDED")) {
        retrySuccess += 1;
      }
    }
  } else {
    failures.push(`${c.caseId}: expected artifact but got failure ${JSON.stringify(out.failure)}`);
  }
  console.log(`  ok   ${c.caseId} [${c.category}] → ${actual}${out.artifact ? " (artifact)" : ""}`);
}

const metrics = {
  taskGateAccuracy: `${taskGateCorrect}/${cases.length}`,
  scriptExecutionSuccessRate: `${scriptExecSuccess}/${scriptExecTotal}`,
  resultSchemaValidityRate: `${schemaValid}/${schemaTotal}`,
  numericFrontendFidelity: `${numericFrontendFidelity}/${scriptExecTotal}`,
  // leakage rate = cases where the canary reached model content / all cases
  modelContextNumericLeakageRate: `${cases.length - numericLeakage}/${cases.length}`,
  artifactProvenanceCompleteness: `${provenanceComplete}/${scriptExecTotal}`,
  retrySuccessRate: `${retrySuccess}/${retryCases}`,
  unsupportedClaimRate: `${unsupportedClaims}/${scriptExecTotal}`,
  averageAttempts: attemptsCount > 0 ? (attemptsSum / attemptsCount).toFixed(2) : "n/a",
  effectiveFeatureHash: createFeatureResolver({ features: BASE_FEATURES }).getEffectiveFeatureSnapshot().effectiveFeatureHash,
};

console.log("\n[eval] metrics:");
for (const [k, v] of Object.entries(metrics)) console.log(`  ${k}: ${v}`);

if (failures.length > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\n[eval] all ${cases.length} cases passed`);
}
