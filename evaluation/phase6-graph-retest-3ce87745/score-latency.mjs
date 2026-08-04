import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const elapsed = (start, finish) => new Date(finish).getTime() - new Date(start).getTime();
const records = [];

const commands = readFileSync(join(root, "pipeline/command-log.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const pipelineResult = json(join(root, "pipeline/results/abalone.json"));
const pipelineCommands = commands.slice(0, 6);
records.push({
  id: "E2E-PIPE-01", slice: "pipeline",
  status: ["pipeline", "correctness", "idempotency", "qualityDetection", "governanceEnforcement"].every((key) => pipelineResult[key].status === "PASS") ? "PASS" : "FAIL",
  durationMs: elapsed(pipelineCommands[0].startedAt, pipelineCommands.at(-1).finishedAt),
  boundary: "first dry-run command start -> mutation/governance/idempotency scenario terminal",
  evidence: "pipeline/results/abalone.json + pipeline/command-log.jsonl",
});

const mm = json(join(root, "agents/multimodal/metrics.json"));
const mmAttempts = mm.byScenario.flatMap((item) => item.attempts);
const mmFirst = mmAttempts[0];
const mmNext = mmAttempts[1];
records.push({
  id: "E2E-MM-01", slice: "multimodal", status: mmFirst.status,
  durationMs: elapsed(mmFirst.startedAt, mmNext.startedAt),
  boundary: "orchestrator attempt start -> next serial attempt start",
  evidence: "agents/multimodal/metrics.json",
});

const graph = json(join(root, "graph-e2e/result.json"));
const graphCall = graph.toolCalls.find((call) => call.name === "run_analysis_graph");
records.push({
  id: "E2E-GRAPH-01", slice: "graph_formal_delivery",
  status: graph.exitCode === 0 && graphCall?.result?.details?.status === "COMPLETED" ? "PASS" : "FAIL",
  durationMs: graph.durationMs, boundary: "Pi public task start -> final model response",
  evidence: "graph-e2e/result.json + graph-e2e/raw-trace.jsonl",
  terminalStatus: graphCall?.result?.details?.status ?? null,
});

const toolScores = json(join(root, "tool-calling/scores.json"));
const wfScore = toolScores.casesDetail.find((item) => item.caseId === "WF-01");
const wf = json(join(root, "tool-calling/results-normalized/WF-01.json"));
records.push({
  id: "E2E-WF-01", slice: "tool_workflow", status: wfScore?.status ?? "NOT_RUN",
  durationMs: elapsed(wf.startedAt, wf.finishedAt), boundary: "Pi public task start -> final model response",
  evidence: "tool-calling/results-normalized/WF-01.json + tool-calling/scores.json",
});

const daMetricsPath = join(root, "agents/data-analysis/metrics.json");
if (existsSync(daMetricsPath)) {
  const da = json(daMetricsPath);
  const first = da.records[0];
  const second = da.records[1];
  const processRun = json(join(root, "agents/data_analysis-execution.json"));
  records.push({
    id: "E2E-DA-01", slice: "data_analysis", status: first?.status ?? "NOT_RUN",
    durationMs: first && second ? elapsed(first.startedAt, second.startedAt) : elapsed(processRun.startedAt, processRun.finishedAt),
    boundary: "analysis task invocation -> next serial task invocation",
    evidence: "agents/data-analysis/da-01.json + agents/data_analysis-execution.json",
  });
} else {
  records.push({ id: "E2E-DA-01", slice: "data_analysis", status: "NOT_RUN", durationMs: null, evidence: "pending" });
}

const successful = records.filter((item) => item.status === "PASS" && Number.isFinite(item.durationMs));
const sorted = successful.map((item) => item.durationMs).sort((a, b) => a - b);
const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
const p95 = sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null;
const output = {
  schemaVersion: "1.0", commit: "3ce87745f9b1546a10ab7fd015dc543eec8bc7ba",
  metric: "Average Successful End-to-End Task Completion Time",
  status: successful.length > 0 ? "PASS" : "ABSTAIN",
  successfulTasks: successful.length, totalScenarios: records.length,
  meanMs: mean, medianMs: median, p95Ms: p95,
  eligibility: "only full-Oracle PASS scenarios; failed/infra durations excluded",
  records,
};
writeFileSync(join(root, "latency.json"), `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
