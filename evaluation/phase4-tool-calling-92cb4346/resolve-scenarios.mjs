import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = import.meta.dirname;
const runtime = JSON.parse(readFileSync(join(root, "runtime-manifest.json"), "utf8"));
const review = JSON.parse(readFileSync(join(root, "review-fixtures.json"), "utf8"));
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const strictPath = join(runtime.home, ".pi", "artifacts", "data-analysis", "inputs", `${review.strictArtifactId}.data`);
const noneGatePath = join(review.reviewerRoot, "gate", `${review.noneGateDecisionId}.json`);
const noneDecisionPath = join(review.reviewerRoot, "reviews", "nonekey", "attempts", "attemptnone", "decision.json");
const abstainDecisionPath = join(review.reviewerRoot, "reviews", "abstainkey", "attempts", "attemptabstain", "decision.json");
const gatewayCatalog = join(runtime.gatewayWarehouse, ".lakehouse-catalog.db");

const replacements = new Map([
  ["fixtures/tool-eval/bar-chart.png", runtime.chart.path],
  ["TO_BE_FROZEN_DURING_PREFLIGHT", runtime.chart.sha256],
  ["$APPROVED_GOV_ROOT", runtime.pipeline.approvedGovernanceRoot],
  ["$APPROVED_CONTRACT", runtime.pipeline.approvedContract],
  ["$UNAPPROVED_GOV_ROOT", runtime.pipeline.unapprovedGovernanceRoot],
  ["$UNAPPROVED_CONTRACT", runtime.pipeline.unapprovedContract],
  ["$EVAL_WAREHOUSE", runtime.pipeline.pipelineWarehouse],
  ["$STRICT_ARTIFACT", review.strictArtifactId],
  ["$NONE_GATE", review.noneGateDecisionId],
  ["$NONE_REVIEW", review.noneReviewId],
  ["$ABSTAIN_REVIEW", review.abstainReviewId],
  ["$DQ_FAIL_DATASET", "dws.dws_quality_fail"],
  ["$VQ_DQ_FAIL", "vq_frozen_not_executed"],
]);
const hashReplacements = {
  "MT-12": runtime.hashes.approvedContract,
  "WF-05": hashFile(strictPath),
  "WF-06": createHash("sha256").update(hashFile(noneGatePath) + hashFile(noneDecisionPath)).digest("hex"),
  "WF-09": hashFile(abstainDecisionPath),
  "WF-10": hashFile(gatewayCatalog),
  "WF-12": runtime.hashes.unapprovedContract,
};

function resolveValue(value, caseId) {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, caseId));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, caseId)]));
  }
  if (typeof value !== "string") return value;
  let out = value;
  for (const [needle, replacement] of replacements) out = out.replaceAll(needle, replacement);
  if (out === "FROZEN_BY_PREFLIGHT") return hashReplacements[caseId] ?? out;
  return out;
}

const sourceDir = join(root, "scenarios");
const outputDir = join(root, "resolved-scenarios");
mkdirSync(outputDir, { recursive: true });
for (const name of ["single-tool.json", "multi-tool.json", "workflow.json"]) {
  const suite = JSON.parse(readFileSync(join(sourceDir, name), "utf8"));
  suite.cases = suite.cases.map((scenario) => resolveValue(scenario, scenario.caseId));
  writeFileSync(join(outputDir, basename(name)), JSON.stringify(suite, null, 2) + "\n");
}
process.stdout.write(JSON.stringify({ resolved: 36, outputDir }) + "\n");
