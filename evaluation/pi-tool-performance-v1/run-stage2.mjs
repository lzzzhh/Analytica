import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, "../..");
const cli = join(repo, "packages/coding-agent/dist/cli.js");
const extension = join(root, "mock-extension.ts");
const registryPath = join(root, "registry.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const contract = JSON.parse(readFileSync(join(root, "experiment-contract.json"), "utf8"));
const tasks = JSON.parse(readFileSync(join(root, "stage2-tasks.json"), "utf8")).cases;
const coreTools = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8")).cases.map((item) => item.expectedNextTools[0]);
const uniqueCoreTools = [...new Set(coreTools)];
const output = join(root, "stage2");
const rawDir = join(output, "raw-traces");
const resultsPath = join(output, "results.jsonl");
mkdirSync(rawDir, { recursive: true });

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function shuffled(values, seedText) {
  let state = Number.parseInt(hash(seedText).slice(0, 8), 16) >>> 0;
  const out = [...values];
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

function requiredSubset(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((value, index) => requiredSubset(actual[index], value));
  if (expected && typeof expected === "object") {
    return Boolean(actual && typeof actual === "object")
      && Object.entries(expected).every(([key, value]) => requiredSubset(actual[key], value));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function parseObserved(lines) {
  const llmStart = lines.find((line) => line.event?.type === "message_start" && line.event.message?.role === "assistant");
  const calls = [];
  for (const line of lines) {
    if (line.event?.type === "tool_execution_start") {
      calls.push({
        id: line.event.toolCallId,
        name: line.event.toolName,
        args: line.event.args,
        startedNs: line.observedAtNs,
        endedNs: null,
        result: null,
        isError: null,
      });
    }
    if (line.event?.type === "tool_execution_end") {
      const call = calls.find((item) => item.id === line.event.toolCallId);
      if (call) {
        call.endedNs = line.observedAtNs;
        call.result = line.event.result;
        call.isError = line.event.isError;
      }
    }
  }
  const events = lines.map((line) => line.event).filter(Boolean);
  const final = [...events].reverse().find((event) => event.type === "message_end" && event.message?.role === "assistant");
  const finalText = final?.message?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
  return { llmStartNs: llmStart?.observedAtNs ?? null, calls, finalText, usage: final?.message?.usage ?? null };
}

function analyzeSequence(task, calls) {
  let expectedIndex = 0;
  let wrongCalls = 0;
  let redundantCalls = 0;
  let firstWrong = -1;
  let recoveryRounds = 0;
  const labels = [];
  const argumentChecks = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const expected = task.expectedPath[expectedIndex] ?? null;
    if (call.name === expected) {
      argumentChecks.push(requiredSubset(call.args, task.requiredArgs[expectedIndex]));
      if (firstWrong >= 0 && recoveryRounds === 0) recoveryRounds = index - firstWrong;
      expectedIndex += 1;
      if (expectedIndex >= task.expectedPath.length && index < calls.length - 1) {
        redundantCalls += calls.length - index - 1;
      }
    } else if (expectedIndex >= task.expectedPath.length) {
      redundantCalls += 1;
      labels.push("REDUNDANT_CALL");
    } else {
      wrongCalls += 1;
      if (firstWrong < 0) firstWrong = index;
      labels.push(task.expectedPath.includes(call.name) ? "ORDER_VIOLATION" : "WRONG_TOOL");
    }
  }
  const exact = calls.length === task.expectedPath.length
    && calls.every((call, index) => call.name === task.expectedPath[index])
    && argumentChecks.every(Boolean);
  return {
    exact,
    reachedTerminal: expectedIndex === task.expectedPath.length,
    wrongCalls,
    redundantCalls,
    recoveryRounds,
    argumentChecks,
    errorLabels: [...new Set(labels)],
  };
}

function runOne(run) {
  return new Promise((resolveRun) => {
    const prompt = [
      `节点任务：${run.task.userIntent}`,
      "使用可用工具完成整个节点任务。严格遵守前置条件并根据每次工具结果决定下一步；到达终态后立即停止。",
    ].join("\n");
    const args = [
      cli, "--mode", "json", "--no-session", "--approve",
      "--model", contract.model, "--thinking", contract.reasoningEffort,
      "--no-extensions", "--extension", extension,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--tools", run.visibleTools.join(","), prompt,
    ];
    const startedAt = new Date().toISOString();
    const startedNs = process.hrtime.bigint();
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env: {
        ...process.env,
        PI_PERF_REGISTRY: registryPath,
        PI_PERF_VISIBLE_TOOLS: run.visibleTools.join(","),
        PI_PERF_MOCK_CONFIG: JSON.stringify({ stage: "stage2", resultFormat: run.format, expectedPath: run.task.expectedPath }),
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
        try { observed.push({ observedAtNs: process.hrtime.bigint().toString(), event: JSON.parse(text) }); }
        catch { observed.push({ observedAtNs: process.hrtime.bigint().toString(), nonJson: text }); }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, contract.stage2.timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const endedNs = process.hrtime.bigint();
      const rawPath = join(rawDir, `${run.runId}.jsonl`);
      writeFileSync(rawPath, observed.map((line) => JSON.stringify(line)).join("\n") + "\n");
      const parsed = parseObserved(observed);
      const sequence = analyzeSequence(run.task, parsed.calls);
      let outcome = sequence.exact ? "COMPLETED" : "FAILED";
      if (timedOut) outcome = "TIMEOUT";
      else if (exitCode !== 0) outcome = /rate|provider|api|network|429|5\d\d/i.test(stderr) ? "PROVIDER_ERROR" : "INFRA_ERROR";
      const firstCorrect = parsed.calls.find((call) => call.name === run.task.expectedPath[0]);
      const result = {
        experimentRunId: run.runId,
        stage: "stage2",
        taskId: run.task.taskId,
        resultFormat: run.format,
        repetition: run.repetition,
        model: contract.model,
        visibleToolIds: run.visibleTools,
        toolCatalogHash: hash(run.visibleTools.map((name) => registry.tools.find((tool) => tool.name === name))),
        expectedPath: run.task.expectedPath,
        calls: parsed.calls,
        exactSequence: sequence.exact,
        reachedTerminal: sequence.reachedTerminal,
        redundantCalls: sequence.redundantCalls,
        wrongCalls: sequence.wrongCalls,
        recoveryRounds: sequence.recoveryRounds,
        argumentChecks: sequence.argumentChecks,
        errorLabels: sequence.errorLabels,
        finalText: parsed.finalText,
        durationsMs: {
          total: Number(endedNs - startedNs) / 1e6,
          firstCorrectTool: firstCorrect && parsed.llmStartNs ? Number(BigInt(firstCorrect.startedNs) - BigInt(parsed.llmStartNs)) / 1e6 : null,
        },
        usage: parsed.usage,
        outcome,
        exitCode,
        signal,
        startedAt,
        finishedAt: new Date().toISOString(),
        rawTrace: `raw-traces/${run.runId}.jsonl`,
        stderrTail: stderr.slice(-2000),
      };
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
      process.stdout.write(`${JSON.stringify({ runId: run.runId, outcome, calls: parsed.calls.map((call) => call.name), exact: sequence.exact })}\n`);
      resolveRun(result);
    });
  });
}

const completed = new Set();
if (existsSync(resultsPath)) {
  for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
    if (line.trim()) completed.add(JSON.parse(line).experimentRunId);
  }
}
const runs = [];
for (const task of tasks) {
  for (const format of contract.stage2.resultFormats) {
    for (let repetition = 1; repetition <= contract.stage2.repetitions; repetition += 1) {
      const runId = `s2_${task.taskId}_${format}_r${repetition}`.replaceAll(/[^A-Za-z0-9_-]/g, "_");
      if (!completed.has(runId)) {
        runs.push({
          runId,
          task,
          format,
          repetition,
          visibleTools: shuffled(uniqueCoreTools, `${contract.randomSeedNamespace}:${runId}`),
        });
      }
    }
  }
}
const pilot = process.argv.includes("--pilot");
const selected = pilot ? runs.slice(0, 1) : runs;
process.stdout.write(`${JSON.stringify({ stage: "stage2", pending: selected.length, totalExpected: 60, pilot })}\n`);
for (const run of selected) await runOne(run);
