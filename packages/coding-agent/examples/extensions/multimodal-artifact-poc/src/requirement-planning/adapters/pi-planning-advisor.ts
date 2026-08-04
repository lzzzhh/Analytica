/**
 * Pi Planning Advisor adapter — runs the advisor prompt through the existing
 * sub-agent RPC infrastructure (no new process management code).
 *
 * The advisor output is strictly JSON; the core validates and repairs it
 * (one repair attempt), never guesses beyond that.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../../../../../src/modes/rpc/rpc-client.ts";
import type { AgentSessionEvent } from "../../../../../../src/core/agent-session.ts";
import type { AdvisorCaller } from "../advisor.ts";

const ADVISOR_SYSTEM_PROMPT = `You are a requirement planning advisor (isolated context).
You receive a business request and must return STRICT JSON only.
Rules:
- Output ONLY valid JSON, no markdown fences, no prose, no reasoning.
- Never fabricate business facts. If something is unknown, mark it in ambiguities.
- You are not the decision maker; you produce candidate analysis only.
- Never output chain-of-thought.`;

export interface PiAdvisorConfig {
  modelId: string;
  provider?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class AdvisorUnavailableError extends Error {}

/** Startup canary: verify the advisor backend actually answers before the
 *  planning flow depends on it. Throws AdvisorUnavailableError when the
 *  configured endpoint/model is missing or returns a non-model response. */
export async function probeAdvisor(config: PiAdvisorConfig): Promise<void> {
  const caller = createPiAdvisorCaller(config);
  const result = await caller("Return exactly: {\"ok\":true}");
  if (!result.ok) {
    throw new AdvisorUnavailableError(
      `planning advisor unavailable: ${result.error ?? "no reply"} (provider=${config.provider ?? "openai"})`);
  }
}

/**
 * Create an advisor caller backed by a fresh Pi RPC sub-agent per call.
 * Mirrors runDocumentSubagent but with the advisor system prompt.
 */
export function createPiAdvisorCaller(config: PiAdvisorConfig): AdvisorCaller {
  return async (prompt: string) => {
    const started = Date.now();
    const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../dist/rpc-entry.js");
    const provider = config.provider ?? process.env.ADVISOR_PROVIDER ?? "openai";
    const baseUrl = config.baseUrl ?? process.env.ADVISOR_BASE_URL;
    const client = new RpcClient({
      cliPath,
      cwd: process.cwd(),
      env: baseUrl ? { [provider === "llama.cpp" ? "LLAMA_BASE_URL" : "OPENAI_BASE_URL"]: baseUrl } : {},
      provider,
      model: config.modelId,
      args: ["--no-session"],
    });

    try {
      await client.start();
      let finalText = "";
      const off = client.onEvent((event: AgentSessionEvent) => {
        if (event.type === "agent_end") {
          for (const m of [...event.messages].reverse()) {
            if (m.role === "assistant" && "content" in m && Array.isArray((m as { content: unknown }).content)) {
              const content = (m as { content: Array<{ type?: string; text?: string }> }).content;
              const text = content
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
      await client.prompt(`${ADVISOR_SYSTEM_PROMPT}\n\n${prompt}`);
      await client.waitForIdle(config.timeoutMs ?? 180_000);
      off();
      if (!finalText) {
        return { ok: false, text: "", error: "advisor finished without a final message" };
      }
      return { ok: true, text: finalText };
    } catch (error) {
      // launch/config failures are surfaced, never silent
      // eslint-disable-next-line no-console
      console.warn(`[planning-advisor] RPC failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
      return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
    } finally {
      await client.stop().catch(() => {});
    }
  };
}

export { PI_TOOL_MAP } from "./pi-capabilities.ts";
