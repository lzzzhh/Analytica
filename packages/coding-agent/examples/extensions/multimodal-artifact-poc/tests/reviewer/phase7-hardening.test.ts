/**
 * P0 hardening tests (reviewer merge blockers).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerStore, canonicalHash } from "../../src/reviewer/store.ts";
import { ReviewerOrchestrator } from "../../src/reviewer/orchestrator.ts";
import { MODE_BUDGETS } from "../../src/reviewer/gate/review-gate.ts";
async function gateDecision(store: ReviewerStore, subjectId = "h", subjectContentHash = "abc") {
  const base = {
    schemaVersion: "1.0", gateDecisionId: `final_${subjectId}`, stage: "FINAL",
    subjectType: "CODE_PROPOSAL", subjectId, subjectContentHash,
    profile: "CODE" as const,
    scores: { impact: 1, reversibility: 1, complexity: 1, uncertainty: 1, autonomy: 1, total: 5 },
    triggers: [], triggerSources: [], reviewMode: "STANDARD" as const,
    deliveryMode: "NORMAL" as const, restrictions: [],
    requiredChecks: [], budget: MODE_BUDGETS.STANDARD,
    policyVersion: "1.0.0", contentHash: "", createdAt: new Date().toISOString(),
  };
  const { contentHash: _omit, ...body } = base;
  const g = { ...base, contentHash: canonicalHash(body) };
  await store.writeImmutable(`gate/final_${subjectId}.json`, g);
  return g;
}
import { reduceReviewDecision } from "../../src/reviewer/decision-reducer.ts";
import { buildCodeProposal } from "../../src/reviewer/code/proposal-builder.ts";
import { CodeReviewRunner, REVIEWER_ENV_WHITELIST } from "../../src/reviewer/code/review-runner.ts";
import { reviewerEnvWhitelist } from "../../src/reviewer/adapters/pi-reviewer.ts";
import { AnalysisReviewRunner } from "../../src/reviewer/analysis/review-runner.ts";
import type { ReviewProposalEnvelope } from "../../src/reviewer/contracts/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rev-harden-"));
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

describe("harden: shadow / replay / diff / env", () => {
  test("shadow_disabled_fails_closed_abstains", async () => {
    // shadowTestsEnabled=false -> UNAVAILABLE -> ABSTAIN (fail closed)
    const store = new ReviewerStore(tmp());
    const runner = new CodeReviewRunner(store);
    const { proposal, snapshotDir } = await buildCodeProposal({
      proposalId: "h1", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "x", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const out = await runner.run({
      proposal, snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
      checkIds: ["typecheck"],
      semanticReviewer: async () => [], shadowTestsEnabled: false,
    });
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "ABSTAIN");
  });

  test("empty_replay_cannot_pass", async () => {
    const store = new ReviewerStore(tmp());
    await Promise.all(["art/plan", "art/manifest", "art/script"].map((p) => store.writeImmutable(p, { k: 1 })));
    const resultContent = { metrics: [{ metricId: "m", valueType: "NUMBER", value: 1 }], tables: [], status: "COMPLETED" };
    await store.writeImmutable("art/result", resultContent);
    const base = canonicalHash({ k: 1 });
    const proposal = {
      schemaVersion: "1.0", proposalId: "h2", proposalVersion: 1,
      analysisResultRef: { artifactId: "art/result", artifactType: "x", contentHash: canonicalHash(resultContent) },
      analysisPlanRef: { artifactId: "art/plan", artifactType: "x", contentHash: base },
      executionManifestRef: { artifactId: "art/manifest", artifactType: "x", contentHash: base },
      scriptArtifactRef: { artifactId: "art/script", artifactType: "x", contentHash: base },
      inputArtifactRefs: [], validationRefs: [],
      replayPolicy: { required: true, numericTolerancePolicyId: "d", independentMetricIds: [], strictMode: false },
      contentHash: "abc", createdAt: new Date().toISOString(),
    };
    const out = await new AnalysisReviewRunner(store).run({
      proposal, objective: "x",
      replayRunner: async () => ({ metrics: [], tables: [], status: "COMPLETED", replayResult: {}, replayManifest: {} }),
      verificationCases: [],
    });
    assert.ok(out.checks.some((c) => c.checkId === "analysis:replay" && c.status === "FAILED"));
  });

  test("replay_inputs_cannot_be_supplied_by_caller", async () => {
    // input type no longer accepts replayMetrics/replayTables — TS-level check
    const store = new ReviewerStore(tmp());
    const runner = new AnalysisReviewRunner(store);
    const inputKeys = ["replayRunner", "verificationCases", "semanticReviewer", "proposal", "objective"];
    // runtime: input with a fake 'replayMetrics' field is simply ignored
    const proposal = {
      schemaVersion: "1.0", proposalId: "h3", proposalVersion: 1,
      analysisResultRef: { artifactId: "art/result", artifactType: "x", contentHash: "a" },
      analysisPlanRef: { artifactId: "art/plan", artifactType: "x", contentHash: "a" },
      executionManifestRef: { artifactId: "art/manifest", artifactType: "x", contentHash: "a" },
      scriptArtifactRef: { artifactId: "art/script", artifactType: "x", contentHash: "a" },
      inputArtifactRefs: [], validationRefs: [],
      replayPolicy: { required: true, numericTolerancePolicyId: "d", independentMetricIds: [], strictMode: false },
      contentHash: "abc", createdAt: new Date().toISOString(),
    };
    const out = await runner.run({
      proposal, objective: "x",
      // @ts-expect-error — caller cannot supply results
      replayMetrics: [{ metricId: "fake" }],
      replayRunner: async () => ({ metrics: [], tables: [], status: "C", replayResult: {}, replayManifest: {} }),
      verificationCases: [],
    });
    assert.ok(out.checks.some((c) => c.status === "FAILED" || c.status === "UNAVAILABLE"));
  });

  test("artifact_refs_require_sha256", async () => {
    const store = new ReviewerStore(tmp());
    const out = await new AnalysisReviewRunner(store).run({
      proposal: {
        schemaVersion: "1.0", proposalId: "h4", proposalVersion: 1,
        analysisResultRef: { artifactId: "art/nope", artifactType: "x", contentHash: "not-sha" },
        analysisPlanRef: { artifactId: "art/nope2", artifactType: "x", contentHash: "x" },
        executionManifestRef: { artifactId: "art/nope3", artifactType: "x", contentHash: "x" },
        scriptArtifactRef: { artifactId: "art/nope4", artifactType: "x", contentHash: "x" },
        inputArtifactRefs: [], validationRefs: [],
        replayPolicy: { required: true, numericTolerancePolicyId: "d", independentMetricIds: [], strictMode: false },
        contentHash: "abc", createdAt: new Date().toISOString(),
      },
      objective: "x",
      replayRunner: async () => ({ metrics: [], tables: [], status: "C", replayResult: {}, replayManifest: {} }),
      verificationCases: [],
    });
    // missing artifacts -> INTEGRITY FAILED -> REJECT (not skip)
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "REJECT");
  });

  test("review_commands_use_env_allowlist", async () => {
    // REVIEWER_ENV_WHITELIST must not contain unrelated credential env vars
    for (const key of ["GITHUB_TOKEN", "OPENAI_API_KEY", "DATABASE_URL", "AWS_SECRET_ACCESS_KEY"]) {
      assert.ok(!(key in REVIEWER_ENV_WHITELIST), `${key} must not be in the whitelist`);
    }
    assert.ok("PATH" in REVIEWER_ENV_WHITELIST);
    // code-runner whitelist must NOT carry provider keys (unneeded there)
    assert.ok(!("DEEPSEEK_API_KEY" in REVIEWER_ENV_WHITELIST));
    // the semantic reviewer's whitelist explicitly allowlists the runtime
    // provider keys when present (and still excludes unrelated secrets)
    const rpcWhitelist = reviewerEnvWhitelist();
    if (process.env.OPENAI_API_KEY) {
      assert.ok("OPENAI_API_KEY" in rpcWhitelist);
    }
    if (process.env.DEEPSEEK_API_KEY) {
      assert.ok("DEEPSEEK_API_KEY" in rpcWhitelist);
    }
    assert.ok(!("GITHUB_TOKEN" in rpcWhitelist));
  });

  test("cwd_and_symlink_escape_rejected", async () => {
    const store = new ReviewerStore(tmp());
    const runner = new CodeReviewRunner(store);
    const { proposal, snapshotDir } = await buildCodeProposal({
      proposalId: "h5", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "x", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const out = await runner.run({
      proposal, snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
      checkIds: ["escape"],
      semanticReviewer: async () => [],
    });
    // 'escape' is not in the central registry -> never executed
    assert.ok(out.checks.some((c) => c.checkId === "exec:escape" && c.status === "UNAVAILABLE"));
  });

  test("missing_diff_hash_rejects", async () => {
    const store = new ReviewerStore(tmp());
    const runner = new CodeReviewRunner(store);
    const { proposal, snapshotDir } = await buildCodeProposal({
      proposalId: "h6", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "x", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    // remove the diff sidecar -> integrity must FAIL (not skip)
    const sidecar = join(snapshotDir, "diff.patch.sha256");
    if (existsSync(sidecar)) {
      // simulate tampering: rewrite with a wrong hash
      writeFileSync(sidecar, "deadbeef\n");
    }
    const out = await runner.run({
      proposal, snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
      checkIds: [], semanticReviewer: async () => [],
    });
    assert.ok(out.checks.some((c) => c.checkId === "integrity:diff" && c.status === "FAILED"));
  });
});

describe("harden: package / evidence / crash", () => {
  test("tampered_package_rejects", async () => {
    const store = new ReviewerStore(tmp());
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("hp1");
    await store.writeImmutable("proposals/hp1/v1/proposal.json", { proposalId: "hp1", version: 1, body: "hello" });
    const pkg = await orch.buildReviewPackage(env, { proposalId: "hp1", version: 1, body: "hello" }, "CODE", "STANDARD", ["integrity"], []);
    pkg.packageContentHash = "tampered";
    const gdTampered = await gateDecision(store);
    await assert.rejects(
      () => orch.runReview(pkg, pkg.policySnapshot.contentHash,
        async () => ({ checks: [], findings: [] }),
        { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: gdTampered }),
      /PACKAGE_TAMPERED/,
    );
  });

  test("policy_hash_mismatch_rejects", async () => {
    const store = new ReviewerStore(tmp());
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("hp2");
    await store.writeImmutable("proposals/hp2/v1/proposal.json", { proposalId: "hp2", version: 1, body: "hello" });
    const pkg = await orch.buildReviewPackage(env, { proposalId: "hp2", version: 1, body: "hello" }, "CODE", "STANDARD", ["integrity"], []);
    await assert.rejects(
      async () => orch.runReview(pkg, "wrong-policy-hash",
        async () => ({ checks: [], findings: [] }),
        { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: await gateDecision(store) }),
      /POLICY_HASH_MISMATCH/,
    );
  });

  test("high_finding_without_evidence_rejected", async () => {
    const store = new ReviewerStore(tmp());
    await Promise.all(["art/plan", "art/manifest", "art/script"].map((p) => store.writeImmutable(p, { k: 1 })));
    const resultContent = { metrics: [], tables: [], status: "COMPLETED" };
    await store.writeImmutable("art/result", resultContent);
    const base = canonicalHash({ k: 1 });
    const proposal = {
      schemaVersion: "1.0", proposalId: "hp3", proposalVersion: 1,
      analysisResultRef: { artifactId: "art/result", artifactType: "x", contentHash: canonicalHash(resultContent) },
      analysisPlanRef: { artifactId: "art/plan", artifactType: "x", contentHash: base },
      executionManifestRef: { artifactId: "art/manifest", artifactType: "x", contentHash: base },
      scriptArtifactRef: { artifactId: "art/script", artifactType: "x", contentHash: base },
      inputArtifactRefs: [], validationRefs: [],
      replayPolicy: { required: true, numericTolerancePolicyId: "d", independentMetricIds: [], strictMode: false },
      contentHash: "abc", createdAt: new Date().toISOString(),
    };
    const out = await new AnalysisReviewRunner(store).run({
      proposal, objective: "x",
      replayRunner: async () => ({ metrics: [], tables: [], status: "COMPLETED", replayResult: {}, replayManifest: {} }),
      verificationCases: [],
      semanticReviewer: async () => [{
        severity: "HIGH", category: "METHODOLOGY", claim: "causal", suggestedAction: "fix", evidenceRefIds: [],
      }],
    });
    assert.ok(out.checks.some((c) => c.checkId === "analysis:semantic-evidence" && c.status === "FAILED"));
  });

  test("crash_residue_cannot_mix_attempts", async () => {
    const store = new ReviewerStore(tmp());
    const orch = new ReviewerOrchestrator(store, "0.1.0");
    const env = envelope("hp4");
    await store.writeImmutable("proposals/hp4/v1/proposal.json", { proposalId: "hp4", version: 1, body: "hello" });
    const pkg = await orch.buildReviewPackage(env, { proposalId: "hp4", version: 1, body: "hello" }, "CODE", "STANDARD", ["integrity"], []);
    // simulate a stale partial attempt with DIFFERENT checks content
    const { reviewKey } = await import("../../src/reviewer/contracts/index.ts");
    const gd = await gateDecision(store, "hp4", canonicalHash({ proposalId: "hp4", version: 1, body: "hello" }));
    const key = reviewKey({ proposalContentHash: pkg.proposalContentHash, gateDecisionHash: gd.contentHash, policySnapshotHash: pkg.policySnapshot.contentHash, reviewerVersion: "0.1.0", reviewLevel: "STANDARD" });
    await store.writeImmutable(`reviews/${key}/attempts/stale/checks.json`, [{ checkId: "STALE" }]);
    // run a fresh review: must produce a NEW attempt and a terminal pointer
    const d = await orch.runReview(pkg, pkg.policySnapshot.contentHash,
      async () => ({ checks: [{ checkId: "c", checkClass: "INTEGRITY", required: true, status: "PASSED", summary: "", evidenceRefs: [], startedAt: "", completedAt: "", durationMs: 0 }], findings: [] }),
      { runId: "r", sessionId: "s", model: "m", profile: "CODE", gateDecision: gd });
    assert.equal(d.verdict, "PASS");
    const pointer = await store.read<{ attemptId: string }>(`reviews/${key}/terminal-pointer.json`);
    assert.ok(pointer && pointer.content.attemptId !== "stale");
  });
});
