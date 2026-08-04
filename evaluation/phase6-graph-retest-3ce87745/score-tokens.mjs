import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const toolScores = json(join(root, "tool-calling/scores.json"));
const globalScores = json(join(root, "global/scores.json"));
const statusById = new Map([
  ...toolScores.casesDetail.map((item) => [item.caseId, item.status]),
  ...globalScores.runs.map((item) => [item.runId, item.status]),
  ["E2E-GRAPH-01", "FAIL"],
]);

function usageForTrace(path) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, assistantTurns: 0 };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const usage = event.type === "message_end" && event.message?.role === "assistant" ? event.message.usage : null;
    if (!usage || !Number.isFinite(usage.totalTokens) || usage.totalTokens <= 0) continue;
    total.input += usage.input ?? 0;
    total.output += usage.output ?? 0;
    total.cacheRead += usage.cacheRead ?? 0;
    total.cacheWrite += usage.cacheWrite ?? 0;
    total.reasoning += usage.reasoning ?? 0;
    total.totalTokens += usage.totalTokens;
    total.cost += usage.cost?.total ?? 0;
    total.assistantTurns++;
  }
  return total;
}

const tasks = [];
for (const name of readdirSync(join(root, "tool-calling/raw-traces")).filter((name) => name.endsWith(".jsonl"))) {
  const id = name.replace(/\.jsonl$/, "");
  const layer = toolScores.casesDetail.find((item) => item.caseId === id)?.layer ?? "tool";
  tasks.push({ id, suite: "tool_calling", slice: layer, status: statusById.get(id) ?? "NOT_RUN", usage: usageForTrace(join(root, "tool-calling/raw-traces", name)) });
}
for (const name of readdirSync(join(root, "global/raw-traces")).filter((name) => name.endsWith(".jsonl"))) {
  const id = name.replace(/\.jsonl$/, "");
  const slice = globalScores.runs.find((item) => item.runId === id)?.slice ?? "global";
  tasks.push({ id, suite: "global", slice, status: statusById.get(id) ?? "NOT_RUN", usage: usageForTrace(join(root, "global/raw-traces", name)) });
}
tasks.push({ id: "E2E-GRAPH-01", suite: "graph", slice: "graph_formal_delivery", status: "FAIL", usage: usageForTrace(join(root, "graph-e2e/raw-trace.jsonl")) });

function aggregate(items) {
  const observed = items.filter((item) => item.usage.assistantTurns > 0);
  const keys = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "cost"];
  const mean = Object.fromEntries(keys.map((key) => [key, observed.length ? observed.reduce((sum, item) => sum + item.usage[key], 0) / observed.length : null]));
  const totals = observed.map((item) => item.usage.totalTokens).sort((a, b) => a - b);
  const percentile = (p) => totals.length ? totals[Math.ceil(totals.length * p) - 1] : null;
  return { tasks: observed.length, mean, medianTotalTokens: percentile(0.5), p95TotalTokens: percentile(0.95) };
}

const suites = Object.fromEntries([...new Set(tasks.map((item) => item.suite))].map((suite) => [suite, aggregate(tasks.filter((item) => item.suite === suite))]));
const slices = Object.fromEntries([...new Set(tasks.map((item) => item.slice))].map((slice) => [slice, aggregate(tasks.filter((item) => item.slice === slice))]));
const output = {
  schemaVersion: "1.0", commit: "3ce87745f9b1546a10ab7fd015dc543eec8bc7ba",
  metric: "Average Observable Task Token Usage", requestedPostFreeze: true,
  status: tasks.some((item) => item.usage.assistantTurns > 0) ? "PASS" : "ABSTAIN",
  scope: "parent Pi assistant turns visible in accepted raw traces",
  limitation: "internal Data Analysis and Reviewer subagent usage is not emitted into parent traces; full-system end-to-end average token usage is ABSTAIN",
  allObservableTasks: aggregate(tasks), successfulObservableTasks: aggregate(tasks.filter((item) => item.status === "PASS")),
  suites, slices, tasks,
};
writeFileSync(join(root, "token-usage.json"), `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ all: output.allObservableTasks, successful: output.successfulObservableTasks, suites }, null, 2)}\n`);
