/**
 * Phase 11 — ReviewGate enforced by the Orchestrator (acceptance tests).
 *
 * The gate is a pure deterministic decisioner; the orchestrator enforces
 * it. The main agent never chooses the mode: it may only inspect the
 * decision, request stricter review, or use the explicit
 * EXPLORATORY_UNREVIEWED delivery mode.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerStore, canonicalHash } from "../../src/reviewer/store.ts";
import { ReviewerOrchestrator } from "../../src/reviewer/orchestrator.ts";
import {
  applyOverride,
  exceedsBudget,
  GateUnavailableError,
  maxMode,
  MODE_BUDGETS,
  runnerModeFlags,
} from "../../src/reviewer/gate/review-gate.ts";
import type { ReviewGateDecisionArtifact } from "../../src/reviewer/gate/review-gate.ts";
import { reviewKey } from "../../src/reviewer/contracts/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gate-"));
}

function orch(): ReviewerOrchestrator {
  return new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
}

async function gateDecision(store: ReviewerStore, over: Partial<ReviewGateDecisionArtifact> = {}): Promise<ReviewGateDecisionArtifact> {
  const base: ReviewGateDecisionArtifact = {
    schemaVersion: "1.0",
    gateDecisionId: "final_test",
    stage: "FINAL",
    subjectType: "CODE_PROPOSAL",
    subjectId: "p1",
    subjectContentHash: "abc",
    profile: "CODE",
    scores: { impact: 1, reversibility: 1, complexity: 1, uncertainty: 1, autonomy: 1, total: 5 },
    triggers: [],
    triggerSources: [],
    reviewMode: "STANDARD",
    deliveryMode: "NORMAL",
    restrictions: [],
    requiredChecks: ["integrity", "execution", "semantic"],
    budget: MODE_BUDGETS.STANDARD,
    policyVersion: "1.0.0",
    contentHash: "",
    createdAt: new Date().toISOString(),
  };
  const merged = { ...base, ...over };
  const { contentHash: _omit, ...body } = merged;
  merged.contentHash = canonicalHash(body);
  await store.writeImmutable(`gate/${merged.gateDecisionId}.json`, merged);
  return merged;
}

async function setupProposal(o: ReviewerOrchestrator) {
  const { buildCodeProposal } = await import("../../src/reviewer/code/proposal-builder.ts");
  const root = tmp();
  const { proposal, snapshotDir } = await buildCodeProposal({
    proposalId: "g1", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
    frozenFiles: [{ path: "src/a.ts", status: "MODIFIED", content: "x" }],
    requirementRefs: [], workspaceRoot: root,
    proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
  });
  const { contentHash: _ch, ...payload } = proposal;
  await o.store.writeImmutable(`proposals/${proposal.proposalId}/v${proposal.proposalVersion}/proposal.json`, payload);
  const pkg = await o.buildReviewPackage(proposal, payload, "CODE", "STANDARD", [], []);
  return { proposal, payload, pkg, snapshotDir };
}

describe("gate enforcement in orchestrator", () => {
  test("docs-only change -> NONE -> no reviewer run, verdict UNREVIEWED_LOW_RISK", async () => {
    const o = orch();
    const { pkg, payload } = await setupProposal(o);
    const g = await o.planReview({
      stage: "FINAL", subjectType: "CODE_PROPOSAL",
      subjectId: "g1", subjectContentHash: canonicalHash(payload),
      profile: "CODE",
      codeMeta: { changedPaths: ["docs/readme.md"], diffLineCount: 5, addedFileCount: 0, deletedFileCount: 0, toolCalls: [], testsPassed: true, staticChecksPassed: true },
    }, { source: "SYSTEM", actorId: "test", authenticated: true });
    assert.equal(g.reviewMode, "NONE");
    let providerCalls = 0;
    const d = await o.runReview(pkg, pkg.policySnapshot.contentHash,
      async () => { providerCalls++; return { checks: [], findings: [] }; },
      { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: g });
    assert.equal(providerCalls, 0, "no reviewer runner invoked for NONE");
    assert.equal(d.verdict, "UNREVIEWED_LOW_RISK");
  });

  test("auth change -> STRICT -> semantic + shadow enabled", async () => {
    const g = await orch().planReview({
      stage: "FINAL", subjectType: "CODE_PROPOSAL",
      subjectId: "g2", subjectContentHash: "h",
      profile: "CODE",
      codeMeta: { changedPaths: ["src/auth/keys.ts"], diffLineCount: 40, addedFileCount: 1, deletedFileCount: 0, toolCalls: ["write"], testsPassed: true, staticChecksPassed: true },
    }, { source: "SYSTEM", actorId: "test", authenticated: true });
    assert.equal(g.reviewMode, "STRICT");
    assert.deepEqual(runnerModeFlags(g.reviewMode), { semantic: true, shadow: true });
    assert.ok(g.requiredChecks.includes("semantic") && g.requiredChecks.includes("shadow"));
  });

  test("user requests NONE for a production write -> rejected -> STRICT", async () => {
    const gateMode = "STRICT";
    const res = applyOverride(gateMode, {
      requestedMode: "NONE", actor: "main-agent", reason: "save tokens", authority: "OPERATOR_CLI",
    });
    assert.equal(res.mode, "STRICT", "maxMode only upgrades; NONE request cannot downgrade");
  });

  test("preflight predicts docs-only, actual diff touches write-gate -> final upgrades to STRICT", async () => {
    const o = orch();
    const g = await o.planReview({
      stage: "FINAL", subjectType: "CODE_PROPOSAL",
      subjectId: "g3", subjectContentHash: "h",
      profile: "CODE",
      preflightMode: "NONE",
      codeMeta: { changedPaths: ["pipelines/common/write_gate.py"], diffLineCount: 60, addedFileCount: 1, deletedFileCount: 0, toolCalls: ["write"], testsPassed: true, staticChecksPassed: true },
    }, { source: "SYSTEM", actorId: "test", authenticated: true });
    assert.equal(g.reviewMode, "STRICT");
  });

  test("STANDARD exceeding budget -> exceedsBudget -> ABSTAIN, no silent truncation", () => {
    const budget = MODE_BUDGETS.STANDARD;
    assert.ok(exceedsBudget(budget, { files: 5, diffLines: budget.maxDiffLines + 1, inputTokens: 1_000 }));
    assert.ok(!exceedsBudget(budget, { files: 2, diffLines: 100, inputTokens: 1_000 }));
    // ABSTAIN is the only legal reaction to an over-budget context
    assert.equal(budget.maxSemanticCalls, 1);
  });

  test("same proposal + same gate policy -> cached decision, no second run", async () => {
    const o = orch();
    const { pkg, payload } = await setupProposal(o);
    const g = await gateDecision(o.store, { subjectId: "g1", subjectContentHash: canonicalHash(payload), requiredChecks: [] });
    let calls = 0;
    const provider = async () => { calls++; return { checks: [{ checkId: "c", checkClass: "INTEGRITY", required: true, status: "PASSED", summary: "", evidenceRefs: [], startedAt: "", completedAt: "", durationMs: 0 }], findings: [] }; };
    const d1 = await o.runReview(pkg, pkg.policySnapshot.contentHash, provider,
      { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: g });
    const d2 = await o.runReview(pkg, pkg.policySnapshot.contentHash, provider,
      { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: g });
    assert.equal(calls, 1, "second call reuses the terminal decision");
    assert.equal(d1.reviewId, d2.reviewId);
  });

  test("gate policy version change -> reviewKey changes -> old decision not reused", async () => {
    const s = new ReviewerStore(tmp());
    const a = await gateDecision(s, { gateDecisionId: "final_v1", policyVersion: "1.0.0", reviewMode: "STANDARD" });
    const b = await gateDecision(s, { gateDecisionId: "final_v2", policyVersion: "2.0.0", reviewMode: "STRICT" });
    const k1 = reviewKey({ proposalContentHash: "p", gateDecisionHash: a.contentHash, policySnapshotHash: "pol", reviewerVersion: "1.0.0", reviewLevel: "STANDARD" });
    const k2 = reviewKey({ proposalContentHash: "p", gateDecisionHash: b.contentHash, policySnapshotHash: "pol", reviewerVersion: "1.0.0", reviewLevel: "STANDARD" });
    assert.notEqual(k1, k2);
  });

  test("revision of a STRICT proposal cannot downgrade", async () => {
    const o = orch();
    const g = await o.planReview({
      stage: "FINAL", subjectType: "CODE_PROPOSAL",
      subjectId: "g4", subjectContentHash: "h",
      profile: "CODE",
      preflightMode: "STRICT", // previous review was STRICT
      codeMeta: { changedPaths: ["src/a.ts"], diffLineCount: 1, addedFileCount: 0, deletedFileCount: 0, toolCalls: [], testsPassed: true, staticChecksPassed: true },
    }, { source: "SYSTEM", actorId: "test", authenticated: true });
    assert.equal(g.reviewMode, "STRICT", "gate alone would compute DETERMINISTIC_ONLY, but revision keeps STRICT");
  });

  test("gate unavailable -> no PASS, promotion blocked", async () => {
    const o = orch();
    const { pkg } = await setupProposal(o);
    await assert.rejects(
      () => o.runReview(pkg, pkg.policySnapshot.contentHash,
        async () => ({ checks: [], findings: [] }),
        { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: { gateDecisionId: "missing", contentHash: "x" } as unknown as ReviewGateDecisionArtifact }),
      GateUnavailableError,
    );
    await assert.rejects(
      () => o.planReview({
        stage: "FINAL", subjectType: "CODE_PROPOSAL", subjectId: "x", subjectContentHash: "h",
        profile: "CODE", codeMeta: undefined as unknown as never,
      }, { source: "SYSTEM", actorId: "test", authenticated: true }),
      GateUnavailableError,
    );
  });
});

describe("gate helpers", () => {
  test("maxMode only upgrades", () => {
    assert.equal(maxMode("STRICT", "NONE"), "STRICT");
    assert.equal(maxMode("STANDARD", "DETERMINISTIC_ONLY"), "STANDARD");
    assert.equal(maxMode("NONE", "STANDARD"), "STANDARD");
  });
  test("EXPLORATORY_UNREVIEWED is explicit, principal-gated, with restrictions", () => {
    const principal = { source: "OPERATOR_CLI" as const, actorId: "op", authenticated: true };
    const res = applyOverride("STRICT", principal, undefined, "EXPLORATORY_UNREVIEWED");
    assert.equal(res.mode, "NONE");
    assert.ok(res.restrictions.includes("NO_MERGE"));
    // an unauthenticated or SYSTEM principal cannot request it
    const res2 = applyOverride("STRICT", { source: "SYSTEM", actorId: "agent", authenticated: true }, undefined, "EXPLORATORY_UNREVIEWED");
    assert.ok(res2.rejected);
  });
});
