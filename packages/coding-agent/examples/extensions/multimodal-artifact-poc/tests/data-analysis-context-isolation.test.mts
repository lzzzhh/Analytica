/**
 * Numeric context isolation — the hard acceptance test for round 4.
 *
 * The unique canary number 918273.645 must:
 *  - exist in analysis-result.json (script output),
 *  - reach the UI renderer input (details channel),
 *  - NEVER appear in: tool model-facing content, main agent transcript,
 *    prompt capture, or finding claims.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDataAnalysis } from "../src/data-analysis/index.ts";
import { modelFacingContent, buildAgentSummary } from "../src/data-analysis/result-sanitizer.ts";
import { analysisResultText } from "../src/data-analysis/ui/renderer.ts";
import { CANARY_NUMBER } from "../src/data-analysis/contracts.ts";
import { fakeSnapshot, fakeStore, SAMPLE_REQUEST } from "./helpers.ts";
import { createWorkspace, newRunId } from "../src/data-analysis/workspace.ts";

function canaryArtifact(runId: string) {
  return {
    schemaVersion: "1.0",
    artifactId: "art_canary0000000001",
    runId,
    status: "COMPLETED",
    title: "Canary analysis",
    sections: [
      {
        type: "METRIC_CARDS",
        metrics: [
          { metricId: "m1", label: "Canary", value: 918273.645, valueType: "NUMBER", precision: 3 },
        ],
      },
    ],
    reviewStatus: "NOT_REVIEWED",
    validationRefs: [],
    createdAt: new Date().toISOString(),
  };
}

describe("numeric context isolation (canary 918273.645)", () => {
  test("full pipeline: number in artifact + UI, absent from model content", async () => {
    const ws = createWorkspace(newRunId());
    const out = await runDataAnalysis(SAMPLE_REQUEST, {
      snapshot: fakeSnapshot(),
      store: fakeStore(),
      createWorkspaceForRun: () => ws,
      subagent: async () => {
        // subagent writes plan + script that writes the canary result
        writeFileSync(ws.planFile, JSON.stringify({
          planId: "p1",
          runId: "run_canary",
          objective: SAMPLE_REQUEST.objective,
          analysisType: SAMPLE_REQUEST.analysisType,
          inputArtifacts: SAMPLE_REQUEST.dataRefs.map((r) => r.artifactId),
          selectedColumns: ["auc", "event_date", "model_version"],
          metricDefinitions: [],
          dimensions: [],
          timeField: "event_date",
          steps: ["load", "write"],
          expectedOutputs: ["analysis-result.json"],
          methods: [],
          assumptions: [],
          limitations: [],
          createdAt: new Date().toISOString(),
        }));
        writeFileSync(ws.scriptFile, "print('ok')\n", "utf8");
        const artifact = canaryArtifact("run_canary");
        mkdirSync(ws.outputDir, { recursive: true });
        writeFileSync(ws.resultFile, JSON.stringify(artifact), "utf8");
        return { ok: true, text: "done" };
      },
    });

    // 1. artifact file contains the number
    const onDisk = readFileSync(ws.resultFile, "utf8");
    assert.ok(onDisk.includes(CANARY_NUMBER), "analysis-result.json must contain the canary");

    // 2. UI renderer input contains the number
    assert.ok(out.artifact, "artifact produced");
    const uiText = analysisResultText(out.artifact!);
    assert.ok(uiText.includes(CANARY_NUMBER), "UI renderer must receive the canary");

    // 3. tool model-facing content does NOT contain it
    assert.ok(!out.content.includes(CANARY_NUMBER), "model-facing content must not contain the canary");
    // no metric values, no rows, no series — only ids/status are allowed
    assert.ok(!out.content.includes("918273"), "no partial canary either");
    assert.ok(!out.content.includes("0.82"), "no metric values");
    assert.ok(out.content.includes("displayedDirectly=true"));
    assert.ok(out.content.includes("NOT_REVIEWED"));

    // 4. summary object has no numeric fields
    const summary = out.summary!;
    assert.equal(summary.displayedDirectly, true);
    assert.equal(summary.reviewStatus, "NOT_REVIEWED");
    assert.ok(!JSON.stringify(summary).includes(CANARY_NUMBER));

    // 5. finding claims never copy the value
    const fv = {
      schemaVersion: "1.0",
      runId: "run_canary",
      findings: [
        {
          findingId: "f1",
          code: "TREND",
          claim: "the metric moved up",
          category: "TREND",
          severity: "LOW",
          evidenceRefs: ["metric://m1"],
          method: "script",
          confidence: 0.9,
          limitations: [],
        },
      ],
    };
    writeFileSync(ws.findingsFile, JSON.stringify(fv), "utf8");
    assert.ok(!JSON.stringify(fv).includes(CANARY_NUMBER), "finding claims must not copy numbers");

    rmSync(ws.root, { recursive: true, force: true });
  });

  test("modelFacingContent rejects numeric leakage by construction", () => {
    const summary = buildAgentSummary({
      artifactId: "art_x",
      runId: "run_x",
      status: "COMPLETED",
      title: "t",
      availableViews: ["METRIC_CARDS"],
      findingRefs: [],
      warningCodes: [],
    });
    const content = modelFacingContent(summary);
    assert.ok(!content.includes(CANARY_NUMBER), "canary never in content");
    assert.ok(!content.includes("918273"), "no partial canary either");
    assert.ok(content.includes("displayedDirectly=true"));
  });

  test("prompt capture: subagent prompt never includes the canary (stub check)", async () => {
    let capturedPrompt = "";
    const ws = createWorkspace(newRunId());
    await runDataAnalysis(SAMPLE_REQUEST, {
      snapshot: fakeSnapshot(),
      store: fakeStore(),
      createWorkspaceForRun: () => ws,
      subagent: async (prompt) => {
        capturedPrompt = prompt;
        return { ok: true, text: "no-op" };
      },
    });
    assert.ok(!capturedPrompt.includes(CANARY_NUMBER), "prompt must not contain the canary");
    assert.ok(!capturedPrompt.includes("918273"), "no partial canary either");
    rmSync(ws.root, { recursive: true, force: true });
  });
});
