import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve("evaluation/phase3-retest-5356473b");
const manifestPath = resolve(root, "evidence-manifest.json");
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const entries = walk(root).filter((path) => path !== manifestPath).sort().map((path) => {
  const bytes = readFileSync(path);
  return { path: relative(root, path), bytes: statSync(path).size, sha256: createHash("sha256").update(bytes).digest("hex") };
});
writeFileSync(manifestPath, JSON.stringify({ commit: "5356473b2746daff6007802584da3afd8dba6613", generatedAt: new Date().toISOString(), entries }, null, 2) + "\n");
process.stdout.write(`${entries.length} files hashed\n`);
