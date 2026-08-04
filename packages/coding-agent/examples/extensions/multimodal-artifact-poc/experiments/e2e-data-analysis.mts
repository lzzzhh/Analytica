/**
 * E2E: Data Analysis Subagent (spec §19 scenarios A-G).
 *
 * Drives the real run_data_analysis tool with a stub subagent (no model) but
 * REAL controlled script execution (python3 <workspace>/analysis.py).
 *
 *   A. simple aggregation → QUERY_GATEWAY (no subagent)
 *   B. period comparison → subagent + script execution + UI views
 *   C. breakdown → table + findings (evidenceRefs)
 *   D. script failure → bounded retry (attempts=2)
 *   E. missing input → DATA_INPUT_REQUIRED
 *   F. feature off → tool not registered
 *   G. frontend render off → tool not registered (no recitation fallback)
 *
 * Run: node --experimental-strip-types experiments/e2e-data-analysis.mts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createFeatureResolver } from "../src/features/resolver.ts";
import { ArtifactStore } from "../src/data-analysis/artifact-store.ts";
import { buildDataAnalysisTool } from "../src/data-analysis/tool.ts";
import { runDataAnalysis } from "../src/data-analysis/index.ts";
import { analysisResultText } from "../src/data-analysis/ui/renderer.ts";
import { CANARY_NUMBER } from "../src/data-analysis/contracts.ts";
import { createWorkspace, newRunId, type WorkspacePaths } from "../src/data-analysis/workspace.ts";
import type { FeatureSnapshot } from "../src/features/types.ts";

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
}

function snapshotWith(features: Record<string, boolean>): FeatureSnapshot {
  const f = createFeatureResolver({ features });
  return f.getEffectiveFeatureSnapshot();
}

const FULL = {
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

function makeStore(): { store: ArtifactStore; artifactId: string } {
  const store = new ArtifactStore();
  const rows = Array.from({ length: 60 }, (_, i) => ({
    event_date: `2026-0${(i % 6) + 1}-${String((i % 28) + 1).padStart(2, "0")}`,
    auc: Number((0.75 + (i % 30) * 0.005 + Math.sin(i / 5) * 0.02).toFixed(4)),
    model_version: i % 3 === 0 ? "v1" : i % 3 === 1 ? "v2" : "v3",
    region: i % 2 === 0 ? "east" : "west",
  }));
  const data = JSON.stringify(rows);
  const artifactId = "art_e2e0000000000001";
  store.register({
    artifactId,
    contentType: "application/json",
    rowCount: rows.length,
    columns: ["event_date", "auc", "model_version", "region"],
    contentHash: createHash("sha256").update(data).digest("hex"),
    queryId: "q_e2e",
    snapshotId: "v1",
    masked: true,
    createdAt: new Date().toISOString(),
  }, data);
  return { store, artifactId };
}

function requestFor(artifactId: string, objective: string, analysisType: any, extra: Record<string, unknown> = {}) {
  return {
    objective,
    analysisType,
    dataRefs: [{
      artifactId,
      sourceType: "LAKEHOUSE_QUERY",
      queryId: "q_e2e",
      format: "JSON",
      schema: [
        { name: "event_date", type: "string" },
        { name: "auc", type: "float" },
        { name: "model_version", type: "string" },
        { name: "region", type: "string" },
      ],
      rowCount: 60,
      allowedColumns: ["event_date", "auc", "model_version", "region"],
      masked: true,
    }],
    metricDefinitions: [{ metricId: "auc", label: "AUC", valueType: "NUMBER", precision: 4 }],
    timeField: "event_date",
    ...extra,
  };
}

/** Deterministic fake subagent: writes plan + script that computes the canary. */
function makeFakeSubagent(
  ws: WorkspacePaths,
  opts: { failFirst?: boolean; writeFindings?: boolean; objective?: string; analysisType?: string } = {},
) {
  let calls = 0;
  const objective = opts.objective ?? "compare AUC trend and volatility over 30 days vs previous 30 days";
  const analysisType = opts.analysisType ?? "PERIOD_COMPARISON";
  return async (_prompt: string) => {
    calls += 1;
    const attempt = calls;
    // plan (objective + analysisType must match the request or the plan
    // validator rejects)
    writeFileSync(ws.planFile, JSON.stringify({
      planId: "p_e2e",
      runId: "run_e2e",
      objective,
      analysisType,
      inputArtifacts: ["art_e2e0000000000001"],
      selectedColumns: ["event_date", "auc", "model_version"],
      metricDefinitions: [],
      dimensions: ["model_version"],
      timeField: "event_date",
      steps: ["load", "compute", "write"],
      expectedOutputs: ["analysis-result.json"],
      methods: ["groupby"],
      assumptions: [],
      limitations: [],
      createdAt: new Date().toISOString(),
    }), "utf8");
    // script: real Python computing the canary number into result JSON
    const script = [
      "import json, math",
      "rows = json.load(open('input/art_e2e0000000000001.data', encoding='utf-8'))",
      "vals = [r['auc'] for r in rows]",
      `canary = ${CANARY_NUMBER}`,
      "avg = sum(vals)/len(vals) if vals else 0",
      "result = {",
      "  'schemaVersion': '1.0',",
      "  'artifactId': 'art_e2e_result',",
      "  'runId': 'run_e2e',",
      "  'status': 'COMPLETED',",
      "  'title': 'AUC trend analysis',",
      "  'sections': [",
      "    {'type': 'METRIC_CARDS', 'metrics': [",
      "      {'metricId': 'auc', 'label': 'AUC avg', 'value': canary, 'valueType': 'NUMBER', 'precision': 3},",
      "      {'metricId': 'auc_mean', 'label': 'AUC mean', 'value': round(avg, 4), 'valueType': 'NUMBER', 'precision': 4}",
      "    ]},",
      "    {'type': 'TABLE', 'columns': [{'name': 'model_version', 'type': 'string'}, {'name': 'auc', 'type': 'float'}],",
      "     'rows': [{'model_version': 'v1', 'auc': canary}, {'model_version': 'v2', 'auc': 0.8}],",
      "     'totalRows': 2, 'displayedRows': 2},",
      "    {'type': 'LINE_CHART', 'chartTitle': 'AUC by day', 'x': 'event_date',",
      "     'series': [{'name': 'auc', 'points': [{'x': '2026-07-01', 'y': canary}, {'x': '2026-07-02', 'y': 0.8}]}]}",
      "  ],",
      "  'reviewStatus': 'NOT_REVIEWED',",
      "  'validationRefs': [],",
      "  'createdAt': '2026-08-02T00:00:00.000Z'",
      "}",
      "json.dump(result, open('output/analysis-result.json', 'w', encoding='utf-8'), ensure_ascii=False)",
      "print('analysis complete')",
    ].join("\n");
    if (opts.failFirst && attempt === 1) {
      writeFileSync(ws.scriptFile, "import json\nprint('boom')\nraise ValueError('intentional first-attempt failure')\n", "utf8");
    } else {
      writeFileSync(ws.scriptFile, script, "utf8");
    }
    if (opts.writeFindings) {
      writeFileSync(ws.findingsFile, JSON.stringify({
        schemaVersion: "1.0",
        runId: "run_e2e",
        findings: [{
          findingId: "f_e2e_1",
          code: "TREND",
          claim: "the metric shows an upward trend",
          category: "TREND",
          severity: "LOW",
          evidenceRefs: ["metric://auc", "chart://auc"],
          method: "script",
          confidence: 0.8,
          limitations: ["sample"],
        }],
      }), "utf8");
    }
    return { ok: true, text: "done" };
  };
}

