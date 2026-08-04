import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("./", import.meta.url).pathname;
const excluded = new Set(["evidence-manifest.json"]);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return [path];
  });
}

const files = walk(root)
  .map((path) => ({ path, relativePath: relative(root, path) }))
  .filter(({ relativePath }) => !excluded.has(relativePath))
  .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  .map(({ path, relativePath }) => ({
    path: relativePath,
    size: statSync(path).size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));

const manifest = {
  schemaVersion: "1.0",
  commit: "3ce87745f9b1546a10ab7fd015dc543eec8bc7ba",
  generatedAt: new Date().toISOString(),
  fileCount: files.length,
  files,
};
writeFileSync(join(root, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
