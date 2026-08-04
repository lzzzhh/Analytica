import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "/tmp/analytica-tool92.IH2rVI/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/data-analysis/artifact-store.ts";
import { canonicalHash, ReviewerStore } from "/tmp/analytica-tool92.IH2rVI/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/reviewer/store.ts";

const evalRoot = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(evalRoot, "runtime-manifest.json"), "utf8")) as { home: string };
const artifactRoot = join(manifest.home, ".pi", "artifacts", "data-analysis");
const reviewerRoot = join(evalRoot, "runtime", "reviewer-store");
const store = new ArtifactStore(artifactRoot);
const reviewer = new ReviewerStore(reviewerRoot);

const resultArtifact = {
  schemaVersion: "1.0", artifactId: "art_1111222233334444", runId: "run_strict_fixture",
  status: "COMPLETED", title: "strict review fixture",
  sections: [{ type: "METRIC_CARDS", id: "metrics", metrics: [{ metricId: "m1", label: "Metric", value: 10, valueType: "NUMBER" }] }],
  reviewStatus: "NOT_REVIEWED", validationRefs: [], createdAt: "2026-08-03T00:00:00.000Z",
};
const resultBytes = JSON.stringify(resultArtifact);
store.register({
  artifactId: resultArtifact.artifactId, contentType: "application/json",
  contentHash: createHash("sha256").update(resultBytes).digest("hex"), masked: false,
  createdAt: "2026-08-03T00:00:00.000Z",
}, resultBytes);

const noneGateBody = {
  schemaVersion: "1.0", gateDecisionId: "none_tool_eval", stage: "FINAL",
  subjectType: "ANALYSIS_PROPOSAL", subjectId: "analysis-none", subjectContentHash: "a".repeat(64),
  profile: "ANALYSIS", reviewMode: "NONE",
  scores: { impact: 0, reversibility: 0, complexity: 0, uncertainty: 0, autonomy: 0, total: 0 },
  triggers: [], triggerSources: [], deliveryMode: "EXPLORATORY_UNREVIEWED",
  restrictions: ["NO_MERGE", "NO_EXTERNAL_PUBLICATION", "NO_PRODUCTION_WRITE", "NO_FORMAL_REPORT", "NO_GOVERNANCE_APPROVAL"],
  requiredChecks: [], budget: { maxInputTokens: 0, maxSemanticCalls: 0, maxFiles: 0, maxDiffLines: 0 },
  policyVersion: "1.0.0", createdAt: "2026-08-03T00:00:00.000Z",
};
const noneGate = { ...noneGateBody, contentHash: canonicalHash(noneGateBody) };
await reviewer.writeImmutable("gate/none_tool_eval.json", noneGate);

async function seedDecision(key: string, attemptId: string, reviewId: string, verdict: string, terminal: boolean): Promise<void> {
  const decision = {
    schemaVersion: "1.0", reviewId, reviewAttempt: 1, reviewPackageId: `pkg_${key}`,
    reviewPackageContentHash: "b".repeat(64), proposalId: `proposal_${key}`, proposalVersion: 1,
    proposalContentHash: "c".repeat(64), reviewMode: verdict === "UNREVIEWED_LOW_RISK" ? "NONE" : "STANDARD",
    gateDecisionRef: { artifactId: "gate/none_tool_eval.json", contentHash: noneGate.contentHash },
    reviewer: { profile: "ANALYSIS", runId: `run_${key}`, sessionId: "fixture", model: "deterministic", reviewerVersion: "1.0.0" },
    verdict, blockingFindings: [], advisoryFindings: [], deterministicChecks: [], executionChecks: [], semanticChecks: [],
    policySnapshotHash: "d".repeat(64), confidence: 1, createdAt: "2026-08-03T00:00:00.000Z",
  };
  await reviewer.writeImmutable(`reviews/${key}/attempts/${attemptId}/decision.json`, decision);
  if (terminal) {
    await reviewer.writeImmutable(`reviews/${key}/terminal-pointer.json`, {
      attemptId, decisionId: reviewId, verdict, at: "2026-08-03T00:00:00.000Z",
    });
  }
}

await seedDecision("nonekey", "attemptnone", "review_none_eval", "UNREVIEWED_LOW_RISK", true);
await seedDecision("abstainkey", "attemptabstain", "review_abstain_eval", "ABSTAIN", false);

mkdirSync(join(evalRoot, "runtime"), { recursive: true });
writeFileSync(join(evalRoot, "review-fixtures.json"), JSON.stringify({
  reviewerRoot, strictArtifactId: resultArtifact.artifactId,
  noneGateDecisionId: "none_tool_eval", noneReviewId: "review_none_eval",
  abstainReviewId: "review_abstain_eval",
}, null, 2) + "\n");
process.stdout.write(JSON.stringify({ reviewerRoot, strictArtifactId: resultArtifact.artifactId }) + "\n");