console.log("[e2e] Data Analysis Subagent — scenarios A-G\n");

// ---- A: simple aggregation → QUERY_GATEWAY --------------------------------
{
  console.log("A. simple aggregation routes to the gateway");
  const { store, artifactId } = makeStore();
  const out = await runDataAnalysis(
    requestFor(artifactId, "average AUC over the last 7 days", "DESCRIPTIVE", { expectedViews: ["METRIC_CARDS"] }),
    { snapshot: snapshotWith(FULL), store, subagent: async () => ({ ok: true, text: "" }) },
  );
  check("route=QUERY_GATEWAY", () => assert.equal(out.route, "QUERY_GATEWAY"));
  check("no subagent/script involved", () => assert.equal(out.artifact, undefined));
}

// ---- B: period comparison → subagent + script + UI views -----------------
{
  console.log("B. period comparison runs the subagent with real script execution");
  const { store, artifactId } = makeStore();
  const ws = createWorkspace(newRunId());
  const out = await runDataAnalysis(
    requestFor(artifactId, "compare AUC trend and volatility over 30 days vs previous 30 days", "PERIOD_COMPARISON", { expectedViews: ["METRIC_CARDS", "TABLE", "LINE_CHART"] }),
    { snapshot: snapshotWith(FULL), store, subagent: makeFakeSubagent(ws), createWorkspaceForRun: () => ws },
  );
  check("route=DATA_ANALYSIS_SUBAGENT", () => assert.equal(out.route, "DATA_ANALYSIS_SUBAGENT"));
  check("artifact produced", () => assert.ok(out.artifact));
  check("script actually executed (result file on disk)", () => {
    assert.ok(existsSync(ws.resultFile), "analysis-result.json must exist");
    const onDisk = readFileSync(ws.resultFile, "utf8");
    assert.ok(onDisk.includes(CANARY_NUMBER), "canary in artifact file");
  });
  check("UI views include metric cards/table/chart", () => {
    const views = (out.artifact?.sections ?? []).map((s) => s.type);
    assert.ok(views.includes("METRIC_CARDS"));
    assert.ok(views.includes("TABLE"));
    assert.ok(views.includes("LINE_CHART"));
  });
  check("UI renderer text contains the canary", () => {
    assert.ok(analysisResultText(out.artifact!).includes(CANARY_NUMBER));
  });
  check("model content has no numbers", () => {
    assert.ok(!out.content.includes(CANARY_NUMBER));
    assert.ok(!out.content.includes("0.8"));
    assert.ok(out.content.includes("displayedDirectly=true"));
    assert.ok(out.content.includes("NOT_REVIEWED"));
  });
}

