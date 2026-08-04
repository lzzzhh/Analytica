import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const worktree = "/tmp/analytica-tool92.IH2rVI/checkout";
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (command, args, cwd = worktree) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const python = "/opt/anaconda3/bin/python3.13";
const dependencies = JSON.parse(run(python, ["-c", [
  "import json, importlib.metadata as m",
  "names=['pyiceberg','pyspark','pytest','fastapi','uvicorn','pyarrow','pandas','jsonschema']",
  "print(json.dumps({n:m.version(n) for n in names}))",
].join("; ")]));
const environment = {
  repositoryCommitSha: run("git", ["rev-parse", "HEAD"]),
  remoteMainSha: run("git", ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0],
  isolatedWorktree: worktree,
  nodeExecutable: process.execPath,
  nodeVersion: process.version,
  pythonExecutable: python,
  pythonVersion: run(python, ["--version"]),
  dependencies,
  model: "openai/gpt-5.6-luna",
  reasoningEffort: "max",
  attemptsPerCase: 1,
  runtimeProfile: "all-enabled",
  effectiveFeatureHash: "238202ebcc848449",
  gatewayUrl: "http://127.0.0.1:18101",
  gatewayWarehouse: join(root, "runtime", "gateway-warehouse"),
  artifactRoot: join(root, "runtime", "home", ".pi", "artifacts", "data-analysis"),
  reviewerRoot: join(root, "runtime", "reviewer-store"),
  pipelineWarehouse: join(root, "runtime", "pipeline-warehouse"),
  credentials: { OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY) },
  runtimeArtifacts: {
    cli: { path: "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/cli.js", sha256: sha256("/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/cli.js") },
    rpc: { path: "/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/rpc-entry.js", sha256: sha256("/Users/zhanhuilin/Documents/Analytica/packages/coding-agent/dist/rpc-entry.js") },
    packageLockSha256: sha256(join(worktree, "package-lock.json")),
  },
};
writeFileSync(join(root, "environment.json"), JSON.stringify(environment, null, 2) + "\n");
process.stdout.write(JSON.stringify({ commit: environment.repositoryCommitSha, remote: environment.remoteMainSha, model: environment.model, featureHash: environment.effectiveFeatureHash }) + "\n");
