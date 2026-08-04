import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = import.meta.dirname;
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const paths = [
  "environment.json", "registry-probe.json", "scoring-contract.json", "validate-design.mjs",
  "run-cases.mjs", "resolve-scenarios.mjs", "capture-environment.mjs",
  "scenarios/single-tool.json", "scenarios/multi-tool.json", "scenarios/workflow.json",
  "resolved-scenarios/single-tool.json", "resolved-scenarios/multi-tool.json", "resolved-scenarios/workflow.json",
  "runtime-manifest.json", "review-fixtures.json", "setup-runtime.py", "setup-review-fixtures.mts",
  "runtime/bar-chart.png", "runtime/pipeline-source.csv", "runtime/approved-contract.json", "runtime/unapproved-contract.json",
];
const files = paths.map((item) => ({ path: item, sha256: sha256(join(root, item)) }));
const manifest = {
  schemaVersion: "1.0", state: "FROZEN_FOR_EXECUTION", executionStarted: false,
  repositoryCommitSha: "92cb4346ac5f0b4edc3eefcdcb81978e570fd220",
  frozenAt: new Date().toISOString(),
  counts: { publicTools: 22, singleToolCases: 12, multiToolCases: 12, workflowCases: 12, totalCases: 36 },
  files,
};
writeFileSync(join(root, "design-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(JSON.stringify({ frozen: files.length, cases: 36 }) + "\n");
