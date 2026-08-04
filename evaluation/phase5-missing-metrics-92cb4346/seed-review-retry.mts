import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "/tmp/analytica-missing92.F3lbx1/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/data-analysis/artifact-store.ts";

const retryRoot = process.argv[2];
if (!retryRoot) throw new Error("retry root required");
const artifactRoot = join(retryRoot, "home", ".pi", "artifacts", "data-analysis");
const reviewerRoot = join(retryRoot, "reviewer-store");
mkdirSync(reviewerRoot, { recursive: true });
const store = new ArtifactStore(artifactRoot);
const source = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346/runtime/home/.pi/artifacts/data-analysis/inputs/art_1111222233334444.data";
const bytes = readFileSync(source);
store.register({
  artifactId: "art_1111222233334444", contentType: "application/json",
  contentHash: createHash("sha256").update(bytes).digest("hex"), masked: false,
  createdAt: "2026-08-03T00:00:00.000Z",
}, bytes);
process.stdout.write(JSON.stringify({ artifactRoot, reviewerRoot }));
