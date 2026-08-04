import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const registry = readJson("registry-probe.json");
const scenarioFiles = ["scenarios/single-tool.json", "scenarios/multi-tool.json", "scenarios/workflow.json"];
const required = [
  "caseId", "layer", "userTask", "businessScenario", "availableTools",
  "requiredCapabilities", "acceptableToolSets", "forbiddenTools", "inputArtifacts",
  "expectedArguments", "requiredDependencies", "expectedResultAssertions",
  "expectedFailureBehavior", "oracle",
];
const publicTools = new Set(registry.tools.map((tool) => tool.name));
const ids = new Set();
let count = 0;

if (registry.toolCount !== registry.tools.length) {
  throw new Error("toolCount does not equal tools.length");
}

for (const file of scenarioFiles) {
  const suite = readJson(file);
  if (suite.cases.length < 10) throw new Error(`${file}: fewer than 10 cases`);
  for (const scenario of suite.cases) {
    count += 1;
    if (ids.has(scenario.caseId)) throw new Error(`duplicate caseId ${scenario.caseId}`);
    ids.add(scenario.caseId);
    for (const field of required) {
      if (!(field in scenario)) throw new Error(`${scenario.caseId}: missing ${field}`);
    }
    for (const tool of scenario.availableTools) {
      if (!publicTools.has(tool)) throw new Error(`${scenario.caseId}: unavailable public tool ${tool}`);
    }
    for (const acceptable of scenario.acceptableToolSets) {
      for (const tool of acceptable) {
        if (!scenario.availableTools.includes(tool)) {
          throw new Error(`${scenario.caseId}: acceptable tool ${tool} not in availableTools`);
        }
      }
    }
  }
}

if (count < 30) throw new Error(`only ${count} total cases`);
process.stdout.write(JSON.stringify({ valid: true, publicTools: publicTools.size, cases: count, caseIds: [...ids] }) + "\n");
