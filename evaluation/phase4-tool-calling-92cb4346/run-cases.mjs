import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const worktree = "/tmp/analytica-tool92.IH2rVI/checkout";
const poc = join(worktree, "packages/coding-agent/examples/extensions/multimodal-artifact-poc");
const cli = "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/cli.js";
const extension = join(poc, "index.ts");
const runtime = JSON.parse(readFileSync(join(root, "runtime-manifest.json"), "utf8"));
const review = JSON.parse(readFileSync(join(root, "review-fixtures.json"), "utf8"));
const suites = ["single-tool.json", "multi-tool.json", "workflow.json"]
  .flatMap((name) => JSON.parse(readFileSync(join(root, "resolved-scenarios", name), "utf8")).cases);
const requested = new Set(process.argv.slice(2));
const cases = requested.size ? suites.filter((scenario) => requested.has(scenario.caseId)) : suites;
const rawDir = join(root, "raw-traces");
const resultDir = join(root, "results-normalized");
mkdirSync(rawDir, { recursive: true });
mkdirSync(resultDir, { recursive: true });

const baseEnv = {
  ...process.env,
  HOME: runtime.home,
  PATH: `/opt/anaconda3/bin:/Users/zhanhuilin/.pi/agent/bin:/Users/zhanhuilin/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  FEATURE_RUNTIME_PROFILE: "all-enabled",
  LAKEHOUSE_GATEWAY_URL: "http://127.0.0.1:18101",
  DATA_ANALYSIS_ARTIFACT_ROOT: join(runtime.home, ".pi", "artifacts", "data-analysis"),
  REVIEWER_STORE_ROOT: review.reviewerRoot,
  REVIEWER_CLI_PATH: "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/rpc-entry.js",
  REVIEWER_PROVIDER: "openai",
  REVIEWER_MODEL: "gpt-5.6-luna",
  ANALYSIS_SUBAGENT_PROVIDER: "openai",
  ANALYSIS_SUBAGENT_MODEL_ID: "gpt-5.6-luna",
  MODEL_ID: "gpt-5.6-luna",
  PIPELINE_GOVERNANCE_ROOT: runtime.pipeline.approvedGovernanceRoot,
};

function textFromMessage(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n").trim();
}

function parseTrace(stdout) {
  const events = [];
  const nonJson = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { nonJson.push(line); }
  }
  const calls = new Map();
  for (const event of events) {
    if (event.type === "tool_execution_start") {
      calls.set(event.toolCallId, { toolCallId: event.toolCallId, name: event.toolName, args: event.args, result: null, isError: null });
    }
    if (event.type === "tool_execution_end") {
      const call = calls.get(event.toolCallId) ?? { toolCallId: event.toolCallId, name: event.toolName, args: null };
      calls.set(event.toolCallId, { ...call, result: event.result, isError: event.isError });
    }
  }
  let finalText = "";
  for (const event of events) {
    if (event.type === "message_end") {
      const text = textFromMessage(event.message);
      if (text) finalText = text;
    }
  }
  return { events, nonJson, toolCalls: [...calls.values()], finalText };
}

function runCase(scenario) {
  return new Promise((resolve) => {
    const rawPath = join(rawDir, `${scenario.caseId}.jsonl`);
    const resultPath = join(resultDir, `${scenario.caseId}.json`);
    if (existsSync(resultPath)) {
      resolve({ caseId: scenario.caseId, skipped: true });
      return;
    }
    const prompt = [
      scenario.userTask,
      scenario.inputArtifacts.length ? `\n冻结输入（只可按给定值使用，不得猜测或改写）：\n${JSON.stringify(scenario.inputArtifacts, null, 2)}` : "",
      "\n严格遵守任务范围。只调用完成任务所必需的可用工具；工具失败时如实报告，不得虚构结果或绕过治理。",
    ].join("");
    const args = [
      cli, "--mode", "json", "--no-session", "--approve",
      "--model", "openai/gpt-5.6-luna", "--thinking", "max",
      "--no-extensions", "--extension", extension,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--tools", scenario.availableTools.join(","), prompt,
    ];
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, args, { cwd: poc, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timeoutMs = scenario.layer === "workflow" ? 600_000 : 300_000;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      writeFileSync(rawPath, stdout);
      const parsed = parseTrace(stdout);
      const normalized = {
        caseId: scenario.caseId, layer: scenario.layer, startedAt,
        finishedAt: new Date().toISOString(), exitCode, signal, timedOut,
        command: { executable: process.execPath, cli, model: "openai/gpt-5.6-luna", thinking: "max", tools: scenario.availableTools },
        toolCalls: parsed.toolCalls, finalText: parsed.finalText,
        nonJsonStdout: parsed.nonJson, stderrTail: stderr.slice(-8000),
        eventCount: parsed.events.length, rawTrace: `raw-traces/${scenario.caseId}.jsonl`,
      };
      writeFileSync(resultPath, JSON.stringify(normalized, null, 2) + "\n");
      process.stdout.write(JSON.stringify({ caseId: scenario.caseId, exitCode, timedOut, tools: parsed.toolCalls.map((call) => call.name), finalChars: parsed.finalText.length }) + "\n");
      resolve(normalized);
    });
  });
}

writeFileSync(join(root, "execution-runs.jsonl"), JSON.stringify({
  startedAt: new Date().toISOString(), designManifestSha256: process.env.DESIGN_MANIFEST_SHA256 ?? null,
  requestedCaseIds: cases.map((scenario) => scenario.caseId),
}) + "\n", { flag: "a" });

const concurrency = 2;
let cursor = 0;
const workers = Array.from({ length: concurrency }, async () => {
  while (cursor < cases.length) {
    const scenario = cases[cursor++];
    await runCase(scenario);
  }
});
await Promise.all(workers);
