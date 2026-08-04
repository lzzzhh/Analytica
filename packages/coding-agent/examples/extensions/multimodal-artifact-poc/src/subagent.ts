/**
 * Sub-agent document analyst.
 *
 * Spawns an independent Pi RPC process with its own context window.
 * The document markdown and the user's question are sent to the sub-agent,
 * which reasons in isolation and returns its final answer. The main agent
 * only receives the sub-agent's summary — never the full document.
 *
 * This isolates long document content from the main agent's context.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, type RpcClientOptions } from "../../../../src/modes/rpc/rpc-client.ts";
import type { AgentSessionEvent } from "../../../../src/core/agent-session.ts";

export interface SubagentResult {
  answer: string;
  subagentTokens: number;
  durationMs: number;
  error?: string;
}

const SUBAGENT_SYSTEM_PROMPT = `You are a document analyst working in an isolated context.
You receive a document and a question. Answer the question using ONLY the document content.
Rules:
- Quote exact numbers, dates, and names precisely as they appear in the document.
- If the document does not contain the answer, say "文档中没有这个信息" — never invent content.
- Keep the answer concise (under 300 words).`;

export interface DocumentSubagentOptions {
  /** Path to the document markdown (persisted artifact) */
  markdownPath: string;
  /** Document artifact id for reference */
  artifactId: string;
  /** Question from the main agent's user */
  question: string;
  /** Timeout for the whole sub-agent run (ms) */
  timeoutMs?: number;
}

/**
 * Run one document-analysis task in a fresh sub-agent.
 * Spawns a new RPC process per call (isolation guarantee); kills it afterwards.
 */
export async function runDocumentSubagent(options: DocumentSubagentOptions): Promise<SubagentResult> {
  const started = Date.now();
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../dist/rpc-entry.js");

  const rpcOptions: RpcClientOptions = {
    cliPath,
    cwd: process.cwd(),
    env: { LLAMA_BASE_URL: process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080" },
    provider: "llama.cpp",
    model: process.env.SUBAGENT_MODEL_ID ?? "Qwen3-8B-Q4_K_M",
    args: ["--no-session"],
  };

  const client = new RpcClient(rpcOptions);

  try {
    await client.start();

    const { readFileSync } = await import("node:fs");
    const markdown = readFileSync(options.markdownPath, "utf8");

    // Prompt: system prompt + document + question in a single message.
    // The sub-agent never needs tools for this task.
    const prompt = `${SUBAGENT_SYSTEM_PROMPT}\n\n--- 文档内容（artifact: ${options.artifactId}）---\n${markdown}\n\n--- 用户问题 ---\n${options.question}`;

    let finalText = "";
    let finalUsage: { input: number; output: number } | undefined;
    let settled = false;

    const off = client.onEvent((event: AgentSessionEvent) => {
      if (event.type === "agent_end") {
        settled = true;
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
              const usage = (m as { usage?: { input?: number; output?: number } }).usage;
              if (usage) finalUsage = { input: usage.input ?? 0, output: usage.output ?? 0 };
              break;
            }
          }
        }
      }
    });

    await client.newSession();
    await client.prompt(prompt);
    await client.waitForIdle(options.timeoutMs ?? 180_000);

    if (!settled) {
      // waitForIdle returned but no agent_end observed — give it a moment
      await new Promise((r) => setTimeout(r, 500));
    }
    off();

    if (!finalText) {
      throw new Error("Sub-agent finished without a final assistant message");
    }

    const usage = finalUsage ?? { input: 0, output: 0 };
    return {
      answer: finalText,
      subagentTokens: usage.input + usage.output,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      answer: "",
      subagentTokens: 0,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.stop().catch(() => {});
  }
}
