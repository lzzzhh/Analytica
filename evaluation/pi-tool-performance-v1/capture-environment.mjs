import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, "../..");
const documentPath = "/Users/zhanhuilin/.hermes/skills/agent-frameworks/pi-agent/Analytica_工具调用性能实验方案_v1.0.docx";
const cliPath = join(repo, "packages/coding-agent/dist/cli.js");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const command = (executable, args) => execFileSync(executable, args, { cwd: repo, encoding: "utf8" }).trim();
const binaryCommand = (executable, args) => execFileSync(executable, args, { cwd: repo });
const diff = command("git", ["diff", "--binary", "--", "packages/coding-agent/examples/extensions/multimodal-artifact-poc"]);
const environment = {
  capturedAt: new Date().toISOString(),
  repository: repo,
  commit: command("git", ["rev-parse", "HEAD"]),
  dirtyProductDiffSha256: hash(diff),
  dirtyProductFiles: command("git", ["diff", "--name-only", "--", "packages/coding-agent/examples/extensions/multimodal-artifact-poc"]).split("\n").filter(Boolean),
  document: { path: documentPath, sha256: hash(readFileSync(documentPath)) },
  registry: { path: join(root, "registry.json"), sha256: hash(readFileSync(join(root, "registry.json"))) },
  contract: { path: join(root, "experiment-contract.json"), sha256: hash(readFileSync(join(root, "experiment-contract.json"))) },
  tasks: { path: join(root, "tasks.json"), sha256: hash(readFileSync(join(root, "tasks.json"))) },
  cli: { path: cliPath, sha256: hash(readFileSync(cliPath)) },
  node: { path: process.execPath, version: process.version },
  python: {
    path: "/opt/anaconda3/bin/python3",
    version: command("/opt/anaconda3/bin/python3", ["--version"]),
  },
  model: "openai/gpt-5.6-luna",
  reasoningEffort: "max",
  openAiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
  commands: {
    probe: "node --import tsx evaluation/pi-tool-performance-v1/probe-current.mts",
    stage1: "node evaluation/pi-tool-performance-v1/run-stage1.mjs",
  },
  platform: command("uname", ["-a"]),
  npmVersion: command("npm", ["--version"]),
  nodeModulesLockSha256: hash(binaryCommand("git", ["show", "HEAD:package-lock.json"])),
};
writeFileSync(join(root, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ commit: environment.commit, dirtyProductDiffSha256: environment.dirtyProductDiffSha256, documentSha256: environment.document.sha256, registrySha256: environment.registry.sha256 })}\n`);
