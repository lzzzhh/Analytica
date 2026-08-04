import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const oldRoot = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346";
const root = join(import.meta.dirname, "tool-calling");
const worktree = "/tmp/analytica-phase6-3ce87745/checkout";
mkdirSync(root, { recursive: true });

function runTransformed(sourceName, transforms, tempName) {
  let code = readFileSync(join(oldRoot, sourceName), "utf8");
  for (const [from, to] of transforms) code = code.replaceAll(from, to);
  const temp = `/tmp/${tempName}`;
  writeFileSync(temp, code);
  const run = spawnSync(process.execPath, ["--experimental-strip-types", temp], {
    cwd: worktree, env: process.env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
  });
  rmSync(temp, { force: true });
  if (run.status !== 0) throw new Error(`${sourceName} failed: ${run.stderr || run.stdout}`);
  process.stdout.write(run.stdout);
}

if (!existsSync(join(root, "review-fixtures.json"))) {
  runTransformed("setup-review-fixtures.mts", [
    ["/tmp/analytica-tool92.IH2rVI/checkout", worktree],
    ["const evalRoot = import.meta.dirname;", `const evalRoot = ${JSON.stringify(root)};`],
  ], "phase6-setup-review.mts");
}

runTransformed("resolve-scenarios.mjs", [
  ["const root = import.meta.dirname;", `const root = ${JSON.stringify(root)};`],
  ["const sourceDir = join(root, \"scenarios\");", `const sourceDir = ${JSON.stringify(join(oldRoot, "scenarios"))};`],
  ["const strictPath = join(runtime.home, \".pi\", \"artifacts\", \"data-analysis\", \"inputs\", `${review.strictArtifactId}.data`);", "const strictPath = join(runtime.home, \".pi\", \"artifacts\", \"data-analysis\", \"inputs\", review.strictArtifactId, \"data\");"],
], "phase6-resolve-scenarios.mjs");
