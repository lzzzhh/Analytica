/**
 * Phase 14 — governed-flow E2E through executePlannedReview.
 *
 * These exercise the REAL entry point (gate -> registry -> runner ->
 * coverage -> decision -> promotion), not isolated helpers.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerStore, canonicalHash } from "../../src/reviewer/store.ts";
import { ReviewerOrchestrator } from "../../src/reviewer/orchestrator.ts";
import { authorizeAction, authorizePromotion } from "../../src/reviewer/gate/review-gate.ts";
import type { CodeGateMeta } from "../../src/reviewer/gate/review-gate.ts";
import type { AnalysisProposal } from "../../src/reviewer/contracts/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "p14-"));
}

const SYSTEM = { source: "SYSTEM" as const, actorId: "test", authenticated: true };

async function setupCode(o: ReviewerOrchestrator, proposalId: string) {
  const { buildCodeProposal } = await import("../../src/reviewer/code/proposal-builder.ts");
  const root = tmp();
  const { proposal, snapshotDir } = await buildCodeProposal({
    proposalId, proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
    frozenFiles: [{ path: "src/a.ts", status: "MODIFIED", content: "export const x = 1;" }],
    requirementRefs: [], workspaceRoot: root,
    proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
  });
  const { contentHash: _ch, ...payload } = proposal;
  await o.store.writeImmutable(`proposals/${proposalId}/v1/proposal.json`, payload);
  const pkg = await o.buildReviewPackage(proposal, payload, "CODE", "STANDARD", [], []);
  return { proposal, payload, pkg, snapshotDir };
}

async function planCodeGate(o: ReviewerOrchestrator, subjectId: string, subjectHash: string, meta: CodeGateMeta) {
  return o.planReview({
    stage: "FINAL", subjectType: "CODE_PROPOSAL",
    subjectId, subjectContentHash: subjectHash,
    profile: "CODE", codeMeta: meta,
  }, SYSTEM);
}

describe("executePlannedReview — code", () => {
  test("DETERMINISTIC_ONLY: no LLM, no shadow, can PASS", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg, payload, snapshotDir } = await setupCode(o, "e1");
    const g = await planCodeGate(o, "e1", canonicalHash(payload), {
      changedPaths: ["src/a.ts", "src/b.ts"], diffLineCount: 40, addedFileCount: 2, deletedFileCount: 0,
      toolCalls: [], testsPassed: true, staticChecksPassed: true,
    });
    // score total 4-6 -> DETERMINISTIC_ONLY
    assert.equal(g.reviewMode, "DETERMINISTIC_ONLY");
    let semanticCalls = 0;
    const d = await o.executePlannedReview({
      pkg, gateDecisionId: g.gateDecisionId, profile: "CODE",
      runId: "r", sessionId: "s", model: "m",
      codeInput: {
        snapshotWorkspace: snapshotDir,
        testWorkspace: tmp(),
        checkIds: ["typecheck"],
        semanticReviewer: async () => { semanticCalls++; return []; },
      },
    });
    assert.equal(semanticCalls, 0, "DET never calls the LLM");
    assert.equal(d.verdict, "PASS");
    assert.ok(d.reviewMode === "DETERMINISTIC_ONLY");
  });

  test("STANDARD: semantic PASSED, shadow not required, can PASS", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg, payload, snapshotDir } = await setupCode(o, "e2");
    const g = await planCodeGate(o, "e2", canonicalHash(payload), {
      changedPaths: ["src/a.ts", "src/b.ts"], diffLineCount: 60, addedFileCount: 2, deletedFileCount: 0,
      toolCalls: ["write"], testsPassed: true, staticChecksPassed: true,
    });
    assert.equal(g.reviewMode, "STANDARD");
    let semanticCalls = 0;
    const d = await o.executePlannedReview({
      pkg, gateDecisionId: g.gateDecisionId, profile: "CODE",
      runId: "r", sessionId: "s", model: "m",
      codeInput: {
        snapshotWorkspace: snapshotDir, testWorkspace: tmp(), checkIds: ["typecheck"],
        semanticReviewer: async () => { semanticCalls++; return []; },
      },
    });
    assert.equal(semanticCalls, 1);
    assert.equal(d.verdict, "PASS");
    assert.equal(d.reviewMode, "STANDARD");
    // shadow SKIPPED-not-required semantics are covered in the runner tests
  });

  test("central registry rejects bash/curl/git push — never executed", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg, payload, snapshotDir } = await setupCode(o, "e3");
    const g = await planCodeGate(o, "e3", canonicalHash(payload), {
      changedPaths: ["src/a.ts"], diffLineCount: 3, addedFileCount: 1, deletedFileCount: 0,
      toolCalls: [], testsPassed: true, staticChecksPassed: true,
    });
    const d = await o.executePlannedReview({
      pkg, gateDecisionId: g.gateDecisionId, profile: "CODE",
      runId: "r", sessionId: "s", model: "m",
      codeInput: {
        snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
        // attacker-controlled ids: none of these exist in the registry
        checkIds: ["bash", "curl", "git-push"],
        semanticReviewer: undefined,
      },
    });
    // unregistered ids -> UNAVAILABLE checks; with DET the exec capability is
    // required, so the review must NOT pass and the commands never ran
    assert.notEqual(d.verdict, "PASS");
  });
});

describe("executePlannedReview — analysis", () => {
  async function setupAnalysis(o: ReviewerOrchestrator, proposalId: string) {
    const script = "print('x')";
    const resultContent = {
      schemaVersion: "1.0", artifactId: "art/res", runId: "r",
      status: "COMPLETED", title: "t",
      sections: [
        { type: "METRIC_CARDS", metrics: [
          { metricId: "revenue", label: "Revenue", value: 100, valueType: "NUMBER" },
          { metricId: "orders", label: "Orders", value: 4, valueType: "INTEGER" },
        ] },
        { type: "TABLE", columns: [{ name: "a", type: "number" }], rows: [{ a: 1 }, { a: 2 }], totalRows: 2, displayedRows: 2 },
      ],
    };
    const planHash = canonicalHash({ plan: 1 });
    const proposal: AnalysisProposal = {
      schemaVersion: "1.0", proposalId, proposalVersion: 1,
      analysisResultRef: { artifactId: "art/res", artifactType: "analysis-result", contentHash: canonicalHash(resultContent) },
      analysisPlanRef: { artifactId: "art/plan", artifactType: "analysis-plan", contentHash: planHash },
      executionManifestRef: { artifactId: "art/manifest", artifactType: "execution-manifest", contentHash: planHash },
      scriptArtifactRef: { artifactId: "art/script", artifactType: "analysis-script", contentHash: canonicalHash({ content: script }) },
      inputArtifactRefs: [], validationRefs: [],
      replayPolicy: { required: true, numericTolerancePolicyId: "default", independentMetricIds: ["revenue", "orders"], strictMode: false },
      contentHash: "x", createdAt: new Date().toISOString(),
    };
    const { contentHash: _ch, ...payload } = proposal;
    proposal.contentHash = canonicalHash(payload);
    await o.store.writeImmutable("art/res", resultContent);
    await o.store.writeImmutable("art/plan", { plan: 1 });
    await o.store.writeImmutable("art/manifest", { plan: 1 });
    await o.store.writeImmutable("art/script", { content: script });
    await o.store.writeImmutable(`proposals/${proposalId}/v1/proposal.json`, payload);
    const pkg = await o.buildReviewPackage(proposal, payload, "ANALYSIS", "STANDARD", [], []);
    return { proposal, payload, pkg, resultContent };
  }

  test("STANDARD analysis: real sections-shaped artifact + replay + semantic -> PASS", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg, payload } = await setupAnalysis(o, "a1");
    const g = await o.planReview({
      stage: "FINAL", subjectType: "ANALYSIS_PROPOSAL", subjectId: "a1",
      subjectContentHash: canonicalHash(payload), profile: "ANALYSIS",
      analysisMeta: {
        analysisType: "revenue", methods: ["sum"], forExternalPublication: false,
        dataQualityWarnings: 0, usesStatisticalTests: false, usesPrediction: false,
        metricCount: 2, inputArtifactCount: 1,
      },
    }, SYSTEM);
    // score: impact 2 + reversibility 1 + complexity 1 + uncertainty 0 + autonomy 1 = 5 -> DET;
    // force STANDARD via user preference for this test
    const g2 = await o.planReview({
      stage: "FINAL", subjectType: "ANALYSIS_PROPOSAL", subjectId: "a1",
      subjectContentHash: canonicalHash(payload), profile: "ANALYSIS",
      userReviewPreference: "STANDARD",
      analysisMeta: {
        analysisType: "revenue", methods: ["sum"], forExternalPublication: false,
        dataQualityWarnings: 0, usesStatisticalTests: false, usesPrediction: false,
        metricCount: 2, inputArtifactCount: 1,
      },
    }, SYSTEM);
    assert.equal(g2.reviewMode, "STANDARD");
    let semanticCalls = 0;
    const d = await o.executePlannedReview({
      pkg, gateDecisionId: g2.gateDecisionId, profile: "ANALYSIS",
      runId: "r", sessionId: "s", model: "m",
      analysisInput: {
        replayRunner: async () => ({
          metrics: [
            { metricId: "revenue", valueType: "NUMBER", value: 100 },
            { metricId: "orders", valueType: "INTEGER", value: 4 },
          ],
          tables: [{ id: "table_0", rows: [{ a: 1 }, { a: 2 }] }],
          status: "COMPLETED",
          replayResult: { ok: true }, replayManifest: { ok: true },
        }),
        verificationCases: [
          { metricId: "revenue", kind: "SUM", data: [100], expected: 100 },
          { metricId: "orders", kind: "COUNT", data: [1, 2, 3, 4], expected: 4 },
        ],
        semanticReviewer: async () => { semanticCalls++; return []; },
      },
    });
    assert.equal(semanticCalls, 1);
    assert.equal(d.verdict, "PASS");
  });

  test("STRICT analysis with zero verification cases -> ABSTAIN", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg, payload } = await setupAnalysis(o, "a2");
    const g = await o.planReview({
      stage: "FINAL", subjectType: "ANALYSIS_PROPOSAL", subjectId: "a2",
      subjectContentHash: canonicalHash(payload), profile: "ANALYSIS",
      userReviewPreference: "STRICT",
      analysisMeta: {
        analysisType: "revenue", methods: ["sum"], forExternalPublication: true,
        dataQualityWarnings: 0, usesStatisticalTests: false, usesPrediction: false,
        metricCount: 2, inputArtifactCount: 1,
      },
    }, SYSTEM);
    assert.equal(g.reviewMode, "STRICT");
    const d = await o.executePlannedReview({
      pkg, gateDecisionId: g.gateDecisionId, profile: "ANALYSIS",
      runId: "r", sessionId: "s", model: "m",
      analysisInput: {
        replayRunner: async () => ({
          metrics: [
            { metricId: "revenue", valueType: "NUMBER", value: 100 },
            { metricId: "orders", valueType: "INTEGER", value: 4 },
          ],
          tables: [], status: "COMPLETED",
          replayResult: { ok: true }, replayManifest: { ok: true },
        }),
        verificationCases: [], // empty -> INDEPENDENT_VERIFICATION_EMPTY
        semanticReviewer: async () => [],
      },
    });
    assert.equal(d.verdict, "ABSTAIN");
  });
});

describe("NONE / ABSTAIN idempotency through the orchestrator", () => {
  test("repeated NONE returns the same UNREVIEWED_LOW_RISK decision", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg, payload } = await setupCode(o, "n1");
    const g = await planCodeGate(o, "n1", canonicalHash(payload), {
      changedPaths: ["docs/readme.md"], diffLineCount: 3, addedFileCount: 0, deletedFileCount: 0,
      toolCalls: [], testsPassed: true, staticChecksPassed: true,
    });
    assert.equal(g.reviewMode, "NONE");
    const d1 = await o.executePlannedReview({
      pkg, gateDecisionId: g.gateDecisionId, profile: "CODE",
      runId: "r", sessionId: "s", model: "m",
      codeInput: { snapshotWorkspace: tmp(), testWorkspace: tmp(), checkIds: [], semanticReviewer: undefined },
    });
    const d2 = await o.executePlannedReview({
      pkg, gateDecisionId: g.gateDecisionId, profile: "CODE",
      runId: "r", sessionId: "s", model: "m",
      codeInput: { snapshotWorkspace: tmp(), testWorkspace: tmp(), checkIds: [], semanticReviewer: undefined },
    });
    assert.equal(d1.verdict, "UNREVIEWED_LOW_RISK");
    assert.equal(d1.reviewId, d2.reviewId, "terminal decision reused");
  });

  test("ABSTAIN then retry creates a new attempt, not blocked by a pointer", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg, payload, snapshotDir } = await setupCode(o, "n2");
    const g = await planCodeGate(o, "n2", canonicalHash(payload), {
      changedPaths: ["src/a.ts", "src/b.ts"], diffLineCount: 40, addedFileCount: 2, deletedFileCount: 0,
      toolCalls: [], testsPassed: true, staticChecksPassed: true,
    });
    assert.equal(g.reviewMode, "DETERMINISTIC_ONLY");
    const d1 = await o.executePlannedReview({
      pkg, gateDecisionId: g.gateDecisionId, profile: "CODE",
      runId: "r", sessionId: "s", model: "m",
      codeInput: { snapshotWorkspace: snapshotDir, testWorkspace: tmp(), checkIds: ["unknown-check"], semanticReviewer: undefined },
    });
    assert.equal(d1.verdict, "ABSTAIN", "unknown check id -> exec UNAVAILABLE -> ABSTAIN");
    // retry with a working setup: must not hit EEXIST on the terminal pointer
    const d2 = await o.executePlannedReview({
      pkg, gateDecisionId: g.gateDecisionId, profile: "CODE",
      runId: "r", sessionId: "s", model: "m",
      codeInput: { snapshotWorkspace: snapshotDir, testWorkspace: tmp(), checkIds: ["typecheck"], semanticReviewer: async () => [] },
    });
    assert.equal(d2.verdict, "PASS");
  });
});

describe("promotion guard boolean", () => {
  test("authorizePromotion(REJECT).allowed === false (boolean, not array)", () => {
    const p = authorizePromotion("REJECT", { reviewMode: "STRICT", deliveryMode: "NORMAL", restrictions: [] });
    assert.equal(typeof p.allowed, "boolean");
    assert.equal(p.allowed, false);
  });
  test("authorizeAction per-action", () => {
    const a = authorizeAction("PRODUCTION_WRITE", "REJECT", { reviewMode: "STRICT", deliveryMode: "NORMAL", restrictions: [] });
    assert.equal(a.allowed, false);
    assert.ok(a.reason);
    const ok = authorizeAction("MERGE_CODE", "PASS", { reviewMode: "STRICT", deliveryMode: "NORMAL", restrictions: [] });
    assert.equal(ok.allowed, true);
  });
});
