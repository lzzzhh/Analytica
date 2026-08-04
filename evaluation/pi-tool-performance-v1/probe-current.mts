import { writeFileSync } from "node:fs";

import { buildExtensionRegistrations } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/index.ts";
import { createFeatureResolver } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/features/resolver.ts";

const tools: Array<Record<string, unknown>> = [];
const pi = {
  registerTool: (tool: { name: string; label?: string; description: string; parameters: unknown }) => {
    tools.push({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
  },
  registerCommand: () => {},
  on: () => {},
};
const resolver = createFeatureResolver({ runtimeProfile: "all-enabled" });
buildExtensionRegistrations(pi as never, resolver);
const result = {
  generatedAt: new Date().toISOString(),
  snapshot: resolver.getEffectiveFeatureSnapshot(),
  toolCount: tools.length,
  tools,
};
writeFileSync(new URL("registry.json", import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ toolCount: tools.length, names: tools.map((tool) => tool.name) })}\n`);
