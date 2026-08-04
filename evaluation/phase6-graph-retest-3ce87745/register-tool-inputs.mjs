import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "/tmp/analytica-phase6-3ce87745/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/data-analysis/artifact-store.ts";

const oldInputs = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346/runtime/home/.pi/artifacts/data-analysis/inputs";
const target = new ArtifactStore(join(import.meta.dirname, "tool-calling/runtime/home/.pi/artifacts/data-analysis"));
for (const id of ["art_428bd8df7313b159", "art_df49e914acd72504"]) {
  if (target.readInputBytes(id)) continue;
  const meta = JSON.parse(readFileSync(join(oldInputs, `${id}.json`), "utf8"));
  const bytes = readFileSync(join(oldInputs, `${id}.data`));
  target.register(meta, bytes);
  process.stdout.write(`${id}\n`);
}
