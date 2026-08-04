/**
 * Phase 12 — governed review boundary acceptance tests.
 *
 * Gate decision re-verification, required-check coverage, promotion guard,
 * trusted principals, user preference, and diff-content classification.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerStore, canonicalHash } from "../../src/reviewer/store.ts";
import { ReviewerOrchestrator, enforceRequiredChecks } from "../../src/reviewer/orchestrator.ts";
import {
  applyOverride,
  authorizePromotion,
  evaluateCodeProposalGate,
  evaluateReviewGate,
  GateUnavailableError,
  MODE_BUDGETS,
  requiredChecksFor,
} from "../../src/reviewer/gate/review-gate.ts";
import type { ReviewGateDecisionArtifact } from "../../src/reviewer/gate/review-gate.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gov-"));
}

const SYSTEM = { source: "SYSTEM" as const, actorId: "agent", authenticated: true };
const OPERATOR = { source: "OPERATOR_CLI" as const, actorId: "op-1", authenticated: true };

async function makeGate(store: ReviewerStore, over: Partial<ReviewGateDecisionArtifact> = {}): Promise<ReviewGateDecisionArtifact> {
  const base: ReviewGateDecisionArtifact = {
    schemaVersion: "1.0",
    gateDecisionId: "final_gov",
    stage: "FINAL",
    subjectType: "CODE_PROPOSAL",
    subjectId: "gov1",
    subjectContentHash: "abc",
    profile: "CODE",
    scores: { impact: 1, reversibility: 1, complexity: 1, uncertainty: 1, autonomy: 1, total: 5 },
    triggers: [], triggerSources: [],
    reviewMode: "STANDARD",
    deliveryMode: "NORMAL",
    restrictions: [],
    requiredChecks: [],
    budget: MODE_BUDGETS.STANDARD,
    policyVersion: "1.0.0",
    contentHash: "",
    createdAt: new Date().toISOString(),
  };
  const merged = { ...base, ...over };
  const { contentHash: _c, ...body } = merged;
  merged.contentHash = canonicalHash(body);
  await store.writeImmutable(`gate/${merged.gateDecisionId}.json`, merged);
  return merged;
}

async function pkgOf(o: ReviewerOrchestrator, proposalId = "gov1") {
  const { buildCodeProposal } = await import("../../src/reviewer/code/proposal-builder.ts");
  const root = tmp();
  const { proposal, snapshotDir } = await buildCodeProposal({
    proposalId, proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
    frozenFiles: [{ path: "src/a.ts", status: "MODIFIED", content: "x" }],
    requirementRefs: [], workspaceRoot: root,
    proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
  });
  const { contentHash: _ch, ...payload } = proposal;
  await o.store.writeImmutable(`proposals/${proposalId}/v1/proposal.json`, payload);
  const pkg = await o.buildReviewPackage(proposal, payload, "CODE", "STANDARD", [], []);
  return { pkg, payload, snapshotDir };
}

const provider = async () => ({
  checks: [{ checkId: "integrity:diff", checkClass: "INTEGRITY", required: true, status: "PASSED", summary: "", evidenceRefs: [], startedAt: "", completedAt: "", durationMs: 0 }],
  findings: [],
});

describe("gate decision re-verification", () => {
  test("forged contentHash -> GATE_DECISION_TAMPERED", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg } = await pkgOf(o);
    const g = await makeGate(o.store);
    const forged = { ...g, contentHash: "deadbeef" };
    await assert.rejects(
      () => o.runReview(pkg, pkg.policySnapshot.contentHash, provider,
        { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: forged }),
      (e: Error) => e instanceof GateUnavailableError && e.message.includes("HASH_MISMATCH"),
    );
  });

  test("FINAL gate belonging to another proposal -> GATE_SUBJECT_MISMATCH", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg } = await pkgOf(o, "gov1");
    const g = await makeGate(o.store, { subjectId: "OTHER", subjectContentHash: canonicalHash({ other: 1 }) });
    await assert.rejects(
      () => o.runReview(pkg, pkg.policySnapshot.contentHash, provider,
        { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: g }),
      (e: Error) => e instanceof GateUnavailableError && e.message.includes("GATE_SUBJECT_MISMATCH"),
    );
  });
});

describe("required-check coverage", () => {
  test("STRICT code gate missing shadow check -> REQUIRED_CHECK_MISSING -> ABSTAIN", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const { pkg, payload } = await pkgOf(o);
    const g = await makeGate(o.store, {
      reviewMode: "STRICT",
      requiredChecks: requiredChecksFor("STRICT", "CODE"),
      subjectContentHash: canonicalHash(payload),
    });
    // provider returns integrity + semantic only — no shadow check
    const partial = async () => ({
      checks: [
        { checkId: "integrity:diff", checkClass: "INTEGRITY", required: true, status: "PASSED", summary: "", evidenceRefs: [], startedAt: "", completedAt: "", durationMs: 0 },
        { checkId: "semantic:llm", checkClass: "SEMANTIC", required: true, status: "PASSED", summary: "1 finding", evidenceRefs: [], startedAt: "", completedAt: "", durationMs: 0 },
      ],
      findings: [],
    });
    const d = await o.runReview(pkg, pkg.policySnapshot.contentHash, partial,
      { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: g });
    assert.equal(d.verdict, "ABSTAIN");
    assert.ok(d.blockingFindings.length >= 0);
    // and the coverage check itself is visible
    const enforced = enforceRequiredChecks(g, (await partial()).checks);
    assert.ok(enforced.some((c) => c.errorCode === "REQUIRED_CHECK_MISSING" && c.status === "UNAVAILABLE"));
  });

  test("STANDARD analysis requires integrity+replay+semantic, never exec", () => {
    const rc = requiredChecksFor("STANDARD", "ANALYSIS");
    assert.deepEqual(rc, ["integrity", "replay", "semantic"]);
    assert.ok(!rc.includes("execution"));
    assert.deepEqual(requiredChecksFor("STRICT", "ANALYSIS"), ["integrity", "replay", "independent-verification", "semantic"]);
    assert.deepEqual(requiredChecksFor("DETERMINISTIC_ONLY", "CODE"), ["integrity", "execution"]);
  });
});

describe("promotion guard", () => {
  test("EXPLORATORY_UNREVIEWED blocks formal report", () => {
    const gate = { reviewMode: "NONE" as const, deliveryMode: "EXPLORATORY_UNREVIEWED" as const, restrictions: ["NO_MERGE", "NO_EXTERNAL_PUBLICATION", "NO_PRODUCTION_WRITE", "NO_FORMAL_REPORT", "NO_GOVERNANCE_APPROVAL"] as const };
    const p = authorizePromotion("UNREVIEWED_LOW_RISK", gate);
    assert.ok(!p.allowedActions.includes("PUBLISH_REPORT"));
    assert.ok(p.allowedActions.includes("DELIVER_EXPLORATORY_RESULT"));
  });
  test("EXPLORATORY_UNREVIEWED blocks production write", () => {
    const gate = { reviewMode: "NONE" as const, deliveryMode: "EXPLORATORY_UNREVIEWED" as const, restrictions: ["NO_PRODUCTION_WRITE"] as const };
    const p = authorizePromotion("UNREVIEWED_LOW_RISK", gate);
    assert.ok(!p.allowedActions.includes("PRODUCTION_WRITE"));
  });
  test("PASS allows formal delivery and human approval", () => {
    const p = authorizePromotion("PASS", { reviewMode: "STRICT", deliveryMode: "NORMAL", restrictions: [] });
    assert.ok(p.allowedActions.includes("MERGE_CODE"));
    assert.ok(p.allowedActions.includes("REQUEST_HUMAN_APPROVAL"));
  });
});

describe("trusted principals", () => {
  test("SYSTEM principal forging authority=OPERATOR_CLI -> override rejected", () => {
    const res = applyOverride("STANDARD", SYSTEM, {
      requestedMode: "STRICT", actor: "main-agent", reason: "please", authority: "OPERATOR_CLI",
    });
    assert.ok(res.rejected, "LLM/SYSTEM cannot claim CLI authority");
    assert.equal(res.mode, "STANDARD");
  });
  test("authenticated OPERATOR_CLI may upgrade", () => {
    const res = applyOverride("STANDARD", OPERATOR, {
      requestedMode: "STRICT", actor: "op-1", reason: "manual gate", authority: "OPERATOR_CLI",
    });
    assert.equal(res.mode, "STRICT");
    assert.ok(!res.rejected);
  });
});

describe("user review preference", () => {
  test("user requests STRICT for a NONE-scored task -> STRICT", async () => {
    const o = new ReviewerOrchestrator(new ReviewerStore(tmp()), "1.0.0");
    const g = await o.planReview({
      stage: "FINAL", subjectType: "CODE_PROPOSAL", subjectId: "u1", subjectContentHash: "h",
      profile: "CODE",
      userReviewPreference: "STRICT",
      codeMeta: { changedPaths: ["docs/readme.md"], diffLineCount: 5, addedFileCount: 0, deletedFileCount: 0, toolCalls: [], testsPassed: true, staticChecksPassed: true },
    }, SYSTEM);
    assert.equal(g.reviewMode, "STRICT");
  });
});

describe("path + diff classification", () => {
  test("generated snapshot fixture change does NOT auto-trigger PRODUCTION_WRITE", () => {
    const ev = evaluateCodeProposalGate({
      changedPaths: ["tests/fixtures/generated/snapshot.json"],
      diffLineCount: 10, addedFileCount: 1, deletedFileCount: 0,
      toolCalls: [], testsPassed: true, staticChecksPassed: true,
    });
    assert.ok(!ev.input.triggers.includes("PRODUCTION_WRITE"));
  });
  test("diff adding DROP TABLE -> STRICT", () => {
    const ev = evaluateCodeProposalGate({
      changedPaths: ["db/migrate.sql"],
      diffContent: "+DROP TABLE orders;",
      diffLineCount: 3, addedFileCount: 1, deletedFileCount: 0,
      toolCalls: [], testsPassed: true, staticChecksPassed: true,
    });
    assert.ok(ev.input.triggers.includes("DATA_DELETE_OR_MIGRATION"));
    assert.equal(evaluateReviewGate(ev.input), "STRICT");
  });
});
