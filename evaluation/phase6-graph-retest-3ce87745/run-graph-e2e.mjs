import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "/tmp/analytica-phase6-3ce87745/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/data-analysis/artifact-store.ts";

const out = join(import.meta.dirname, "graph-e2e");
const home = join(out, "home");
const storeRoot = join(out, "reviewer-store");
const artifactRoot = join(home, ".pi", "artifacts", "data-analysis");
mkdirSync(out, { recursive: true });
const artifactId = "art_e2e0000000000001";
const csv = "date,revenue\n2026-01-01,100\n2026-01-02,150\n2026-01-03,200\n";
const contentHash = createHash("sha256").update(csv).digest("hex");
const store = new ArtifactStore(artifactRoot);
if (!store.readInputBytes(artifactId)) {
  store.register({
    artifactId, contentType: "text/csv", contentHash, masked: true,
    sensitive: false, columns: ["date", "revenue"], queryId: "q_e2e_graph_01",
    snapshotId: "snap_e2e_graph_01", lineageReference: "eval_raw.graph_revenue",
    createdAt: new Date().toISOString(),
  }, csv);
}
const cli = "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/cli.js";
const extension = "/tmp/analytica-phase6-3ce87745/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/index.ts";
const prompt = `完成一个正式数据分析任务：使用 run_analysis_graph 对 Artifact ${artifactId} 计算 revenue 总和，并生成 markdown 正式报告。必须使用 runId=e2e_graph_01。完成后用 inspect_graph_run 检查状态。不得虚构成功。`;
const args = [
  cli, "--mode", "json", "--no-session", "--approve",
  "--model", "openai/gpt-5.6-luna", "--thinking", "max",
  "--no-extensions", "--extension", extension,
  "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  "--tools", "run_analysis_graph,inspect_graph_run", prompt,
];
const startedAt = new Date().toISOString();
const monotonicStart = process.hrtime.bigint();
const run = spawnSync(process.execPath, args, {
  cwd: "/tmp/analytica-phase6-3ce87745/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc",
  env: {
    ...process.env, HOME: home, FEATURE_RUNTIME_PROFILE: "all-enabled",
    DATA_ANALYSIS_ARTIFACT_ROOT: artifactRoot, REVIEWER_STORE_ROOT: storeRoot,
    GRAPH_STORE_ROOT: storeRoot, REVIEWER_PROVIDER: "openai", REVIEWER_MODEL: "gpt-5.6-luna",
    ANALYSIS_SUBAGENT_PROVIDER: "openai", ANALYSIS_SUBAGENT_MODEL_ID: "gpt-5.6-luna",
    REVIEWER_CLI_PATH: "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/rpc-entry.js",
  },
  encoding: "utf8", timeout: 900_000, maxBuffer: 100 * 1024 * 1024,
});
const durationMs = Number(process.hrtime.bigint() - monotonicStart) / 1e6;
writeFileSync(join(out, "raw-trace.jsonl"), run.stdout ?? "");
const events = String(run.stdout ?? "").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const calls = new Map();
for (const event of events) {
  if (event.type === "tool_execution_start") calls.set(event.toolCallId, { name: event.toolName, args: event.args });
  if (event.type === "tool_execution_end") calls.set(event.toolCallId, { ...(calls.get(event.toolCallId) ?? {}), result: event.result, isError: event.isError });
}
const normalized = {
  scenarioId: "E2E-GRAPH-01", startedAt, finishedAt: new Date().toISOString(), durationMs,
  exitCode: run.status, signal: run.signal, timedOut: run.error?.code === "ETIMEDOUT",
  artifact: { artifactId, contentHash }, toolCalls: [...calls.values()], stderr: run.stderr,
};
writeFileSync(join(out, "result.json"), `${JSON.stringify(normalized, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ exitCode: run.status, durationMs, tools: normalized.toolCalls.map((call) => call.name) })}\n`);
