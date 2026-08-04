import { probeAdvisor } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/requirement-planning/adapters/pi-planning-advisor.ts";

try {
  await probeAdvisor({ modelId: "default-planner-model", provider: "openai", timeoutMs: 30_000 });
  process.stdout.write(JSON.stringify({ status: "PASS", provider: "openai", model: "default-planner-model" }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ status: "INFRA_ERROR", provider: "openai", model: "default-planner-model", error: error instanceof Error ? error.message : String(error) }) + "\n");
}
