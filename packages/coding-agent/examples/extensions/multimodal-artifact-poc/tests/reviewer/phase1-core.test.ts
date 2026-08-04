/**
 * Phase 1 tests — deterministic review core (store, policy, lock,
 * idempotency, stale guard, decision reducer integration).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerStore, ReviewerStoreError, canonicalHash } from "../../src/reviewer/store.ts";
import { buildPolicySnapshot } from "../../src/reviewer/policy.ts";
import { ReviewerOrchestrator, StaleProposalError } from "../../src/reviewer/orchestrator.ts";
import { reviewKey } from "../../src/reviewer/contracts/index.ts";
import { MODE_BUDGETS } from "../../src/reviewer/gate/review-gate.ts";
import type { ReviewProposalEnvelope } from "../../src/reviewer/contracts/index.ts";
import type { ReviewCheckResult, ReviewFinding } from "../../src/reviewer/contracts/index.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "reviewer-test-"));
}

function envelope(proposalId: string, version = 1): ReviewProposalEnvelope {
  const payload = { proposalId, version, body: "hello" };
  return {
    schemaVersion: "1.0",
    proposalId,
    proposalType: "CODE_CHANGE",
    proposalVersion: version,
    producer: { agentRole: "CODING_AGENT", runId: "r1", sessionId: "s1", producerVersion: "1" },
    subjectRefs: [],
    requirementRefs: [],
    validationRefs: [],
    contentHash: canonicalHash(payload),
    policySnapshotHash: "pol",
    createdAt: new Date().toISOString(),
  };
}

function checks(...statuses: Array<Partial<ReviewCheckResult>>): ReviewCheckResult[] {
  return statuses.map((s, i) => ({
    checkId: `c${i}`, checkClass: s.checkClass ?? "INTEGRITY",
    required: s.required ?? true, status: s.status ?? "PASSED",
    summary: "", evidenceRefs: [], startedAt: "", completedAt: "", durationMs: 0,
  }));
}

async function gateDecision(store: ReviewerStore, proposalId = "p1") {
  const base = {
    schemaVersion: "1.0", gateDecisionId: `final_${proposalId}`, stage: "FINAL",
    subjectType: "CODE_PROPOSAL", subjectId: proposalId,
    subjectContentHash: canonicalHash({ proposalId, version: 1, body: "hello" }),
    profile: "CODE" as const,
    scores: { impact: 1, reversibility: 1, complexity: 1, uncertainty: 1, autonomy: 1, total: 5 },
    triggers: [], triggerSources: [], reviewMode: "STANDARD" as const,
    deliveryMode: "NORMAL" as const, restrictions: [],
    requiredChecks: [],
    budget: MODE_BUDGETS.STANDARD,
    policyVersion: "0.1.0", contentHash: "", createdAt: new Date().toISOString(),
  };
  const { contentHash: _omit, ...body } = base;
  const g = { ...base, contentHash: canonicalHash(body) };
  await store.writeImmutable(`gate/final_${proposalId}.json`, g);
  return g;
}

function finding(severity: ReviewFinding["severity"]): ReviewFinding {
  return {
    findingId: `f-${severity}`, severity, category: "x", claim: "c",
    evidenceRefs: [], suggestedAction: "a", deterministic: true,
    confidence: 0.9, createdAt: "",
  };
}


async function persistProposal(store: ReviewerStore, payload: Record<string, unknown>): Promise<void> {
  const env = payload as { proposalId: string };
  await store.writeImmutable(
    `proposals/${env.proposalId}/v1/proposal.json`, payload);
}

describe("store", () => {
  test("immutable no-clobber write", async () => {
    const store = new ReviewerStore(tmpRoot());
    await store.writeImmutable("proposals/a/v1/proposal.json", { id: "a" });
    await assert.rejects(
      () => store.writeImmutable("proposals/a/v1/proposal.json", { id: "b" }),
      ReviewerStoreError,
    );
  });

  test("path escape rejected", async () => {
    const store = new ReviewerStore(tmpRoot());
    await assert.rejects(() => store.writeImmutable("../evil", {}), ReviewerStoreError);
  });

  test("hash matches canonicalJson", () => {
    const store = new ReviewerStore(tmpRoot());
    assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
  });
});

describe("policy", () => {
  test("snapshot hash is stable and covers fields", () => {
    const p1 = buildPolicySnapshot({
      policyVersion: "1.0", profile: "CODE", reviewLevel: "STANDARD",
      requiredChecks: ["a"], advisoryChecks: [], severityRules: {},
    });
    const p2 = buildPolicySnapshot({
      policyVersion: "1.0", profile: "CODE", reviewLevel: "STANDARD",
      requiredChecks: ["a"], advisoryChecks: [], severityRules: {},
    });
    assert.equal(p1.contentHash, p2.contentHash);
    const p3 = buildPolicySnapshot({
      policyVersion: "1.0", profile: "CODE", reviewLevel: "STRICT",
      requiredChecks: ["a"], advisoryChecks: [], severityRules: {},
    });
    assert.notEqual(p1.contentHash, p3.contentHash);
  });
});

describe("orchestrator", () => {
  test("idempotency: same reviewKey returns existing decision", async () => {
    const store = new ReviewerStore(tmpRoot());
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("p1");
    await persistProposal(store, { proposalId: "p1", version: 1, body: "hello" });
    const pkg = await orch.buildReviewPackage(env, { proposalId: "p1", version: 1, body: "hello" },
      "CODE", "STANDARD", ["integrity"], []);
    const input = { runId: "r", sessionId: "s", model: "m", profile: "CODE" as const, gateDecision: await gateDecision(store, "p1") };

    const checkProvider = async () => ({ checks: checks(), findings: [] });
    const d1 = await orch.runReview(pkg, pkg.policySnapshot.contentHash, checkProvider, input);
    const d2 = await orch.runReview(pkg, pkg.policySnapshot.contentHash, checkProvider, input);
    assert.equal(d1.reviewId, d2.reviewId); // idempotent: same decision returned
    assert.equal(d1.verdict, "PASS");
  });

  test("required failed -> CHANGES_REQUIRED persisted", async () => {
    const store = new ReviewerStore(tmpRoot());
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("p2");
    await persistProposal(store, { proposalId: "p2", version: 1, body: "hello" });
    const pkg = await orch.buildReviewPackage(env, { proposalId: "p2", version: 1, body: "hello" },
      "CODE", "STANDARD", ["testing"], []);
    const d = await orch.runReview(pkg, pkg.policySnapshot.contentHash,
      async () => ({ checks: checks({ status: "FAILED", checkClass: "TESTING" }), findings: [] }),
      { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: await gateDecision(store, "p2") });
    assert.equal(d.verdict, "CHANGES_REQUIRED");
  });

  test("integrity failure -> REJECT", async () => {
    const store = new ReviewerStore(tmpRoot());
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("p3");
    await persistProposal(store, { proposalId: "p3", version: 1, body: "hello" });
    const pkg = await orch.buildReviewPackage(env, { proposalId: "p3", version: 1, body: "hello" },
      "CODE", "STANDARD", ["integrity"], []);
    const d = await orch.runReview(pkg, pkg.policySnapshot.contentHash,
      async () => ({ checks: checks({ status: "FAILED", checkClass: "INTEGRITY" }), findings: [] }),
      { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: await gateDecision(store, "p3") });
    assert.equal(d.verdict, "REJECT");
  });

  test("required unavailable -> ABSTAIN", async () => {
    const store = new ReviewerStore(tmpRoot());
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("p4");
    await persistProposal(store, { proposalId: "p4", version: 1, body: "hello" });
    const pkg = await orch.buildReviewPackage(env, { proposalId: "p4", version: 1, body: "hello" },
      "CODE", "STANDARD", ["replay"], []);
    const d = await orch.runReview(pkg, pkg.policySnapshot.contentHash,
      async () => ({ checks: checks({ status: "UNAVAILABLE" }), findings: [] }),
      { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: await gateDecision(store, "p4") });
    assert.equal(d.verdict, "ABSTAIN");
  });

  test("stale proposal refused", async () => {
    const store = new ReviewerStore(tmpRoot());
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("p5");
    await persistProposal(store, { proposalId: "p5", version: 1, body: "hello" });
    const pkg = await orch.buildReviewPackage(env, { proposalId: "p5", version: 1, body: "hello" },
      "CODE", "STANDARD", ["integrity"], []);
    // tamper the stored proposal directly (bypasses no-clobber, simulating
    // an attacker/rogue writer mutating the frozen payload)
    writeFileSync(join(store.root, "proposals/p5/v1/proposal.json"),
      JSON.stringify({ proposalId: "p5", version: 1, body: "TAMPERED" }) + "\n");
    const gd = await gateDecision(store, "p5");
    await assert.rejects(
      () => orch.runReview(pkg, pkg.policySnapshot.contentHash,
        async () => ({ checks: checks(), findings: [] }),
        { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: gd }),
      StaleProposalError,
    );
  });

  test("concurrent same key -> single worker", async () => {
    const store = new ReviewerStore(tmpRoot());
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("p6");
    await persistProposal(store, { proposalId: "p6", version: 1, body: "hello" });
    const pkg = await orch.buildReviewPackage(env, { proposalId: "p6", version: 1, body: "hello" },
      "CODE", "STANDARD", ["integrity"], []);
    let runs = 0;
    const checkProvider = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { checks: checks(), findings: [] };
    };
    const input = { runId: "r", sessionId: "s", model: "m", profile: "CODE" as const, gateDecision: await gateDecision(store, "p6") };
    const [d1, d2] = await Promise.all([
      orch.runReview(pkg, pkg.policySnapshot.contentHash, checkProvider, input),
      orch.runReview(pkg, pkg.policySnapshot.contentHash, checkProvider, input),
    ]);
    assert.equal(runs, 1); // lock + idempotency: provider ran once
    assert.equal(d1.reviewId, d2.reviewId);
  });

  test("reviewKey changes with policy", () => {
    const base = { proposalContentHash: "p", policySnapshotHash: "pol",
                  reviewerVersion: "0.1.0", reviewLevel: "STANDARD" as const };
    assert.notEqual(reviewKey(base), reviewKey({ ...base, policySnapshotHash: "pol2" }));
  });
});
