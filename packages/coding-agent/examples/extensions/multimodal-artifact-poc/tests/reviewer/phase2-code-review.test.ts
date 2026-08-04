/**
 * Phase 2 tests — code review (proposal freezing, integrity, deterministic
 * checks, shadow-test manifest, full review flow with reducer).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodeProposal, verifyCodeProposal, ProposalBuildError } from "../../src/reviewer/code/proposal-builder.ts";
import { CodeReviewRunner, runCommand } from "../../src/reviewer/code/review-runner.ts";
import { ReviewerStore } from "../../src/reviewer/store.ts";
import { reduceReviewDecision } from "../../src/reviewer/decision-reducer.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rev2-"));
}

describe("proposal builder", () => {
  test("freezes files with hashes + canonical diff", async () => {
    const { proposal, diff } = await buildCodeProposal({
      proposalId: "pc1", proposalVersion: 1, repositoryId: "r",
      baseCommitSha: "base", frozenFiles: [
        { path: "src/a.ts", status: "MODIFIED", content: "export const a = 1;" },
      ],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    assert.ok(proposal.contentHash.length === 64);
    assert.equal(proposal.changedFiles.length, 1);
    assert.equal(proposal.changedFiles[0]!.path, "src/a.ts");
    assert.ok(diff.includes("src/a.ts"));
  });

  test("path escape rejected", async () => {
    await assert.rejects(
      () => buildCodeProposal({
        proposalId: "p", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
        frozenFiles: [{ path: "../../etc/passwd", status: "MODIFIED", content: "x" }],
        requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
      }),
      ProposalBuildError,
    );
  });

  test("verify detects tampered file hash", () => {
    buildCodeProposal({
      proposalId: "pc2", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "original" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    }).then(({ proposal }) => {
      const v = verifyCodeProposal(proposal, [{ path: "a.ts", content: "TAMPERED" }]);
      assert.ok(v.some((r) => !r.ok));
    });
  });
});

describe("code review runner", () => {
  test("integrity failure + failed exec -> verdict not PASS", async () => {
    const store = new ReviewerStore(tmp());
    const runner = new CodeReviewRunner(store);
    const { proposal } = await buildCodeProposal({
      proposalId: "pc3", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const { snapshotDir } = await buildCodeProposal({
      proposalId: "pc3b", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const out = await runner.run({
      proposal,
      snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
      checkIds: ["typecheck", "targeted-tests"],
      semanticReviewer: async () => [],
    });
    const verdict = reduceReviewDecision({ checks: out.checks, findings: out.findings });
    // fail-closed: shadow capability unavailable keeps this from PASS
    assert.equal(verdict, "ABSTAIN");
    assert.ok(out.checks.some((c) => c.checkId === "exec:shadow-tests" && c.status === "UNAVAILABLE" && c.required));
  });

  test("clean run -> PASS", async () => {
    const store = new ReviewerStore(tmp());
    const runner = new CodeReviewRunner(store);
    const { proposal } = await buildCodeProposal({
      proposalId: "pc4", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const { snapshotDir } = await buildCodeProposal({
      proposalId: "pc4b", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const out = await runner.run({
      proposal, snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
      checkIds: ["typecheck"],
      semanticReviewer: async () => [],
      shadowTestsEnabled: true,
    });
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "PASS");
  });

  test("semantic finding with HIGH severity blocks PASS", async () => {
    const store = new ReviewerStore(tmp());
    const runner = new CodeReviewRunner(store);
    const { proposal } = await buildCodeProposal({
      proposalId: "pc5", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const { snapshotDir } = await buildCodeProposal({
      proposalId: "pc4b", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const out = await runner.run({
      proposal, snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
      checkIds: ["typecheck"],
      semanticReviewer: async () => [{
        severity: "HIGH", category: "SECURITY", claim: "race condition",
        evidenceRefIds: [], suggestedAction: "add a lock",
      }],
      shadowTestsEnabled: true,
    });
    // HIGH without evidence -> semantic:evidence FAILED -> not PASS (and the
    // HIGH finding itself also blocks); ABSTAIN is reserved for UNAVAILABLE
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "CHANGES_REQUIRED");
    assert.ok(out.checks.some((c) => c.checkId === "semantic:evidence" && c.status === "FAILED"));
  });

  test("semantic finding referencing unknown evidence ID fails closed", async () => {
    const store = new ReviewerStore(tmp());
    const runner = new CodeReviewRunner(store);
    const { proposal, snapshotDir } = await buildCodeProposal({
      proposalId: "pc6", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "fix", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const out = await runner.run({
      proposal, snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
      checkIds: ["typecheck"],
      semanticReviewer: async () => [{
        severity: "MEDIUM", category: "SECURITY", claim: "made-up evidence",
        evidenceRefIds: ["e999-not-provided"], suggestedAction: "verify",
      }],
      shadowTestsEnabled: true,
    });
    // the id was never provided in any check's evidenceRefs -> FAILED -> not PASS
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "CHANGES_REQUIRED");
    assert.ok(out.checks.some((c) => c.checkId === "semantic:evidence" && c.status === "FAILED"));
  });
});

describe("runCommand", () => {
  test("exit code surfaced", async () => {
    const ok = await runCommand("node", ["--version"], tmp());
    assert.equal(ok.code, 0);
    const bad = await runCommand("node", ["-e", "process.exit(3)"], tmp());
    assert.equal(bad.code, 3);
  });
});
