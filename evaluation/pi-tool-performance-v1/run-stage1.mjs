import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, "../..");
const cli = join(repo, "packages/coding-agent/dist/cli.js");
const extension = join(root, "mock-extension.ts");
const registryPath = join(root, "registry.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const contract = JSON.parse(readFileSync(join(root, "experiment-contract.json"), "utf8"));
const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8")).cases;
const output = join(root, "stage1");
const rawDir = join(output, "raw-traces");
const resultsPath = join(output, "results.jsonl");
mkdirSync(rawDir, { recursive: true });

const clusters = {
  query: ["validate_query", "execute_query", "materialize_query", "get_snapshot"],
  data_understanding: ["inspect_dataset", "get_data_quality", "get_snapshot", "explain_lineage", "search_catalog"],
  review_delivery: ["review_data_analysis", "promote_analysis", "run_data_analysis"],
  discovery: ["search_catalog", "inspect_dataset", "get_data_quality", "get_snapshot"],
  analysis: ["run_data_analysis", "execute_query", "materialize_query", "review_data_analysis"],
  governance: ["pipeline_ingest", "materialize_query", "promote_analysis", "validate_query"],
};

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function randomFrom(seedText) {
  let state = Number.parseInt(hash(seedText).slice(0, 8), 16) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, seedText) {
  const out = [...values];
  const random = randomFrom(seedText);
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

function visibleTools(task, condition, repetition) {
  const expected = task.expectedNextTools[0];
  const full = registry.tools.map((tool) => tool.name);
  const cluster = clusters[task.cluster] ?? [expected];
  let selected;
  if (condition === "A_UNIQUE") selected = [expected];
  else if (condition === "B_SIMILAR") selected = [...new Set([expected, ...cluster])];
  else if (condition === "C_IRRELEVANT_16") {
    const irrelevant = full.filter((name) => name !== expected && !cluster.includes(name));
    const fallback = full.filter((name) => name !== expected && !irrelevant.includes(name));
    selected = [expected, ...irrelevant, ...fallback].slice(0, 16);
  } else if (condition === "D_FULL") selected = full;
  else throw new Error(`unknown condition ${condition}`);
  return shuffle(selected, `${contract.randomSeedNamespace}:${task.taskId}:${condition}:${repetition}`);
}

function requiredSubset(actual, expected) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((value, index) => requiredSubset(actual[index], value));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) => requiredSubset(actual[key], value));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function parseObserved(lines) {
  const events = lines.map((line) => line.event).filter(Boolean);
  const llmStart = lines.find((line) => line.event?.type === "message_start" && line.event.message?.role === "assistant");
  const firstToken = lines.find((line) => line.event?.type === "message_update" && line.event.assistantMessageEvent);
  const toolStart = lines.find((line) => line.event?.type === "tool_execution_start");
  const toolEnd = toolStart
    ? lines.find((line) => line.event?.type === "tool_execution_end" && line.event.toolCallId === toolStart.event.toolCallId)
    : null;
  const finalMessage = [...events].reverse().find((event) => event.type === "message_end" && event.message?.role === "assistant");
  return {
    llmStartNs: llmStart?.observedAtNs ?? null,
    firstTokenNs: firstToken?.observedAtNs ?? null,
    toolCallNs: toolStart?.observedAtNs ?? null,
    toolEndNs: toolEnd?.observedAtNs ?? null,
    selectedTool: toolStart?.event.toolName ?? null,
    args: toolStart?.event.args ?? null,
    toolError: toolEnd?.event.isError ?? null,
    finalText: assistantText(finalMessage?.message),
    usage: finalMessage?.message?.usage ?? null,
    eventCount: events.length,
  };
}

function durationMs(startNs, endNs) {
  if (!startNs || !endNs) return null;
  return Number(BigInt(endNs) - BigInt(startNs)) / 1e6;
}

