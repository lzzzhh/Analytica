import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve("evaluation/phase3-agent-evaluation");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const excluded = new Set([resolve(root, "evidence-manifest.json")]);
const entries = files(root).filter((path) => !excluded.has(path)).sort().map((path) => {
  const bytes = readFileSync(path);
  return { path: relative(root, path), bytes: statSync(path).size, sha256: createHash("sha256").update(bytes).digest("hex") };
});
writeFileSync(resolve(root, "evidence-manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2) + "\n");
process.stdout.write(`${entries.length} evidence files hashed\n`);
