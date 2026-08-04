import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346/run-cases.mjs";
const root = join(import.meta.dirname, "tool-calling");
const worktree = "/tmp/analytica-phase6-3ce87745/checkout";
let code = readFileSync(source, "utf8");
code = code.replace("const root = import.meta.dirname;", `const root = ${JSON.stringify(root)};`);
code = code.replace('const worktree = "/tmp/analytica-tool92.IH2rVI/checkout";', `const worktree = ${JSON.stringify(worktree)};`);
const temp = "/tmp/phase6-run-tool-suite.mjs";
writeFileSync(temp, code);
const run = spawnSync(process.execPath, [temp, ...process.argv.slice(2)], {
  cwd: worktree,
  env: { ...process.env, DESIGN_MANIFEST_SHA256: "9fb3762703b5c4c6b2fb3dfffe3bbd8773e0c5be81d748c3df7131a947483583" },
  encoding: "utf8", timeout: 7_200_000, maxBuffer: 100 * 1024 * 1024,
});
rmSync(temp, { force: true });
writeFileSync(join(root, "run-suite-process.json"), `${JSON.stringify({ exitCode: run.status, signal: run.signal, error: run.error?.message ?? null, stdout: run.stdout, stderr: run.stderr }, null, 2)}\n`);
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
if (run.status !== 0) process.exitCode = run.status ?? 1;
