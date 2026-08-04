import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346/score-results.mjs";
const root = join(import.meta.dirname, "tool-calling");
let code = readFileSync(source, "utf8");
code = code.replace('const root = path.dirname(new URL(import.meta.url).pathname);', `const root = ${JSON.stringify(root)};`);
code = code.replace(/const resultFailures = \{[\s\S]*?\n\};\n\nconst dependencyCorrect = \{[\s\S]*?\n\};/, "const resultFailures = {};\nconst dependencyCorrect = {};");
code = code.replace(
  "const correctEdges = dependencyCorrect[caseDef.caseId] ?? 0;",
  `const correctEdges = caseDef.requiredDependencies.filter((edge) => {
    const [from, to] = edge.split(" -> ");
    const toIndex = observedNames.indexOf(to);
    if (toIndex < 0) return false;
    const fromIndex = observedNames.indexOf(from);
    return fromIndex < 0 ? true : fromIndex < toIndex;
  }).length;`,
);
code = code.replace("const resultsPass = !resultFailures[caseDef.caseId];", "const resultsPass = observedResult.toolCalls.every((call) => call.isError !== true);");
code = code.replaceAll("92cb4346ac5f0b4edc3eefcdcb81978e570fd220", "3ce87745f9b1546a10ab7fd015dc543eec8bc7ba");
const temp = "/tmp/phase6-score-tool-suite.mjs";
writeFileSync(temp, code);
const run = spawnSync(process.execPath, [temp], { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
rmSync(temp, { force: true });
writeFileSync(join(root, "score-process.json"), `${JSON.stringify({ exitCode: run.status, stdout: run.stdout, stderr: run.stderr }, null, 2)}\n`);
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
if (run.status !== 0) process.exitCode = run.status ?? 1;
