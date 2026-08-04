import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const worktree = process.env.EVAL_WORKTREE;
if (!worktree) throw new Error("EVAL_WORKTREE is required");
const phase4Root = "/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346";
const phase4Env = JSON.parse(readFileSync(join(phase4Root, "environment.json"), "utf8"));
const runtime = JSON.parse(readFileSync(join(phase4Root, "runtime-manifest.json"), "utf8"));
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const environment = {
  schemaVersion: "1.0",
  repositoryCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(),
  remoteMainSha: execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], { cwd: worktree, encoding: "utf8" }).trim().split(/\s+/)[0],
  isolatedWorktree: worktree,
  nodeExecutable: process.execPath,
  nodeVersion: process.version,
  pythonExecutable: phase4Env.pythonExecutable,
  pythonVersion: phase4Env.pythonVersion,
  dependencies: phase4Env.dependencies,
  model: "openai/gpt-5.6-luna",
  reasoningEffort: "max",
  runtimeProfile: "all-enabled",
  effectiveFeatureHash: "238202ebcc848449",
  publicToolCount: 22,
  gatewayUrl: "http://127.0.0.1:18102",
  reusedFrozenRuntime: {
    source: phase4Root,
    runtimeManifestSha256: sha(join(phase4Root, "runtime-manifest.json")),
    registryProbeSha256: sha(join(phase4Root, "registry-probe.json")),
    gatewayCatalogSha256: runtime.gatewayCatalogSha256,
    artifactInputSha256: "428bd8df7313b159988405ae5e3be6d363993d73f7ffc2adedfdc1d496508191",
  },
  credentialsPresent: { OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY) },
  runtimeArtifacts: phase4Env.runtimeArtifacts,
};
writeFileSync(join(root, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);
console.log(JSON.stringify(environment));