// ---- C: breakdown → table + findings --------------------------------------
{
  console.log("C. breakdown with findings");
  const { store, artifactId } = makeStore();
  const ws = createWorkspace(newRunId());
  const out = await runDataAnalysis(
    requestFor(artifactId, "which model versions and time periods contribute to the metric decline", "BREAKDOWN", { dimensions: ["model_version"], expectedViews: ["TABLE"] }),
    { snapshot: snapshotWith(FULL), store, subagent: makeFakeSubagent(ws, { writeFindings: true, objective: "which model versions and time periods contribute to the metric decline", analysisType: "BREAKDOWN" }), createWorkspaceForRun: () => ws },
  );
  check("findings present", () => assert.ok(out.artifact?.findingsRef || out.summary?.findingRefs.length));
  check("finding refs point at evidence (no numbers copied)", () => {
    const summary = out.summary!;
    assert.ok(summary.findingRefs.length > 0);
    assert.ok(!JSON.stringify(summary).includes(CANARY_NUMBER));
  });
  check("reviewStatus=NOT_REVIEWED", () => {
    assert.equal(out.artifact?.reviewStatus, "NOT_REVIEWED");
    assert.equal(out.summary?.reviewStatus, "NOT_REVIEWED");
  });
}

// ---- D: script failure → bounded retry ------------------------------------
{
  console.log("D. fixable script failure retried once");
  const { store, artifactId } = makeStore();
  const ws = createWorkspace(newRunId());
  const out = await runDataAnalysis(
    requestFor(artifactId, "compare AUC trend and volatility", "PERIOD_COMPARISON", { expectedViews: ["METRIC_CARDS"] }),
    { snapshot: snapshotWith(FULL), store, subagent: makeFakeSubagent(ws, { failFirst: true, objective: "compare AUC trend and volatility" }), createWorkspaceForRun: () => ws },
  );
  check("attempts recorded", () => assert.ok(out.manifest && out.manifest.attempts.length >= 2));
  check("second attempt succeeded", () => {
    assert.ok(out.artifact, "must succeed after retry");
    assert.ok(out.manifest!.attempts.some((a) => a.status === "SUCCEEDED"));
  });
  check("canary isolated from model content", () => assert.ok(!out.content.includes(CANARY_NUMBER)));
}

// ---- E: missing input ------------------------------------------------------
{
  console.log("E. missing input → DATA_INPUT_REQUIRED");
  const { store } = makeStore();
  const out = await runDataAnalysis(
    { ...requestFor("art_e2e0000000000001", "analyze", "TREND"), dataRefs: [] },
    { snapshot: snapshotWith(FULL), store, subagent: async () => ({ ok: true, text: "" }) },
  );
  check("DATA_INPUT_REQUIRED", () => assert.equal(out.route, "DATA_INPUT_REQUIRED"));
  check("no fabricated result", () => assert.ok(!out.artifact));
}

// ---- F: feature off → not registered ---------------------------------------
{
  console.log("F. feature off → tool not registered");
  const { store, artifactId } = makeStore();
  const off = { ...FULL, "round4.data_analysis": false };
  let threw = false;
  try {
    buildDataAnalysisTool({ snapshot: snapshotWith(off), store, subagent: async () => ({ ok: true, text: "" }) });
  } catch {
    threw = true;
  }
  check("buildDataAnalysisTool refuses when data_analysis off", () => assert.ok(threw));
}

// ---- G: frontend render off → not registered -------------------------------
{
  console.log("G. frontend render off → tool not registered (no fallback)");
  const { store, artifactId } = makeStore();
  const noRender = { ...FULL, "round4.analysis_frontend_render": false };
  let threw = false;
  try {
    buildDataAnalysisTool({ snapshot: snapshotWith(noRender), store, subagent: async () => ({ ok: true, text: "" }) });
  } catch {
    threw = true;
  }
  check("refuses registration without frontend render", () => assert.ok(threw));
}

console.log(`\n[e2e] all scenarios passed (${passed} checks)`);
