/**
 * Commit 2 tests — Pi RPC semantic reviewer.
 *
 * - strict JSON/schema parsing (invalid severity, missing action,
 *   HIGH without evidence -> SemanticReviewError)
 * - prompt-injection guard text present in the system prompt
 * - failure paths: caller throwing -> semantic check UNAVAILABLE -> ABSTAIN
 * - real-model smoke (optional, guarded by REVIEWER_SMOKE=1)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerStore, canonicalHash } from "../../src/reviewer/store.ts";
import { AnalysisReviewRunner } from "../../src/reviewer/analysis/review-runner.ts";
import { CodeReviewRunner } from "../../src/reviewer/code/review-runner.ts";
import { reduceReviewDecision } from "../../src/reviewer/decision-reducer.ts";
import { buildCodeProposal } from "../../src/reviewer/code/proposal-builder.ts";
import {
  parseSemanticResponse,
  REVIEWER_SYSTEM_PROMPT,
  SemanticReviewError,
} from "../../src/reviewer/adapters/pi-reviewer.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rev-rpc-"));
}

describe("semantic response parsing", () => {
  test("valid findings parsed", () => {
    const out = parseSemanticResponse(JSON.stringify({
      findings: [
        { severity: "HIGH", category: "SECURITY", claim: "race", evidenceRefIds: ["e1"], suggestedAction: "lock it", location: { file: "a.ts" } },
        { severity: "LOW", category: "STYLE", claim: "nit", evidenceRefIds: [], suggestedAction: "rename" },
      ],
    }));
    assert.equal(out.length, 2);
    assert.equal(out[0]!.severity, "HIGH");
    assert.deepEqual(out[0]!.evidenceRefIds, ["e1"]);
  });

  test("invalid severity rejected", () => {
    assert.throws(
      () => parseSemanticResponse(JSON.stringify({ findings: [{ severity: "APPROVE", claim: "x", suggestedAction: "y" }] })),
      SemanticReviewError,
    );
  });

  test("HIGH without evidence rejected", () => {
    assert.throws(
      () => parseSemanticResponse(JSON.stringify({ findings: [{ severity: "HIGH", claim: "x", suggestedAction: "y", evidenceRefIds: [] }] })),
      SemanticReviewError,
    );
  });

  test("missing suggestedAction rejected", () => {
    assert.throws(
      () => parseSemanticResponse(JSON.stringify({ findings: [{ severity: "LOW", claim: "x", evidenceRefIds: [] }] })),
      SemanticReviewError,
    );
  });

  test("not an object rejected", () => {
    assert.throws(() => parseSemanticResponse("[]"), SemanticReviewError);
  });

  test("injection guard present in system prompt", () => {
    assert.ok(REVIEWER_SYSTEM_PROMPT.includes("untrusted"));
    assert.ok(REVIEWER_SYSTEM_PROMPT.includes("Never emit a review verdict"));
    assert.ok(REVIEWER_SYSTEM_PROMPT.includes("evidenceRefId"));
  });
});

describe("failure paths fail closed", () => {
  test("code semantic reviewer throwing -> ABSTAIN", async () => {
    const store = new ReviewerStore(tmp());
    const runner = new CodeReviewRunner(store);
    const { proposal, snapshotDir } = await buildCodeProposal({
      proposalId: "f1", proposalVersion: 1, repositoryId: "r", baseCommitSha: "b",
      frozenFiles: [{ path: "a.ts", status: "MODIFIED", content: "x" }],
      requirementRefs: [], workspaceRoot: tmp(),
      proposerSummary: { objective: "x", implementationSummary: "x", knownLimitations: [], unverifiedAssumptions: [] },
    });
    const out = await runner.run({
      proposal, snapshotWorkspace: snapshotDir, testWorkspace: tmp(),
      checkIds: [],
      semanticReviewer: async () => { throw new Error("model down"); },
    });
    assert.ok(out.checks.some((c) => c.checkId === "semantic:llm" && c.status === "UNAVAILABLE"));
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "ABSTAIN");
  });

  test("analysis semantic reviewer throwing -> ABSTAIN", async () => {
    const store = new ReviewerStore(tmp());
    await Promise.all(["art/plan", "art/manifest", "art/script"].map((p) => store.writeImmutable(p, { k: 1 })));
    const resultContent = { metrics: [], tables: [], status: "COMPLETED" };
    await store.writeImmutable("art/result", resultContent);
    const base = canonicalHash({ k: 1 });
    const proposal = {
      schemaVersion: "1.0", proposalId: "f2", proposalVersion: 1,
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
      semanticReviewer: async () => { throw new Error("timeout"); },
    });
    assert.ok(out.checks.some((c) => c.checkId === "analysis:semantic" && c.status === "UNAVAILABLE"));
    assert.equal(reduceReviewDecision({ checks: out.checks, findings: out.findings }), "ABSTAIN");
  });
});

describe("real-model smoke (REVIEWER_SMOKE=1 only; never runs in CI)", () => {
  test("gpt-5.6-luna returns structured findings", { skip: process.env.REVIEWER_SMOKE !== "1" }, async () => {
    const { createPiSemanticReviewer } = await import("../../src/reviewer/adapters/pi-reviewer.ts");
    const reviewer = createPiSemanticReviewer({ timeoutMs: 120_000 });
    const out = await reviewer({
      objective: "review a cache change",
      diff: "+ const cache = new Map();",
      fileContext: "src/cache.ts",
      testSummary: "exec:typecheck PASSED",
      staticSummary: "",
    });
    assert.ok(Array.isArray(out), "structured findings array");
    for (const f of out) {
      assert.ok(["BLOCKER", "HIGH", "MEDIUM", "LOW"].includes(f.severity));
      assert.ok(f.claim.length > 0);
    }
  });
});

describe("semantic context formatting (object input)", () => {
  test("run formats the context object, not [object Object]", async () => {
    const { writeFileSync } = await import("node:fs");
    const { createPiSemanticReviewer } = await import("../../src/reviewer/adapters/pi-reviewer.ts");
    const fakeDir = tmp();
    const capturedFile = join(fakeDir, "captured.txt");
    const fakeCli = join(fakeDir, "fake-cli.mjs");
    writeFileSync(fakeCli, `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let buf = "";
process.stdin.on("data", (c) => {
  buf += String(c);
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try {
      const ev = JSON.parse(line);
      if (ev.type === "prompt") {
        writeFileSync(${JSON.stringify(capturedFile)}, ev.message);
        process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: JSON.stringify({ findings: [] }) } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      }
    } catch {}
  }
});
`);
    const reviewer = createPiSemanticReviewer({ cliPath: fakeCli });
    await reviewer({
      objective: "add a cache",
      diff: "+ const cache = new Map();",
      fileContext: "src/cache.ts",
      testSummary: "exec:typecheck PASSED",
      staticSummary: "",
    }, ["e1"]);
    const { readFileSync } = await import("node:fs");
    const captured = readFileSync(capturedFile, "utf8");
    assert.ok(captured.includes("OBJECTIVE: add a cache"), "objective formatted");
    assert.ok(captured.includes("+ const cache = new Map();"), "diff formatted");
    assert.ok(!captured.includes("[object Object]"), "no object stringification");
  });
});
