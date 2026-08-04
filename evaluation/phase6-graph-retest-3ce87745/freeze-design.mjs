import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const out = import.meta.dirname;
const commit = "3ce87745f9b1546a10ab7fd015dc543eec8bc7ba";
const inputs = [
  "evaluation/phase2-retest/dataset-candidates.json",
  "evaluation/phase2-retest/run_blind_retest.py",
  "evaluation/phase3-retest-5356473b/scenarios/requirement.json",
  "evaluation/phase3-retest-5356473b/scenarios/multimodal.json",
  "evaluation/phase3-retest-5356473b/scenarios/data-analysis.json",
  "evaluation/phase3-retest-5356473b/scenarios/reviewer.json",
  "evaluation/phase4-tool-calling-92cb4346/resolved-scenarios/single-tool.json",
  "evaluation/phase4-tool-calling-92cb4346/resolved-scenarios/multi-tool.json",
  "evaluation/phase4-tool-calling-92cb4346/resolved-scenarios/workflow.json",
  "evaluation/phase4-tool-calling-92cb4346/scoring-contract.json",
  "evaluation/phase5-missing-metrics-92cb4346/scenarios.json",
  "evaluation/phase5-missing-metrics-92cb4346/scoring-contract.json",
  "packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/graph-engine/tool-runner.ts",
  "packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/graph-engine/adapters/report.ts",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = inputs.map((path) => {
  const bytes = readFileSync(join(repo, path));
  return { path, sha256: hash(bytes), size: bytes.length };
});
const latencyScenarios = [
  {
    id: "E2E-GRAPH-01", slice: "graph_formal_delivery", entry: "run_analysis_graph",
    successOracle: ["status=COMPLETED", "GRAPH_COMPLETED event", "analysis value=450", "review verdict=PASS", "promotion authorization exists", "report ref exists", "deliverable verification exists"],
  },
  {
    id: "E2E-PIPE-01", slice: "pipeline", entry: "pipeline_cli",
    successOracle: ["dry-run success", "all required stages SUCCEEDED", "output table exists", "row/hash/aggregate assertions pass", "governance gate enforced"],
  },
  {
    id: "E2E-DA-01", slice: "data_analysis", entry: "data_analysis_agent",
    successOracle: ["analysis Artifact COMPLETED", "all task assertions pass", "all numeric assertions within frozen tolerance", "no unsupported claims"],
  },
  {
    id: "E2E-MM-01", slice: "multimodal", entry: "document_orchestrator",
    successOracle: ["parse/orchestration returns", "all frozen fields extracted", "no false-positive fields", "no unresolved conflicts"],
  },
  {
    id: "E2E-WF-01", slice: "tool_workflow", entry: "agent_tool_workflow",
    successOracle: ["required workflow tool set used", "dependency order correct", "Artifact refs handed off", "final business assertions pass", "no hard-gate violation"],
  },
];
const metrics = [
  "Task Success Rate", "Consistency@3", "Hallucination Rate", "Correct Abstention Rate", "Robustness Drop", "Worst-Slice Accuracy",
  "Single-Tool Task Success Rate", "Argument Accuracy", "Tool Set F1", "Multi-Tool Task Success Rate", "Workflow Task Success Rate", "Orchestration Accuracy",
  "Route Accuracy", "Constraint Recall", "pass@1", "pass@3", "Structured Extraction F1", "Analysis Task Success Rate", "Numerical Correctness",
  "Pipeline Run Success Rate", "Data Correctness Rate", "Data Quality Defect Detection F1", "Idempotent Rerun Success Rate",
  "High-Severity Defect Recall", "Reviewer False Positive Rate", "Hard-Gate Violation Count / Rate", "Average Successful End-to-End Task Completion Time",
];
const contract = {
  schemaVersion: "1.0", frozenCommit: commit, frozenAt: new Date().toISOString(), state: "FROZEN_BEFORE_EXECUTION",
  metrics, files, latencyScenarios,
  statusVocabulary: ["PASS", "FAIL", "ABSTAIN", "NOT_RUN", "INFRA_ERROR"],
  latency: {
    clock: "monotonic wall clock at public-entry invocation and terminal return",
    eligible: "only scenarios satisfying every successOracle assertion",
    primary: "arithmetic mean milliseconds across eligible successful scenarios",
    secondary: ["median", "p95", "per-slice", "failed-run duration", "infra-run duration"],
    emptySet: "ABSTAIN; never report zero",
  },
  noGoldenMutationAfterFreeze: true,
};
contract.combinedSha256 = hash(Buffer.from(JSON.stringify(contract.files)));
writeFileSync(join(out, "design-manifest.json"), `${JSON.stringify(contract, null, 2)}\n`);
writeFileSync(join(out, "scoring-contract.json"), `${JSON.stringify({
  schemaVersion: "1.0", frozenCommit: commit, metricCount: metrics.length,
  timingEligibility: contract.latency.eligible, timingEmptySet: contract.latency.emptySet,
  evidenceRule: "deterministic scorer over frozen standards and raw traces; semantic judgments require cited evidence; insufficient evidence=ABSTAIN",
  infrastructureRule: "infrastructure failure is INFRA_ERROR/NOT_RUN and excluded from business denominators",
  sourceManifest: relative(repo, join(out, "design-manifest.json")),
}, null, 2)}\n`);
process.stdout.write(`${contract.combinedSha256}\n`);
