import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const worktree = process.env.EVAL_WORKTREE;
if (!worktree) throw new Error("EVAL_WORKTREE is required");
const scenario = JSON.parse(readFileSync(join(root, "scenarios.json"), "utf8")).cases.find((item) => item.caseId === "GM-REV-02");
const cli = "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/cli.js";
const rpc = "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/rpc-entry.js";
const poc = join(worktree, "packages/coding-agent/examples/extensions/multimodal-artifact-poc");
const extension = join(poc, "index.ts");
const variants = ["baseline-1", "baseline-2", "baseline-3", "perturbation-1"];
const outDir = join(root, "confirmed-infra-retries");
mkdirSync(outDir, { recursive: true });

function parse(stdout) {
  const events = stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const calls = new Map();
  let finalText = "";
  for (const event of events) {
    if (event.type === "tool_execution_start") calls.set(event.toolCallId, { toolCallId: event.toolCallId, name: event.toolName, args: event.args, result: null, isError: null });
    if (event.type === "tool_execution_end") calls.set(event.toolCallId, { ...(calls.get(event.toolCallId) ?? {}), name: event.toolName, result: event.result, isError: event.isError });
    if (event.type === "message_end" && event.message?.role === "assistant") finalText = event.message.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n").trim() || finalText;
  }
  return { events, toolCalls: [...calls.values()], finalText };
}

async function run(variant) {
  const retryRoot = join(root, "runtime", "isolated-review-retries", variant);
  const seeded = JSON.parse(execFileSync("/Users/zhanhuilin/Documents/Analytica/node_modules/.bin/tsx", [join(root, "seed-review-retry.mts"), retryRoot], { encoding: "utf8" }));
  const promptText = variant === "perturbation-1" ? scenario.perturbedPrompt : scenario.basePrompt;
  const prompt = `${promptText}\n严格遵守范围；只调用必要工具。工具或证据不足时如实停止，不得虚构结果、Artifact、授权或正式交付。`;
  const args = [cli, "--mode", "json", "--no-session", "--approve", "--model", "openai/gpt-5.6-luna", "--thinking", "max", "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", scenario.availableTools.join(","), prompt];
  const env = {
    ...process.env, HOME: join(retryRoot, "home"), FEATURE_RUNTIME_PROFILE: "all-enabled",
    PATH: "/opt/anaconda3/bin:/Users/zhanhuilin/.pi/agent/bin:/Users/zhanhuilin/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    LAKEHOUSE_GATEWAY_URL: "http://127.0.0.1:18102", DATA_ANALYSIS_ARTIFACT_ROOT: seeded.artifactRoot,
    REVIEWER_STORE_ROOT: seeded.reviewerRoot, REVIEWER_CLI_PATH: rpc, REVIEWER_PROVIDER: "openai",
    REVIEWER_MODEL: "gpt-5.6-luna", MODEL_ID: "gpt-5.6-luna",
  };
  const child = spawn(process.execPath, args, { cwd: poc, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let timedOut = false;
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 600_000);
  const closed = await new Promise((resolve) => child.on("close", (exitCode, signal) => resolve({ exitCode, signal })));
  clearTimeout(timer);
  const parsed = parse(stdout);
  const runId = `GM-REV-02--${variant}`;
  writeFileSync(join(outDir, `${runId}.jsonl`), stdout);
  writeFileSync(join(outDir, `${runId}.json`), `${JSON.stringify({ runId, caseId: "GM-REV-02", slice: "reviewer", variant, ...closed, timedOut, toolCalls: parsed.toolCalls, finalText: parsed.finalText, stderrTail: stderr.slice(-8000), rawTrace: `confirmed-infra-retries/${runId}.jsonl` }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ runId, exitCode: closed.exitCode, timedOut, tools: parsed.toolCalls.map((call) => call.name) })}\n`);
}

await Promise.all(variants.map(run));
