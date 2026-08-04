import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = import.meta.dirname;
const output = join(root, "evidence-manifest.json");
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (path === output) return [];
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const files = walk(root).sort().map((path) => {
  const bytes = readFileSync(path);
  return { path: relative(root, path), bytes: statSync(path).size, sha256: createHash("sha256").update(bytes).digest("hex") };
});
writeFileSync(output, `${JSON.stringify({ schemaVersion: "1.0", commit: "92cb4346ac5f0b4edc3eefcdcb81978e570fd220", files }, null, 2)}\n`);
console.log(JSON.stringify({ files: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0) }));
