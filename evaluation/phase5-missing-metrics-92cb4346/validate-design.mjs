import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const design = JSON.parse(readFileSync(join(root, "scenarios.json"), "utf8"));
const registry = JSON.parse(readFileSync("/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346/registry-probe.json", "utf8"));
const publicTools = new Set(registry.tools.map((tool) => tool.name));
const errors = [];
if (design.cases.length !== 12) errors.push(`expected 12 cases, got ${design.cases.length}`);
if (new Set(design.cases.map((item) => item.caseId)).size !== design.cases.length) errors.push("duplicate case IDs");
for (const scenario of design.cases) {
  if (!scenario.basePrompt || !scenario.perturbedPrompt) errors.push(`${scenario.caseId}: missing prompt`);
  for (const tool of scenario.availableTools) if (!publicTools.has(tool)) errors.push(`${scenario.caseId}: unavailable tool ${tool}`);
  for (const tool of scenario.expectedTools) if (!scenario.availableTools.includes(tool)) errors.push(`${scenario.caseId}: expected tool not available ${tool}`);
  for (const tool of scenario.oracle.forbidTools ?? []) if (!scenario.availableTools.includes(tool)) errors.push(`${scenario.caseId}: forbidden tool not exposed ${tool}`);
}
if (errors.length) {
  console.error(JSON.stringify({ valid: false, errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ valid: true, publicTools: publicTools.size, cases: design.cases.length, runs: design.cases.length * 4 }));
