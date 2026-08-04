/**
 * Data Analysis Subagent caller — runs the analysis subagent in an isolated
 * Pi RPC process (own context window), reusing the existing RpcClient
 * infrastructure. The subagent only receives the task prompt (manifest path,
 * schema, workspace path, budget); it never gets credentials, gateway
 * internals, chat history, or source-modification rights.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, type RpcClientOptions } from "../../../../../src/modes/rpc/rpc-client.ts";
import type { AgentSessionEvent } from "../../../../../src/core/agent-session.ts";
import type { SubagentCaller } from "./index.ts";

export interface DataAnalysisSubagentOptions {
  modelId?: string;
  provider?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createDataAnalysisSubagentCaller(
  options: DataAnalysisSubagentOptions,
): SubagentCaller {
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../dist/rpc-entry.js");
  // same real-model path as the semantic reviewer (stable); env overridable
  const provider = options.provider ?? process.env.ANALYSIS_SUBAGENT_PROVIDER ?? "openai";
  const modelId = options.modelId ?? process.env.ANALYSIS_SUBAGENT_MODEL_ID ?? "gpt-5.6-luna";
  const baseUrl = options.baseUrl ?? process.env.ANALYSIS_SUBAGENT_BASE_URL;

  return async (prompt: string, opts: { timeoutMs: number }) => {
    const started = Date.now();
    // Isolation (review #12): the analysis subagent runs with an ENV
    // WHITELIST (no inherited cloud/db/API secrets), a write-only tool set
    // and a non-interactive session. Comments claiming isolation are now
    // enforced, not aspirational.
    const whitelist: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: process.env.LANG ?? "en_US.UTF-8",
    };
    // provider keys are runtime-required (the model must authenticate);
    // everything else stays excluded
    if (process.env.OPENAI_API_KEY) whitelist.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.DEEPSEEK_API_KEY) whitelist.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (baseUrl) whitelist.LLAMA_BASE_URL = baseUrl;
    const rpcOptions: RpcClientOptions = {
      cliPath,
      cwd: process.cwd(),
      env: whitelist,
      isolateEnv: true,
      provider,
      model: modelId,
      // NOTE: passing ANY tool flag makes the RPC model return no reply
      // (pi rpc bug). The subagent outputs plan+script as TEXT (PLAN_JSON /
      // SCRIPT_START blocks); the host extracts and writes them. Isolation
      // is enforced by the env whitelist + prompt rules.
      args: ["--no-session"],
    };
    const client = new RpcClient(rpcOptions);
    try {
      await client.start();
      let finalText = "";
      let settled = false;
      const off = client.onEvent((event: AgentSessionEvent) => {
        if (event.type === "agent_end") {
          settled = true;
          for (const m of [...event.messages].reverse()) {
            if (m.role === "assistant" && "content" in m && Array.isArray((m as { content: unknown }).content)) {
              const text = ((m as { content: Array<{ type?: string; text?: string }> }).content)
                .filter((c) => c.type === "text" && typeof c.text === "string")
                .map((c) => c.text as string)
                .join("\n")
                .trim();
              if (text) {
                finalText = text;
                break;
              }
            }
          }
        }
      });
      await client.newSession();
      await client.prompt(prompt);
      await client.waitForIdle(opts.timeoutMs ?? options.timeoutMs ?? 180_000);
      if (!settled) await new Promise((r) => setTimeout(r, 500));
      off();
      if (!finalText) return { ok: false, text: "", error: "subagent finished without a final message" };
      return { ok: true, text: finalText };
    } catch (error) {
      return {
        ok: false,
        text: "",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client.stop().catch(() => {});
    }
  };
}