function runOne(run) {
  return new Promise((resolveRun) => {
    const rawPath = join(rawDir, `${run.runId}.jsonl`);
    const prompt = [
      `当前 Graph 节点：${run.task.graphNodeId}`,
      `节点目标：${run.task.userIntent}`,
      "只调用完成当前下一步所需的一个工具并生成参数。不要解释，不要调用第二个工具；工具返回后立即结束。",
    ].join("\n");
    const toolDefinitions = run.visibleTools.map((name) => registry.tools.find((tool) => tool.name === name));
    const args = [
      cli,
      "--mode", "json",
      "--no-session",
      "--approve",
      "--model", contract.model,
      "--thinking", contract.reasoningEffort,
      "--no-extensions",
      "--extension", extension,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--tools", run.visibleTools.join(","),
      prompt,
    ];
    const startedAt = new Date().toISOString();
    const processStartNs = process.hrtime.bigint();
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env: {
        ...process.env,
        PI_PERF_REGISTRY: registryPath,
        PI_PERF_VISIBLE_TOOLS: run.visibleTools.join(","),
        PI_PERF_MOCK_CONFIG: JSON.stringify({ stage: "stage1" }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    const observed = [];
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!text) continue;
        try {
          observed.push({ observedAtNs: process.hrtime.bigint().toString(), event: JSON.parse(text) });
        } catch {
          observed.push({ observedAtNs: process.hrtime.bigint().toString(), nonJson: text });
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, contract.stage1.timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const processEndNs = process.hrtime.bigint();
      writeFileSync(rawPath, observed.map((line) => JSON.stringify(line)).join("\n") + "\n");
      const parsed = parseObserved(observed);
      const firstCorrect = run.task.expectedNextTools.includes(parsed.selectedTool)
        || run.task.acceptableAlternatives.includes(parsed.selectedTool);
      const argsPass = firstCorrect && requiredSubset(parsed.args, run.task.requiredArgs);
      let status = "COMPLETED";
      if (timedOut) status = "TIMEOUT";
      else if (exitCode !== 0 || !parsed.selectedTool) status = /rate|provider|api|network|429|5\d\d/i.test(stderr)
        ? "PROVIDER_ERROR"
        : "INFRA_ERROR";
      const result = {
        experimentRunId: run.runId,
        stage: "stage1",
        taskId: run.task.taskId,
        conditionId: run.condition,
        repetition: run.repetition,
        graphNodeId: run.task.graphNodeId,
        model: contract.model,
        reasoningEffort: contract.reasoningEffort,
        visibleToolIds: run.visibleTools,
        toolCatalogHash: hash(toolDefinitions),
        promptHash: hash(prompt),
        expectedTools: run.task.expectedNextTools,
        acceptableAlternatives: run.task.acceptableAlternatives,
        selectedTool: parsed.selectedTool,
        args: parsed.args,
        firstToolCorrect: firstCorrect,
        argsPass,
        errorLabel: firstCorrect ? (argsPass ? null : "INVALID_ARGS") : "WRONG_TOOL",
        timestamps: {
          startedAt,
          finishedAt: new Date().toISOString(),
          processStartNs: processStartNs.toString(),
          llmRequestStartedNs: parsed.llmStartNs,
          llmFirstTokenNs: parsed.firstTokenNs,
          toolCallEmittedNs: parsed.toolCallNs,
          toolExecEndedNs: parsed.toolEndNs,
          processEndNs: processEndNs.toString(),
        },
        durationsMs: {
          processTotal: durationMs(processStartNs.toString(), processEndNs.toString()),
          requestToFirstToken: durationMs(parsed.llmStartNs, parsed.firstTokenNs),
          toolDecision: durationMs(parsed.llmStartNs, parsed.toolCallNs),
          toolExecution: durationMs(parsed.toolCallNs, parsed.toolEndNs),
        },
        usage: parsed.usage,
        outcome: status,
        exitCode,
        signal,
        eventCount: parsed.eventCount,
        rawTrace: `raw-traces/${run.runId}.jsonl`,
        stderrTail: stderr.slice(-2000),
      };
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
      process.stdout.write(`${JSON.stringify({ runId: run.runId, status, selectedTool: parsed.selectedTool, firstCorrect, argsPass, decisionMs: result.durationsMs.toolDecision })}\n`);
      resolveRun(result);
    });
  });
}

const completed = new Set();
if (existsSync(resultsPath)) {
  for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    completed.add(JSON.parse(line).experimentRunId);
  }
}

const requested = process.argv.slice(2);
const pilot = requested.includes("--pilot");
const runs = [];
for (const task of tasks) {
  for (const condition of contract.stage1.conditions) {
    for (let repetition = 1; repetition <= contract.stage1.repetitions; repetition += 1) {
      const runId = `s1_${task.taskId}_${condition}_r${repetition}`.replaceAll(/[^A-Za-z0-9_-]/g, "_");
      if (!completed.has(runId)) {
        runs.push({ runId, task, condition, repetition, visibleTools: visibleTools(task, condition, repetition) });
      }
    }
  }
}

const selectedRuns = pilot ? runs.slice(0, 1) : runs;
process.stdout.write(`${JSON.stringify({ stage: "stage1", pending: selectedRuns.length, totalExpected: 240, pilot })}\n`);
for (const run of selectedRuns) await runOne(run);
