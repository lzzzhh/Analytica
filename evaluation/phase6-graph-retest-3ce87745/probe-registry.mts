import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildExtensionRegistrations } from "/tmp/analytica-phase6-3ce87745/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/index.ts";
import { createFeatureResolver } from "/tmp/analytica-phase6-3ce87745/checkout/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/features/resolver.ts";

const tools: Array<{ name: string; description: string; parameters: unknown }> = [];
const api = {
  registerTool: (tool: { name: string; description: string; parameters: unknown }) => tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters }),
  registerCommand: () => {}, on: () => {},
};
const resolver = createFeatureResolver({ runtimeProfile: "all-enabled" });
buildExtensionRegistrations(api as never, resolver);
const snapshot = resolver.getEffectiveFeatureSnapshot({ modelId: "gpt-5.6-luna", datasetSnapshot: "phase6" });
const out = { commit: "3ce87745f9b1546a10ab7fd015dc543eec8bc7ba", count: tools.length, names: tools.map((tool) => tool.name), snapshot, tools };
writeFileSync(join(import.meta.dirname, "registry-probe.json"), `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ count: tools.length, names: tools.map((tool) => tool.name), featureHash: snapshot.effectiveFeatureHash })}\n`);
