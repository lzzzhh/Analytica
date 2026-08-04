import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const names = ["scenarios.json", "scoring-contract.json", "run-suite.mjs", "environment.json", "validate-design.mjs"];
const files = names.map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(join(root, name))).digest("hex") }));
const combinedSha256 = createHash("sha256").update(files.map((item) => `${item.name}:${item.sha256}`).join("\n")).digest("hex");
const manifest = {
  schemaVersion: "1.0", state: "FROZEN_FOR_EXECUTION",
  frozenAt: new Date().toISOString(), commit: "92cb4346ac5f0b4edc3eefcdcb81978e570fd220",
  counts: { cases: 12, baselineRuns: 36, perturbationRuns: 12, totalRuns: 48 },
  files, combinedSha256,
};
writeFileSync(join(root, "design-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
