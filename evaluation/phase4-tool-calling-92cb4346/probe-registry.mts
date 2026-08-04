import { writeFileSync } from "node:fs";
import { createFeatureResolver } from "/tmp/analytica-tool92.IH2rVI/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/features/resolver.ts";
import { buildExtensionRegistrations } from "/tmp/analytica-tool92.IH2rVI/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/index.ts";

const tools: Array<Record<string, unknown>> = [];
const pi = {
  registerTool: (tool: { name: string; description: string; parameters: unknown }) => {
    tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
  },
  registerCommand: () => {},
  on: () => {},
};
const resolver = createFeatureResolver({ runtimeProfile: "all-enabled" });
buildExtensionRegistrations(pi as never, resolver);
const snapshot = resolver.getEffectiveFeatureSnapshot();
const result = JSON.stringify({ snapshot, toolCount: tools.length, tools }, null, 2) + "\n";
writeFileSync(new URL("registry-probe.json", import.meta.url), result);
process.stdout.write(JSON.stringify({ toolCount: tools.length, names: tools.map((tool) => tool.name), effectiveFeatureHash: snapshot.effectiveFeatureHash }) + "\n");
