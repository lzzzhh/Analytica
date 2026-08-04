import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase5-missing-metrics-92cb4346/run-suite.mjs";
const root = join(import.meta.dirname, "global");
const worktree = "/tmp/analytica-phase6-3ce87745/checkout";
const toolRoot = join(import.meta.dirname, "tool-calling");
mkdirSync(root, { recursive: true });
let code = readFileSync(source, "utf8");
code = code.replace("const root = import.meta.dirname;", `const root = ${JSON.stringify(root)};`);
code = code.replace('const phase4 = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346";', `const phase4 = ${JSON.stringify(toolRoot)};`);
code = code.replace('const design = JSON.parse(readFileSync(join(root, "scenarios.json"), "utf8"));', 'const design = JSON.parse(readFileSync("/Users/zhanhuilin/Documents/Analytica/evaluation/phase5-missing-metrics-92cb4346/scenarios.json", "utf8"));');
code = code.replaceAll('http://127.0.0.1:18102', 'http://127.0.0.1:18101');
const temp = "/tmp/phase6-run-global-suite.mjs";
writeFileSync(temp, code);
const run = spawnSync(process.execPath, [temp, ...process.argv.slice(2)], {
  cwd: worktree,
  env: { ...process.env, EVAL_WORKTREE: worktree },
  encoding: "utf8", timeout: 10_800_000, maxBuffer: 150 * 1024 * 1024,
});
rmSync(temp, { force: true });
writeFileSync(join(root, "run-suite-process.json"), `${JSON.stringify({ exitCode: run.status, signal: run.signal, error: run.error?.message ?? null, stdout: run.stdout, stderr: run.stderr }, null, 2)}\n`);
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
if (run.status !== 0) process.exitCode = run.status ?? 1;
