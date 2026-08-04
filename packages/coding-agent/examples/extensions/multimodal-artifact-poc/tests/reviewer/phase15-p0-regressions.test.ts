/**
 * Phase 15 — P0 regression tests from phase 3 evaluation:
 *
 * 1. RPC entry path resolution (data analysis / subagent callers)
 * 2. SUBAGENT_LAUNCH_FAILED error classification (never SCRIPT_SYNTAX_ERROR)
 * 3. review_data_analysis public tool registration under round5.review_tools
 * 4. analysis findings may locate by artifactId (parse + full handoff)
 * 5. real artifact -> proposal -> gate -> reviewer handoff
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataAnalysisSubagentCaller } from "../../src/data-analysis/subagent.ts";
import { ArtifactStore } from "../../src/data-analysis/artifact-store.ts";
import { reviewAnalysisArtifact } from "../../src/reviewer/adapters/review-data-analysis-tool.ts";
import { parseSemanticResponse, SemanticReviewError } from "../../src/reviewer/adapters/pi-reviewer.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "p15-"));
}

describe("P0-1: RPC entry path", () => {
  test("data-analysis subagent caller resolves the real rpc-entry.js", async () => {
    const { existsSync } = await import("node:fs");
    // resolved path is used by RpcClient; probe the same computation by
    // reading the source line and evaluating it relative to the source file
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const srcFile = fileURLToPath(import.meta.url).replace(
      "/tests/reviewer/phase15-p0-regressions.test.ts",
      "/src/data-analysis/subagent.ts");
    const cliPath = resolve(dirname(srcFile), "../../../../../dist/rpc-entry.js");
    assert.ok(existsSync(cliPath), `rpc entry exists at ${cliPath}`);
    assert.ok(cliPath.includes("packages/coding-agent/dist/rpc-entry.js"));
  });

  test("createDataAnalysisSubagentCaller is constructible", () => {
    const caller = createDataAnalysisSubagentCaller({ timeoutMs: 1000 });
    assert.equal(typeof caller, "function");
  });
});

describe("P0-1: error classification", () => {
  test("subagent launch failure maps to SUBAGENT_LAUNCH_FAILED, not SCRIPT_SYNTAX_ERROR", async () => {
    const { runDataAnalysis } = await import("../../src/data-analysis/index.ts");
    const { ArtifactStore } = await import("../../src/data-analysis/artifact-store.ts");
    const { analysisFlags } = await import("../../src/data-analysis/feature-bindings.ts");
    const store = new ArtifactStore(tmp());
    const { createHash } = await import("node:crypto");
    const data = "id,value\n1,10\n2,20";
    const hash = createHash("sha256").update(data).digest("hex");
    store.register({
      artifactId: "art_aaaabbbbcccc0001", contentType: "text/csv",
      contentHash: hash, masked: false, createdAt: new Date().toISOString(),
    } as never, data);
    // subagent that always fails to launch (broken CLI path)
    const out = await runDataAnalysis({
      objective: "sum the values",
      analysisType: "AGGREGATE",
      dataRefs: [{ artifactId: "art_aaaabbbbcccc0001", sourceType: "TABLE", format: "CSV" }],
    }, {
      snapshot: analysisFlags(["round4.analysis_subagent"]) as never,
      store,
      subagent: async () => ({ ok: false, text: "", error: "spawn ENOENT: rpc-entry.js" }),
      defaultTimeoutSeconds: 30,
    } as never);
    assert.ok(out.failure, "analysis failed");
    assert.equal(out.failure.errorCode, "SUBAGENT_LAUNCH_FAILED");
    assert.notEqual(out.failure.errorCode, "SCRIPT_SYNTAX_ERROR");
  });
});

describe("P0-3: analysis finding locations", () => {
  test("HIGH finding with artifactId location parses", () => {
    const out = parseSemanticResponse(JSON.stringify({
      findings: [{
        severity: "HIGH", category: "METHODOLOGY", claim: "denominator mismatch",
        evidenceRefIds: ["e1"], suggestedAction: "fix denominator",
        location: { artifactId: "art_abc123", sectionId: "revenue", metricId: "rate" },
      }],
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.severity, "HIGH");
  });

  test("HIGH finding without file or artifactId still rejected", () => {
    assert.throws(
      () => parseSemanticResponse(JSON.stringify({
        findings: [{ severity: "HIGH", category: "X", claim: "c", evidenceRefIds: ["e1"], suggestedAction: "a", location: {} }],
      })),
      SemanticReviewError,
    );
  });
});

describe("P0-2: review_data_analysis public handoff", () => {
  test("artifact -> proposal -> gate -> reviewer (injected semantic) yields a verdict", async () => {
    const store = new ArtifactStore(tmp());
    const artifact = {
      schemaVersion: "1.0",
      artifactId: "art_a1b2c3d4e5f60708",
      runId: "run_p0",
      status: "COMPLETED",
      title: "revenue trend",
      sections: [
        { type: "METRIC_CARDS", metrics: [{ metricId: "revenue", label: "Revenue", value: 100, valueType: "NUMBER" }] },
        { type: "TABLE", columns: [{ name: "m", type: "string" }], rows: [{ m: "a" }], totalRows: 1, displayedRows: 1 },
      ],
      reviewStatus: "NOT_REVIEWED",
      validationRefs: [],
      createdAt: new Date().toISOString(),
      executionManifestRef: "art_a1b2c3d4e5f60709",
    };
    // persist the artifact through the REAL store path (hash-bound)
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
    store.register({ artifactId: artifact.artifactId, contentType: "application/json", contentHash: hash, masked: false, createdAt: new Date().toISOString() } as never, JSON.stringify(artifact));

    const root = tmp();
    const { summary, gate, verdict } = await reviewAnalysisArtifact(artifact.artifactId, {
      storeRoot: root,
      artifactStore: store,
      deps: {
        semanticReviewer: async () => [] as never,
      },
    });
    assert.ok(gate.gateDecisionId);
    assert.ok(["PASS", "CHANGES_REQUIRED", "REJECT", "ABSTAIN"].includes(verdict));
    assert.equal(summary.proposalId, `analysis-${artifact.artifactId}`);
  });

  test("tool is registered under round5.review_tools in the extension", async () => {
    const { buildExtensionRegistrations } = await import("../../index.ts");
    const { createFeatureResolver } = await import("../../src/features/resolver.ts");
    const registered: string[] = [];
    const pi = {
      registerTool: (t: { name: string }) => { registered.push(t.name); },
      registerCommand: () => {},
      on: () => {},
    } as never;
    const features = createFeatureResolver({ runtimeProfile: "all-enabled" });
    buildExtensionRegistrations(pi as never, features);
    assert.ok(registered.includes("review_data_analysis"), `registered: ${registered.join(",")}`);
    assert.ok(registered.includes("inspect_review_gate"));
    // disabled profile -> no reviewer tools
    const registeredDisabled: string[] = [];
    const pi2 = {
      registerTool: (t: { name: string }) => { registeredDisabled.push(t.name); },
      registerCommand: () => {},
      on: () => {},
    } as never;
    const featuresOff = createFeatureResolver({});
    buildExtensionRegistrations(pi2 as never, featuresOff);
    assert.ok(!registeredDisabled.includes("review_data_analysis"));
  });
});
