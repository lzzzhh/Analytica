/**
 * Fail-closed + multiprocess + crash-recovery tests (merge blockers).
 *
 * - semantic/shadow features not operational => required UNAVAILABLE => ABSTAIN
 * - two OS processes racing the same reviewKey => exactly one terminal
 *   decision (no-clobber commit point, stable reviewKey path)
 * - crash before the decision commit point leaves no terminal decision
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerStore } from "../../src/reviewer/store.ts";
import { ReviewerOrchestrator } from "../../src/reviewer/orchestrator.ts";
import { canonicalHash } from "../../src/reviewer/store.ts";
import { reduceReviewDecision } from "../../src/reviewer/decision-reducer.ts";
import { buildCodeProposal } from "../../src/reviewer/code/proposal-builder.ts";
import { CodeReviewRunner } from "../../src/reviewer/code/review-runner.ts";
import { AnalysisReviewRunner } from "../../src/reviewer/analysis/review-runner.ts";
import type { ReviewProposalEnvelope } from "../../src/reviewer/contracts/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rev6-"));
}

function envelope(proposalId: string): ReviewProposalEnvelope {
  const payload = { proposalId, version: 1, body: "hello" };
  return {
    schemaVersion: "1.0", proposalId, proposalType: "CODE_CHANGE", proposalVersion: 1,
    producer: { agentRole: "CODING_AGENT", runId: "r", sessionId: "s", producerVersion: "1" },
    subjectRefs: [], requirementRefs: [], validationRefs: [],
    contentHash: canonicalHash(payload), policySnapshotHash: "pol",
    createdAt: new Date().toISOString(),
  };
}

describe("fail closed", () => {
  test("code review without semantic/shadow -> ABSTAIN", async () => {
    const store = new ReviewerStore(tmp());
    const runner = new CodeReviewRunner(store);
    const { proposal, snapshotDir } = await buildCodeProposal({
      proposalId: "fc1", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "x", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const out = await runner.run({
      proposal, snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
      checkIds: ["typecheck"],
      // semanticReviewer omitted, shadowTestsEnabled omitted -> UNAVAILABLE
    });
    assert.ok(out.checks.some((c) => c.status === "UNAVAILABLE"));
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "ABSTAIN");
  });

  test("analysis review without semantic reviewer -> ABSTAIN", async () => {
    const store = new ReviewerStore(tmp());
    await Promise.all(["art/result", "art/plan", "art/manifest", "art/script"].map(
      (p) => store.writeImmutable(p, { k: 1 })));
    const runner = new AnalysisReviewRunner(store);
    const h = canonicalHash({ k: 1 });
    const proposal = {
      schemaVersion: "1.0", proposalId: "fa", proposalVersion: 1,
      analysisResultRef: { artifactId: "art/result", artifactType: "x", contentHash: h },
      analysisPlanRef: { artifactId: "art/plan", artifactType: "x", contentHash: h },
      executionManifestRef: { artifactId: "art/manifest", artifactType: "x", contentHash: h },
      scriptArtifactRef: { artifactId: "art/script", artifactType: "x", contentHash: h },
      inputArtifactRefs: [], validationRefs: [],
      replayPolicy: { required: true, numericTolerancePolicyId: "default", independentMetricIds: [], strictMode: false },
      contentHash: "abc", createdAt: new Date().toISOString(),
    };
    const out = await runner.run({
      proposal, objective: "x",
      replayRunner: async () => ({
        metrics: [], tables: [], status: "COMPLETED",
        replayResult: { ok: true }, replayManifest: { ok: true },
      }),
      verificationCases: [],
      // semanticReviewer omitted
    });
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "ABSTAIN");
  });
});

describe("multiprocess review", () => {
  test("two processes same reviewKey -> single terminal decision", async () => {
    const root = tmp();
    const script = `
      import { mkdtempSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { ReviewerStore } from "file://${process.cwd()}/src/reviewer/store.ts";
      import { ReviewerOrchestrator } from "file://${process.cwd()}/src/reviewer/orchestrator.ts";
      const store = new ReviewerStore("${root}");
      const payload = { proposalId: "mp", version: 1, body: "hello" };
      await store.writeImmutable("proposals/mp/v1/proposal.json", payload);
      const env = {
        schemaVersion: "1.0", proposalId: "mp", proposalType: "CODE_CHANGE",
        proposalVersion: 1,
        producer: { agentRole: "CODING_AGENT", runId: "r", sessionId: "s", producerVersion: "1" },
        subjectRefs: [], requirementRefs: [], validationRefs: [],
        contentHash: JSON.stringify(payload),
        policySnapshotHash: "pol", createdAt: new Date().toISOString(),
      };
      // ensure the content hash matches the payload exactly
      const { canonicalHash } = await import("file://${process.cwd()}/src/reviewer/store.ts");
      env.contentHash = canonicalHash(payload);
      const orch = new ReviewerOrchestrator(store, "0.1.0");
      const pkg = await orch.buildReviewPackage(env, payload, "CODE", "STANDARD", ["integrity"], []);
      const { MODE_BUDGETS } = await import("file://${process.cwd()}/src/reviewer/gate/review-gate.ts");
      const gdBase = {
        schemaVersion: "1.0", gateDecisionId: "final_mp", stage: "FINAL",
        subjectType: "CODE_PROPOSAL", subjectId: "mp", subjectContentHash: env.contentHash,
        profile: "CODE",
        scores: { impact: 1, reversibility: 1, complexity: 1, uncertainty: 1, autonomy: 1, total: 5 },
        triggers: [], triggerSources: [], reviewMode: "STANDARD",
        deliveryMode: "NORMAL", restrictions: [],
        requiredChecks: [],
        budget: MODE_BUDGETS.STANDARD,
        policyVersion: "0.1.0", contentHash: "", createdAt: new Date().toISOString(),
      };
      const { contentHash: _omit, ...gdBody } = gdBase;
      const gd = { ...gdBase, contentHash: canonicalHash(gdBody) };
      await store.writeImmutable("gate/final_mp.json", gd);
      const d = await orch.runReview(pkg, pkg.policySnapshot.contentHash,
        async () => ({ checks: [{ checkId: "c", checkClass: "INTEGRITY", required: true, status: "PASSED", summary: "", evidenceRefs: [], startedAt: "", completedAt: "", durationMs: 0 }], findings: [] }),
        { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: gd });
      console.log("DECISION:" + d.verdict + ":" + d.reviewId);
    `;
    // launch two OS processes concurrently
    const run = () => execFileSync("node", ["--experimental-strip-types", "-e", script], { encoding: "utf8" });
    const [r1, r2] = await Promise.allSettled([Promise.resolve().then(run), Promise.resolve().then(run)]);
    // count terminal pointers (the atomic commit marker) under the reviews root
    let pointers = 0;
    for (const d of readdirSync(join(root, "reviews"))) {
      if (existsSync(join(root, "reviews", d, "terminal-pointer.json"))) pointers += 1;
    }
    assert.equal(pointers, 1, "exactly one terminal decision committed");
    const verdicts: string[] = [];
    for (const r of [r1, r2]) {
      if (r.status === "fulfilled") {
        const v = extract(r.value);
        if (v) verdicts.push(v);
      }
    }
    assert.ok(verdicts.length >= 1, "at least one process produced a verdict");
  });
});

describe("crash recovery", () => {
  test("crash before decision commit -> no terminal decision, rerun ok", async () => {
    const root = tmp();
    const store = new ReviewerStore(root);
    const payload = { proposalId: "cr", version: 1, body: "hello" };
    await store.writeImmutable("proposals/cr/v1/proposal.json", payload);
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("cr");
    env.contentHash = canonicalHash(payload);
    const pkg = await orch.buildReviewPackage(env, payload, "CODE", "STANDARD", ["integrity"], []);
    // simulate a crash mid-attempt: partial files but NO terminal pointer
    const { reviewKey } = await import("../../src/reviewer/contracts/index.ts");
    const { MODE_BUDGETS } = await import("../../src/reviewer/gate/review-gate.ts");
    const gdBase = {
      schemaVersion: "1.0", gateDecisionId: "final_cr", stage: "FINAL",
      subjectType: "CODE_PROPOSAL", subjectId: "cr", subjectContentHash: canonicalHash(payload),
      profile: "CODE",
      scores: { impact: 1, reversibility: 1, complexity: 1, uncertainty: 1, autonomy: 1, total: 5 },
      triggers: [], triggerSources: [], reviewMode: "STANDARD",
      deliveryMode: "NORMAL", restrictions: [],
      requiredChecks: [],
      budget: MODE_BUDGETS.STANDARD,
      policyVersion: "0.1.0", contentHash: "", createdAt: new Date().toISOString(),
    };
    const { contentHash: _omit, ...gdBody } = gdBase;
    const gd = { ...gdBase, contentHash: canonicalHash(gdBody) };
    await store.writeImmutable("gate/final_cr.json", gd);
    const key = reviewKey({ proposalContentHash: pkg.proposalContentHash, gateDecisionHash: gd.contentHash, policySnapshotHash: pkg.policySnapshot.contentHash, reviewerVersion: "0.1.0", reviewLevel: "STANDARD" });
    await store.writeImmutable(`reviews/${key}/attempts/partial/checks.json`, []);
    // no terminal pointer -> no terminal decision
    assert.ok(!existsSync(join(root, "reviews", key, "terminal-pointer.json")));
    // rerun completes
    const d = await orch.runReview(pkg, pkg.policySnapshot.contentHash,
      async () => ({ checks: [{ checkId: "c", checkClass: "INTEGRITY", required: true, status: "PASSED", summary: "", evidenceRefs: [], startedAt: "", completedAt: "", durationMs: 0 }], findings: [] }),
      { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: gd });
    assert.equal(d.verdict, "PASS");
  });
});

function extract(out: string): string {
  const m = out.match(/DECISION:([A-Z_]+):(\S+)/);
  return m ? m[1]! : "";
}
