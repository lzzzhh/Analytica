import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase5-missing-metrics-92cb4346/score-suite.mjs";
const root = join(import.meta.dirname, "global");
let code = readFileSync(source, "utf8");
code = code.replace("const root = import.meta.dirname;", `const root = ${JSON.stringify(root)};`);
code = code.replace('const design = JSON.parse(readFileSync(join(root, "scenarios.json"), "utf8"));', 'const design = JSON.parse(readFileSync("/Users/zhanhuilin/Documents/Analytica/evaluation/phase5-missing-metrics-92cb4346/scenarios.json", "utf8"));');
code = code.replace('const confirmedRetryRoot = join(root, "confirmed-infra-retries");\nfor (const name of readdirSync(confirmedRetryRoot).filter((item) => item.endsWith(".json"))) {', 'const confirmedRetryRoot = root;\nfor (const name of []) {');
code = code.replace('schemaVersion: "1.0", commit: design.frozenCommit,', 'schemaVersion: "1.0", commit: "3ce87745f9b1546a10ab7fd015dc543eec8bc7ba",');
const temp = "/tmp/phase6-score-global-suite.mjs";
writeFileSync(temp, code);
const run = spawnSync(process.execPath, [temp], { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
rmSync(temp, { force: true });
writeFileSync(join(root, "score-process.json"), `${JSON.stringify({ exitCode: run.status, stdout: run.stdout, stderr: run.stderr }, null, 2)}\n`);
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
if (run.status !== 0) process.exitCode = run.status ?? 1;
