import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase3-agent-evaluation";
const worktree = "/tmp/analytica-phase6-3ce87745/checkout";
const out = join(import.meta.dirname, "agents");
mkdirSync(out, { recursive: true });
const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : ["requirement", "multimodal", "data_analysis", "reviewer"];

for (const name of names) {
  const sourcePath = join(sourceRoot, `run_${name}.mts`);
  let code = readFileSync(sourcePath, "utf8");
  code = code.replaceAll('from "../../packages/', `from "${worktree}/packages/`);
  code = code.replace('const root = resolve("evaluation/phase3-agent-evaluation");', `const root = ${JSON.stringify(sourceRoot)};`);
  code = code.replace('const phase2 = resolve("evaluation/phase2-retest/artifacts");', 'const phase2 = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase2-retest/artifacts";');
  code = code.replace(/const outputDir = resolve\(root, "results\/([^\"]+)"\);/, `const outputDir = ${JSON.stringify(join(out, name.replaceAll("_", "-")))};`);
  code = code.replace('const storeDir = resolve(root, "artifacts/data-analysis-store");', `const storeDir = ${JSON.stringify(join(out, "data-analysis-store"))};`);
  code = code.replace('const workspaceDir = resolve(root, "artifacts/data-analysis-workspaces");', `const workspaceDir = ${JSON.stringify(join(out, "data-analysis-workspaces"))};`);
  code = code.replaceAll('modelId: "deepseek-v4-flash"', 'modelId: "gpt-5.6-luna"');
  code = code.replaceAll('provider: "deepseek"', 'provider: "openai"');
  const temp = `/tmp/analytica-phase6-${name}.mts`;
  writeFileSync(temp, code);
  const startedAt = new Date().toISOString();
  const run = spawnSync(process.execPath, ["--experimental-strip-types", temp], {
    cwd: worktree,
    env: {
      ...process.env,
      FEATURE_RUNTIME_PROFILE: "all-enabled",
      ANALYSIS_SUBAGENT_PROVIDER: "openai",
      ANALYSIS_SUBAGENT_MODEL_ID: "gpt-5.6-luna",
      REVIEWER_PROVIDER: "openai",
      REVIEWER_MODEL: "gpt-5.6-luna",
      REVIEWER_CLI_PATH: "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/rpc-entry.js",
    },
    encoding: "utf8",
    timeout: name === "data_analysis" ? 1_800_000 : 600_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  rmSync(temp, { force: true });
  const record = {
    suite: name, startedAt, finishedAt: new Date().toISOString(),
    exitCode: run.status, signal: run.signal, error: run.error?.message ?? null,
    stdout: run.stdout, stderr: run.stderr,
  };
  writeFileSync(join(out, `${name}-execution.json`), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ suite: name, exitCode: run.status, signal: run.signal, stdoutChars: run.stdout?.length ?? 0, stderrTail: run.stderr?.slice(-300) ?? "" })}\n`);
}
