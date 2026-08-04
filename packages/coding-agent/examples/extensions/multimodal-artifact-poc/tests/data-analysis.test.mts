/**
 * Data Analysis Subagent — unit tests (fake/stub subagent, no real model).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/data-analysis/artifact-store.ts";
import { runDataAnalysis } from "../src/data-analysis/index.ts";
import { evaluateTaskGate } from "../src/data-analysis/task-gate.ts";
import {
  checkForbiddenRequest,
  resolveAnalysisInput,
} from "../src/data-analysis/input-resolver.ts";
import { validateAnalysisPlan } from "../src/data-analysis/plan-validator.ts";
import { validateResultArtifact, downsampleSeries, boundTableRows } from "../src/data-analysis/result-validator.ts";
import { validateFindings } from "../src/data-analysis/findings.ts";
import { analysisFlags, canRegisterDataAnalysisTool } from "../src/data-analysis/feature-bindings.ts";
import { modelFacingContent, buildAgentSummary } from "../src/data-analysis/result-sanitizer.ts";
import { artifactToViews } from "../src/data-analysis/ui/contracts.ts";
import { createWorkspace, newRunId, scriptFileForAttempt } from "../src/data-analysis/workspace.ts";
import type { AnalysisPlan } from "../src/data-analysis/contracts.ts";
import type { DataAnalysisRequest } from "../src/data-analysis/contracts.ts";
import { fakeSnapshot, fakeStore, SAMPLE_RESULT, SAMPLE_REQUEST } from "./helpers.ts";

// ---- 1. task gate ---------------------------------------------------------
describe("task gate (spec 1-2)", () => {
  test("simple avg request → QUERY_GATEWAY, no subagent", () => {
    const g = evaluateTaskGate({
      objective: "average AUC over the last 7 days",
      analysisType: "DESCRIPTIVE",
      dataRefs: [SAMPLE_REQUEST.dataRefs[0]],
      expectedViews: ["METRIC_CARDS"],
    });
    assert.equal(g.route, "QUERY_GATEWAY");
  });

  test("period comparison → DATA_ANALYSIS_SUBAGENT", () => {
    const g = evaluateTaskGate({
      ...SAMPLE_REQUEST,
      objective: "compare AUC trend and volatility over the last 30 days vs the previous 30 days",
      analysisType: "PERIOD_COMPARISON",
    });
    assert.equal(g.route, "DATA_ANALYSIS_SUBAGENT");
    assert.ok(g.complexityScore >= 2);
  });

  test("breakdown request → DATA_ANALYSIS_SUBAGENT", () => {
    const g = evaluateTaskGate({
      ...SAMPLE_REQUEST,
      objective: "which model versions and time periods contribute to the metric decline",
      analysisType: "BREAKDOWN",
      dimensions: ["model_version", "period"],
    });
    assert.equal(g.route, "DATA_ANALYSIS_SUBAGENT");
  });
});

// ---- 2. input safety ------------------------------------------------------
describe("input safety (spec 3-5)", () => {
  test("trusted materialization remains resolvable after store restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "da-handoff-"));
    const first = new ArtifactStore(dir);
    const data = "real materialized bytes";
    const contentHash = createHash("sha256").update(data).digest("hex");
    first.register({
      artifactId: "art_bbbbbbbbbbbbbbbb",
      contentType: "application/vnd.apache.parquet",
      rowCount: 2,
      columns: ["id"],
      contentHash,
      queryId: "q_materialized",
      snapshotId: "123",
      masked: true,
      createdAt: new Date().toISOString(),
    }, data);
    const restarted = new ArtifactStore(dir);
    const resolved = await restarted.resolveArtifact("art_bbbbbbbbbbbbbbbb");
    assert.ok(resolved);
    assert.equal(resolved.contentType, "application/vnd.apache.parquet");
    const analysisInput = await resolveAnalysisInput({
      ...SAMPLE_REQUEST,
      dataRefs: [{
        ...SAMPLE_REQUEST.dataRefs[0],
        artifactId: "art_bbbbbbbbbbbbbbbb",
        format: "PARQUET",
      }],
    }, restarted);
    assert.deepEqual(analysisInput.missing, []);
    assert.equal(analysisInput.dataRefs[0].resolvedPath, resolved.path);
    rmSync(dir, { recursive: true, force: true });
  });

  test("raw SQL rejected", () => {
    const r = checkForbiddenRequest({
      ...SAMPLE_REQUEST,
      objective: "SELECT * FROM users WHERE x=1",
    });
    assert.ok(r, "raw SQL must be rejected");
  });

  test("python code rejected", () => {
    const r = checkForbiddenRequest({
      ...SAMPLE_REQUEST,
      objective: "run this: import os; os.system('rm -rf /')",
    });
    assert.ok(r, "executable code must be rejected");
  });

  test("absolute local path rejected", () => {
    const r = checkForbiddenRequest({
      ...SAMPLE_REQUEST,
      objective: "analyze the file at /Users/me/secret/data.csv",
    });
    assert.ok(r, "absolute path must be rejected");
  });

  test("database connection string rejected", () => {
    const r = checkForbiddenRequest({
      ...SAMPLE_REQUEST,
      objective: "query postgresql://user:pass@host/db",
    });
    assert.ok(r, "connection string must be rejected");
  });

  test("untrusted artifactId rejected", async () => {
    const store = fakeStore();
    const resolved = await resolveAnalysisInput(
      {
        ...SAMPLE_REQUEST,
        dataRefs: [{ ...SAMPLE_REQUEST.dataRefs[0], artifactId: "/etc/passwd" }],
      },
      store,
    );
    assert.ok(resolved.missing.length > 0, "untrusted id must be flagged missing");
  });

  test("missing input → DATA_INPUT_REQUIRED", async () => {
    const out = await runDataAnalysis(
      { ...SAMPLE_REQUEST, dataRefs: [], objective: "" },
      { snapshot: fakeSnapshot(), store: fakeStore(), subagent: async () => ({ ok: true, text: "" }) },
    );
    assert.equal(out.route, "DATA_INPUT_REQUIRED");
    assert.equal(out.failure?.errorCode, "DATA_INPUT_REQUIRED");
  });
});

// ---- 3. workspace + runner constraints ------------------------------------
describe("workspace & runner (spec 6-10)", () => {
  test("script must be written to a file before execution (runner rejects missing)", async () => {
    const ws = createWorkspace(newRunId());
    const out = await runDataAnalysis(SAMPLE_REQUEST, {
      snapshot: fakeSnapshot(),
      store: fakeStore(),
      createWorkspaceForRun: () => ws,
      // subagent writes a plan but never writes the script file
      subagent: async () => {
        writeFileSync(ws.planFile, JSON.stringify({
          planId: "p1",
          runId: "run_test_ws",
          objective: SAMPLE_REQUEST.objective,
          analysisType: SAMPLE_REQUEST.analysisType,
          inputArtifacts: SAMPLE_REQUEST.dataRefs.map((r) => r.artifactId),
          selectedColumns: ["auc", "event_date", "model_version"],
          metricDefinitions: [],
          dimensions: [],
          timeField: "event_date",
          steps: ["load", "compute", "write"],
          expectedOutputs: ["analysis-result.json"],
          methods: [],
          assumptions: [],
          limitations: [],
          createdAt: new Date().toISOString(),
        }));
        return { ok: true, text: "plan written" };
      },
    });
    assert.ok(out.failure, "must fail when script is not written");
    assert.equal(out.failure?.errorCode, "SCRIPT_SYNTAX_ERROR");
    rmSync(ws.root, { recursive: true, force: true });
  });

  test("attempt-versioned script paths", () => {
    const ws = createWorkspace(newRunId());
    assert.equal(scriptFileForAttempt(ws, 1), ws.scriptFile);
    assert.ok(scriptFileForAttempt(ws, 2).includes("attempt-2"));
    rmSync(ws.root, { recursive: true, force: true });
  });

  test("forbidden runner patterns are not in the runner itself", () => {
    const runnerSrc = readFileSync(
      join(import.meta.dirname, "..", "src", "data-analysis", "script-runner.ts"),
      "utf8",
    );
    assert.ok(!/python3 -c|node -e/.test(runnerSrc), "runner must not use -c/-e");
  });

  test("validate_script.py rejects forbidden statements", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-validate-"));
    const bad = join(dir, "bad.py");
    writeFileSync(bad, "import os\nos.system('ls')\n", "utf8");
    const good = join(dir, "good.py");
    writeFileSync(good, "import json\nprint(json.dumps({'a': 1}))\n", "utf8");
    let badExit = 0;
    try {
      execFileSync("python3", [join(import.meta.dirname, "..", "src", "data-analysis", "python", "validate_script.py"), bad]);
    } catch (e) {
      badExit = (e as { status?: number }).status ?? 1;
    }
    assert.notEqual(badExit, 0, "forbidden script must be rejected");
    execFileSync("python3", [join(import.meta.dirname, "..", "src", "data-analysis", "python", "validate_script.py"), good]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---- 4. result validation -------------------------------------------------
describe("result validation (spec 11-13)", () => {
  test("valid result artifact passes", () => {
    const v = validateResultArtifact({
      artifact: SAMPLE_RESULT,
      maxOutputRows: 500,
      maxSeriesPoints: 2000,
      maxSections: 50,
    });
    assert.equal(v.valid, true);
  });

  test("result schema error → retryable failure", async () => {
    const badArtifact = { ...SAMPLE_RESULT, sections: "nope" };
    const v = validateResultArtifact({
      artifact: badArtifact,
      maxOutputRows: 500,
      maxSeriesPoints: 2000,
      maxSections: 50,
    });
    assert.equal(v.valid, false);
  });

  test("reviewStatus must be NOT_REVIEWED", () => {
    const v = validateResultArtifact({
      artifact: { ...SAMPLE_RESULT, reviewStatus: "APPROVED" },
      maxOutputRows: 500,
      maxSeriesPoints: 2000,
      maxSections: 50,
    });
    assert.equal(v.valid, false);
  });

  test("causalClaim never true in findings", () => {
    const fv = validateFindings({
      schemaVersion: "1.0",
      runId: "run_1",
      findings: [
        { findingId: "f1", code: "T", claim: "x correlates with y", category: "CORRELATION", severity: "LOW", causalClaim: true },
      ],
    });
    assert.equal(fv.valid, false);
  });
});

// ---- 5. sanitizer / summary ----------------------------------------------
describe("model context isolation (spec 14-17)", () => {
  test("model content has no metric value / rows / series", () => {
    const summary = buildAgentSummary({
      artifactId: "art_x",
      runId: "run_x",
      status: "COMPLETED",
      title: "AUC trend",
      availableViews: ["METRIC_CARDS", "TABLE", "LINE_CHART"],
      findingRefs: ["f1"],
      warningCodes: [],
    });
    const content = modelFacingContent(summary);
    assert.ok(!content.includes("918273.645"));
    assert.ok(!content.includes("0.82"));
    assert.ok(!content.includes("table rows"));
    assert.ok(content.includes("displayedDirectly=true"));
    assert.ok(content.includes("NOT_REVIEWED"));
  });

  test("ui views contain the numbers (frontend channel)", () => {
    const views = artifactToViews(SAMPLE_RESULT);
    const all = views.map((v) => v.lines.join("\n")).join("\n");
    assert.ok(all.includes("918273.645"), "UI must receive the canary number");
  });
});

// ---- 6. plan validation ---------------------------------------------------
describe("plan validation (spec 22)", () => {
  const plan: AnalysisPlan = {
    planId: "p1",
    runId: "r1",
    objective: SAMPLE_REQUEST.objective,
    analysisType: "PERIOD_COMPARISON",
    inputArtifacts: SAMPLE_REQUEST.dataRefs.map((r) => r.artifactId),
    selectedColumns: ["auc", "event_date"],
    metricDefinitions: [],
    dimensions: [],
    timeField: "event_date",
    steps: ["load", "compute", "write"],
    expectedOutputs: ["analysis-result.json"],
    methods: ["groupby"],
    assumptions: [],
    limitations: [],
    createdAt: new Date().toISOString(),
  };

  test("valid plan passes", () => {
    const v = validateAnalysisPlan(plan, SAMPLE_REQUEST, new Set(["auc", "event_date", "model_version"]));
    assert.equal(v.valid, true);
  });

  test("unauthorized column rejected", () => {
    const bad = { ...plan, selectedColumns: ["auc", "secret_column"] };
    const v = validateAnalysisPlan(bad, SAMPLE_REQUEST, new Set(["auc", "event_date"]));
    assert.equal(v.valid, false);
    assert.ok(v.issues.some((i) => i.code === "FIELD_NOT_ALLOWED"));
  });

  test("objective change rejected", () => {
    const bad = { ...plan, objective: "something else entirely" };
    const v = validateAnalysisPlan(bad, SAMPLE_REQUEST, new Set(["auc"]));
    assert.equal(v.valid, false);
    assert.ok(v.issues.some((i) => i.code === "OBJECTIVE_CHANGED"));
  });
});

// ---- 7. feature bindings --------------------------------------------------
describe("feature bindings (spec 27-29)", () => {
  test("frontend_render=false → tool cannot register", () => {
    const flags = analysisFlags(fakeSnapshot(["round4.analysis_subagent", "round4.analysis_script_execution", "round4.analysis_artifacts"]));
    assert.equal(canRegisterDataAnalysisTool(flags), false);
  });

  test("all required features → can register", () => {
    const flags = analysisFlags(fakeSnapshot([
      "round4.analysis_subagent",
      "round4.analysis_script_execution",
      "round4.analysis_artifacts",
      "round4.analysis_frontend_render",
    ]));
    assert.equal(canRegisterDataAnalysisTool(flags), true);
  });
});

// ---- 8. bounded output ----------------------------------------------------
describe("bounded output (spec 20-21)", () => {
  test("table rows bounded, full result stays on disk", () => {
    const table = {
      type: "TABLE" as const,
      columns: [{ name: "a", type: "string" }],
      rows: Array.from({ length: 1000 }, (_, i) => ({ a: `v${i}` })),
      totalRows: 1000,
      displayedRows: 1000,
    };
    const bounded = boundTableRows(table, 100);
    assert.equal(bounded.rows.length, 100);
    assert.equal(bounded.displayedRows, 100);
    assert.equal(bounded.totalRows, 1000);
  });

  test("chart series deterministically downsampled", () => {
    const chart = {
      type: "LINE_CHART" as const,
      chartTitle: "t",
      x: "d",
      series: [{ name: "s", points: Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i })) }],
    };
    const down = downsampleSeries(chart, 100);
    assert.ok(down.series[0].points.length <= 100, "must downsample to <= 100 points");
  });
});
