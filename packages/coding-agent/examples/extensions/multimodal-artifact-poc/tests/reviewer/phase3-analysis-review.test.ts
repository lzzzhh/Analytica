/**
 * Phase 3+4 tests — analysis review (tolerance, replay comparison,
 * independent verification, digest boundary).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  withinTolerance,
  compareReplay,
  verifyIndependently,
  DEFAULT_TOLERANCES,
} from "../../src/reviewer/analysis/verifier.ts";
import { AnalysisReviewRunner } from "../../src/reviewer/analysis/review-runner.ts";
import { ReviewerStore, canonicalHash } from "../../src/reviewer/store.ts";
import { reduceReviewDecision } from "../../src/reviewer/decision-reducer.ts";
import type { AnalysisProposal } from "../../src/reviewer/contracts/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rev3-"));
}

function proposal(resultHash?: string): AnalysisProposal {
  const base = canonicalHash({ k: 1 });
  const result = resultHash ?? base;
  return {
    schemaVersion: "1.0", proposalId: "pa1", proposalVersion: 1,
    analysisResultRef: { artifactId: "art/result", artifactType: "analysis-result", contentHash: result },
    analysisPlanRef: { artifactId: "art/plan", artifactType: "analysis-plan", contentHash: base },
    executionManifestRef: { artifactId: "art/manifest", artifactType: "execution-manifest", contentHash: base },
    scriptArtifactRef: { artifactId: "art/script", artifactType: "analysis-script", contentHash: base },
    inputArtifactRefs: [], validationRefs: [],
    replayPolicy: { required: true, numericTolerancePolicyId: "default", independentMetricIds: [], strictMode: false },
    contentHash: "abc", createdAt: new Date().toISOString(),
  };
}

async function setupStore(store: ReviewerStore): Promise<void> {
  // art/result is written per-test (original analysis result); the rest here
  for (const p of ["art/plan", "art/manifest", "art/script"]) {
    await store.writeImmutable(p, { k: 1 });
  }
}

describe("tolerance policy", () => {
  test("exact and within-absolute match", () => {
    assert.ok(withinTolerance(1, 1, DEFAULT_TOLERANCES.NUMBER));
    assert.ok(withinTolerance(0.1 + 1e-10, 0.1, DEFAULT_TOLERANCES.NUMBER));
  });
  test("outside tolerance rejected", () => {
    assert.ok(!withinTolerance(1, 2, DEFAULT_TOLERANCES.INTEGER));
  });
});

describe("replay comparison", () => {
  test("consistent -> no discrepancies", () => {
    const ds = compareReplay({
      originalMetrics: [{ metricId: "m1", valueType: "NUMBER", value: 1.5 }],
      replayMetrics: [{ metricId: "m1", valueType: "NUMBER", value: 1.5 }],
      originalTables: [{ id: "t1", rows: [{ a: 1 }] }],
      replayTables: [{ id: "t1", rows: [{ a: 1 }] }],
      originalStatus: "COMPLETED", replayStatus: "COMPLETED",
    });
    assert.equal(ds.length, 0);
  });
  test("metric mismatch detected", () => {
    const ds = compareReplay({
      originalMetrics: [{ metricId: "m1", valueType: "NUMBER", value: 1.5 }],
      replayMetrics: [{ metricId: "m1", valueType: "NUMBER", value: 9.9 }],
      originalTables: [], replayTables: [],
      originalStatus: "COMPLETED", replayStatus: "COMPLETED",
    });
    assert.ok(ds.some((d) => d.code === "METRIC_VALUE_MISMATCH"));
  });
  test("table hash mismatch detected", () => {
    const ds = compareReplay({
      originalMetrics: [], replayMetrics: [],
      originalTables: [{ id: "t1", rows: [{ a: 1 }] }],
      replayTables: [{ id: "t1", rows: [{ a: 2 }] }],
      originalStatus: "COMPLETED", replayStatus: "COMPLETED",
    });
    assert.ok(ds.some((d) => d.code === "TABLE_HASH_MISMATCH"));
  });
  test("status mismatch detected", () => {
    const ds = compareReplay({
      originalMetrics: [], replayMetrics: [],
      originalTables: [], replayTables: [],
      originalStatus: "COMPLETED", replayStatus: "FAILED",
    });
    assert.ok(ds.some((d) => d.code === "STATUS_MISMATCH"));
  });
});

describe("independent verification", () => {
  test("mean and sum recomputed", () => {
    const out = verifyIndependently([
      { metricId: "mean", kind: "MEAN", data: [1, 2, 3, 4], expected: 2.5 },
      { metricId: "sum", kind: "SUM", data: [1, 2, 3, 4], expected: 10 },
    ]);
    assert.ok(out.every((v) => v.ok));
  });
  test("wrong expected caught", () => {
    const out = verifyIndependently([
      { metricId: "mean", kind: "MEAN", data: [1, 2, 3, 4], expected: 3.0 },
    ]);
    assert.ok(!out[0]!.ok);
  });
});

describe("analysis review runner", () => {
  test("replay mismatch -> CHANGES_REQUIRED", async () => {
    const store = new ReviewerStore(tmp());
    await setupStore(store);
    const runner = new AnalysisReviewRunner(store);
    // store must contain the original analysis result artifact
    const resultContent = {
      metrics: [{ metricId: "auc", valueType: "NUMBER", value: 0.9 }],
      tables: [], status: "COMPLETED",
    };
    await store.writeImmutable("art/result", resultContent);
    const out = await runner.run({
      proposal: proposal(canonicalHash(resultContent)), objective: "trend",
      replayRunner: async () => ({
        metrics: [{ metricId: "auc", valueType: "NUMBER", value: 0.7 }],
        tables: [], status: "COMPLETED",
        replayResult: { ok: true }, replayManifest: { ok: true },
      }),
      verificationCases: [{ metricId: "k", kind: "MEAN", data: [1, 2], expected: 1.5 }],
      semanticReviewer: async () => [],
    });
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "CHANGES_REQUIRED");
  });

  test("clean run -> PASS (advisory findings allowed)", async () => {
    const store = new ReviewerStore(tmp());
    await setupStore(store);
    const runner = new AnalysisReviewRunner(store);
    const resultContent = {
      metrics: [{ metricId: "auc", valueType: "NUMBER", value: 0.9 }],
      tables: [], status: "COMPLETED",
    };
    await store.writeImmutable("art/result", resultContent);
    const out = await runner.run({
      proposal: proposal(canonicalHash(resultContent)), objective: "trend",
      replayRunner: async () => ({
        metrics: [{ metricId: "auc", valueType: "NUMBER", value: 0.9 }],
        tables: [], status: "COMPLETED",
        replayResult: { ok: true }, replayManifest: { ok: true },
      }),
      verificationCases: [{ metricId: "k", kind: "MEAN", data: [1, 2], expected: 1.5 }],
      semanticReviewer: async () => [{
        severity: "MEDIUM", category: "METHODOLOGY", claim: "assumption not documented",
        suggestedAction: "document the assumption", evidenceRefIds: [],
      }],
    });
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "PASS");
  });

  test("semantic HIGH finding blocks PASS", async () => {
    const store = new ReviewerStore(tmp());
    await setupStore(store);
    const runner = new AnalysisReviewRunner(store);
    const resultContent = { metrics: [], tables: [], status: "COMPLETED" };
    await store.writeImmutable("art/result", resultContent);
    const out = await runner.run({
      proposal: proposal(canonicalHash(resultContent)), objective: "trend",
      replayRunner: async () => ({
        metrics: [], tables: [], status: "COMPLETED",
        replayResult: { ok: true }, replayManifest: { ok: true },
      }),
      verificationCases: [],
      semanticReviewer: async () => [{
        severity: "HIGH", category: "METHODOLOGY", claim: "correlation stated as causation",
        suggestedAction: "reword the finding", evidenceRefIds: [],
      }],
    });
    // HIGH finding without evidence -> semantic-evidence FAILED -> not PASS
    assert.ok(["CHANGES_REQUIRED", "ABSTAIN"].includes(
      reduceReviewDecision({ checks: out.checks, findings: out.findings })));
  });
});
