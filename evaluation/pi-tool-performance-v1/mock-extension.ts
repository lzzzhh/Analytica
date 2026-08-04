import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface RegistryTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface MockConfig {
  stage: "stage1" | "stage2";
  resultFormat?: "M0_CURRENT" | "M1_STANDARD";
  expectedPath?: string[];
}

const registryPath = process.env.PI_PERF_REGISTRY;
if (!registryPath) throw new Error("PI_PERF_REGISTRY is required");
const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { tools: RegistryTool[] };
const visible = (process.env.PI_PERF_VISIBLE_TOOLS ?? "").split(",").filter(Boolean);
const config = JSON.parse(process.env.PI_PERF_MOCK_CONFIG ?? '{"stage":"stage1"}') as MockConfig;
let cursor = 0;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function outputId(toolName: string): string {
  if (toolName === "validate_query") return `vq_mock_${cursor}`;
  if (toolName === "materialize_query" || toolName === "run_data_analysis") return `art_mock_${cursor}`;
  if (toolName === "review_data_analysis") return `review_mock_${cursor}`;
  return `mock_${cursor}`;
}

function stage2Result(toolName: string): Record<string, unknown> {
  const expected = config.expectedPath?.[cursor] ?? null;
  if (toolName !== expected) {
    return config.resultFormat === "M1_STANDARD"
      ? {
          ok: false,
          statusCode: "ORDER_VIOLATION",
          agentSummary: `当前应调用 ${expected ?? "STOP"}。`,
          nextAllowedCapabilities: expected ? [expected] : [],
          outputRefs: [],
          retryable: true,
        }
      : {
          success: false,
          error: "prerequisite state does not permit this operation",
          expectedTool: expected,
          diagnostic: "The requested operation cannot be completed because the workflow state is not ready.",
        };
  }
  cursor += 1;
  const next = config.expectedPath?.[cursor] ?? null;
  return config.resultFormat === "M1_STANDARD"
    ? {
        ok: true,
        statusCode: next ? `${toolName.toUpperCase()}_COMPLETED` : "TERMINAL_COMPLETED",
        agentSummary: next ? `当前步骤完成，下一允许能力为 ${next}。` : "任务已到达正确终态。",
        nextAllowedCapabilities: next ? [next] : [],
        outputRefs: [{ type: "mock-artifact", id: outputId(toolName) }],
        retryable: false,
      }
    : {
        success: true,
        operation: toolName,
        result: { id: outputId(toolName), state: next ? "ready_for_next_step" : "completed" },
        metadata: { nextOperationHint: next, logs: ["mock execution completed", "state persisted"] },
      };
}

export default function registerMockTools(pi: ExtensionAPI): void {
  const byName = new Map(registry.tools.map((tool) => [tool.name, tool]));
  for (const name of visible) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`unknown visible tool: ${name}`);
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: Type.Unsafe(tool.parameters),
      async execute() {
        await sleep(15);
        const result = config.stage === "stage2"
          ? stage2Result(tool.name)
          : { ok: true, statusCode: "FIRST_TOOL_CAPTURED", agentSummary: "实验已记录首次工具调用，请结束。" };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    });
  }
}
