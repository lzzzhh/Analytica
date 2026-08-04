import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const worktree = process.env.EVAL_WORKTREE;
if (!worktree) throw new Error("EVAL_WORKTREE is required");
const poc = join(worktree, "packages/coding-agent/examples/extensions/multimodal-artifact-poc");
const extension = join(poc, "index.ts");
const cli = "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/cli.js";
const phase4 = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346";
const runtime = JSON.parse(readFileSync(join(phase4, "runtime-manifest.json"), "utf8"));
const review = JSON.parse(readFileSync(join(phase4, "review-fixtures.json"), "utf8"));
const design = JSON.parse(readFileSync(join(root, "scenarios.json"), "utf8"));
const rawDir = join(root, "raw-traces");
const resultDir = join(root, "results-normalized");
mkdirSync(rawDir, { recursive: true });
mkdirSync(resultDir, { recursive: true });

const variants = [
  { name: "baseline-1", promptKey: "basePrompt" },
  { name: "baseline-2", promptKey: "basePrompt" },
  { name: "baseline-3", promptKey: "basePrompt" },
  { name: "perturbation-1", promptKey: "perturbedPrompt" },
];
const requested = new Set(process.argv.slice(2));
const runs = design.cases.flatMap((scenario) => variants.map((variant) => ({ scenario, variant })))
  .filter(({ scenario }) => requested.size === 0 || requested.has(scenario.caseId));

const baseEnv = {
  ...process.env,
  HOME: runtime.home,
  PATH: "/opt/anaconda3/bin:/Users/zhanhuilin/.pi/agent/bin:/Users/zhanhuilin/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  FEATURE_RUNTIME_PROFILE: "all-enabled",
  LAKEHOUSE_GATEWAY_URL: "http://127.0.0.1:18102",
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

function assistantText(message) {
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
    if (event.type === "tool_execution_start") calls.set(event.toolCallId, { toolCallId: event.toolCallId, name: event.toolName, args: event.args, result: null, isError: null });
    if (event.type === "tool_execution_end") {
      const prior = calls.get(event.toolCallId) ?? { toolCallId: event.toolCallId, name: event.toolName, args: null };
      calls.set(event.toolCallId, { ...prior, result: event.result, isError: event.isError });
    }
  }
  let finalText = "";
  for (const event of events) if (event.type === "message_end") finalText = assistantText(event.message) || finalText;
  return { events, nonJson, toolCalls: [...calls.values()], finalText };
}

async function runOne({ scenario, variant }) {
  const runId = `${scenario.caseId}--${variant.name}`;
  const resultPath = join(resultDir, `${runId}.json`);
  if (existsSync(resultPath)) return { runId, skipped: true };
  const input = scenario.inputArtifacts?.length
    ? `\n冻结输入（只能使用以下值，不得改写或猜测）：\n${JSON.stringify(scenario.inputArtifacts, null, 2)}`
    : "";
  const prompt = `${scenario[variant.promptKey]}${input}\n严格遵守范围；只调用必要工具。工具或证据不足时如实停止，不得虚构结果、Artifact、授权或正式交付。`;
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
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 600_000);
  const closed = await new Promise((resolve) => child.on("close", (exitCode, signal) => resolve({ exitCode, signal })));
  clearTimeout(timer);
  writeFileSync(join(rawDir, `${runId}.jsonl`), stdout);
  const parsed = parseTrace(stdout);
  const normalized = {
    runId, caseId: scenario.caseId, slice: scenario.slice, variant: variant.name,
    startedAt, finishedAt: new Date().toISOString(), ...closed, timedOut,
    command: { executable: process.execPath, cli, model: "openai/gpt-5.6-luna", thinking: "max", tools: scenario.availableTools },
    toolCalls: parsed.toolCalls, finalText: parsed.finalText, nonJsonStdout: parsed.nonJson,
    stderrTail: stderr.slice(-8000), eventCount: parsed.events.length,
    rawTrace: `raw-traces/${runId}.jsonl`,
  };
  writeFileSync(resultPath, `${JSON.stringify(normalized, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ runId, exitCode: closed.exitCode, timedOut, tools: parsed.toolCalls.map((call) => call.name), finalChars: parsed.finalText.length })}\n`);
  return normalized;
}

writeFileSync(join(root, "execution-runs.jsonl"), `${JSON.stringify({
  startedAt: new Date().toISOString(), worktree, commit: design.frozenCommit,
  runs: runs.map(({ scenario, variant }) => `${scenario.caseId}--${variant.name}`),
})}\n`, { flag: "a" });

let cursor = 0;
const concurrency = 2;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < runs.length) await runOne(runs[cursor++]);
}));
