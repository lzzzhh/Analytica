import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const command = (exe, args, cwd = repo) => execFileSync(exe, args, { cwd, encoding: "utf8" }).trim();
const fileHash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const python = command("/bin/zsh", ["-lc", "command -v python"]);
const env = {
  capturedAt: new Date().toISOString(),
  repositoryCommitSha: command("git", ["rev-parse", "HEAD"]),
  remoteMainSha: command("git", ["rev-parse", "origin/main"]),
  node: { executable: process.execPath, version: process.version },
  python: { executable: python, version: command(python, ["--version"]) },
  npmVersion: command("npm", ["--version"]),
  model: { provider: "openai", id: "gpt-5.6-luna", reasoningEffort: "max" },
  runtimeProfile: "all-enabled",
  rpcEntry: {
    path: join(repo, "packages/coding-agent/dist/rpc-entry.js"),
    sha256: fileHash(join(repo, "packages/coding-agent/dist/rpc-entry.js")),
  },
  packageLockSha256: fileHash(join(repo, "package-lock.json")),
  datasetManifestSha256: fileHash(join(repo, "evaluation/phase2-retest/artifacts/dataset-source-manifest.json")),
  evaluationWarehouse: join(import.meta.dirname, "runtime", "warehouse"),
};
writeFileSync(join(import.meta.dirname, "environment.json"), `${JSON.stringify(env, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
