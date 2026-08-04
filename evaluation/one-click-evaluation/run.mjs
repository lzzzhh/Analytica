#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER_ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_NAME = "phase6-graph-retest-3ce87745";
const OLD_REPO = "/Users/zhanhuilin/Documents/Analytica";
const OLD_WORKTREE = "/tmp/analytica-phase6-3ce87745/checkout";
const OLD_COMMIT = "3ce87745f9b1546a10ab7fd015dc543eec8bc7ba";
const OLD_SCENARIO_COMMIT = "92cb4346ac5f0b4edc3eefcdcb81978e570fd220";
const OLD_DESIGN_HASH = "9fb3762703b5c4c6b2fb3dfffe3bbd8773e0c5be81d748c3df7131a947483583";
const DEFAULT_PORT = 18101;
let activeCommand = null;
const TEMPLATE_FILES = [
  "freeze-design.mjs",
  "capture-environment.mjs",
  "run-pipeline-wrapper.py",
  "run-agent-suites.mjs",
  "setup-tool-runtime.py",
  "prepare-tool-suite.mjs",
  "register-tool-inputs.mjs",
  "run-tool-suite.mjs",
  "score-tool-suite.mjs",
  "run-global-suite.mjs",
  "score-global-suite.mjs",
  "run-graph-e2e.mjs",
  "score-latency.mjs",
  "score-tokens.mjs",
  "build-summary.mjs",
  "build-evidence-manifest.mjs",
];

function usage() {
  return `Usage: evaluation/run-full-evaluation.sh [options]

Options:
  --dry-run             Print the frozen execution plan without creating files or calling models.
  --preflight           Validate dependencies, isolated worktree setup and generated runner syntax only.
  --output <directory>  Write evidence to this new directory.
  --python <executable> Python with PyIceberg, PySpark, pytest and gateway dependencies.
  --gateway-port <port> Local Lakehouse Gateway port (default: ${DEFAULT_PORT}).
  --keep-worktree       Preserve the temporary detached worktree for debugging.
  --help                Show this help.

The full run uses openai/gpt-5.6-luna with max reasoning and can take more than one hour.
`;
}

function parseArgs(argv) {
  const options = { dryRun: false, preflight: false, output: null, python: null, gatewayPort: DEFAULT_PORT, keepWorktree: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--preflight") options.preflight = true;
    else if (argument === "--keep-worktree") options.keepWorktree = true;
    else if (argument === "--help") options.help = true;
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--python") options.python = argv[++index];
    else if (argument === "--gateway-port") options.gatewayPort = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.output === undefined || options.python === undefined) throw new Error("option value is missing");
  if (!Number.isInteger(options.gatewayPort) || options.gatewayPort < 1024 || options.gatewayPort > 65535) {
    throw new Error("--gateway-port must be an integer from 1024 to 65535");
  }
  return options;
}

function commandOutput(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function findPython(requested) {
  const candidates = [requested, "/opt/anaconda3/bin/python", "/opt/anaconda3/bin/python3", "python3"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("no usable Python interpreter found; pass --python explicitly");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function assertNewOutput(path) {
  if (existsSync(path)) throw new Error(`output directory already exists: ${path}`);
}

function transformTemplate(source, name, bindings) {
  let output = source
    .replaceAll(OLD_REPO, bindings.repo)
    .replaceAll(OLD_WORKTREE, bindings.worktree)
    .replaceAll(OLD_COMMIT, bindings.commit)
    .replaceAll("http://127.0.0.1:18101", `http://127.0.0.1:${bindings.gatewayPort}`)
    .replaceAll("18101", String(bindings.gatewayPort));

  if (name === "freeze-design.mjs" || name === "capture-environment.mjs") {
    output = output.replace(
      'const repo = resolve(import.meta.dirname, "../..");',
      `const repo = ${JSON.stringify(bindings.repo)};`,
    );
  }
  if (name === "setup-tool-runtime.py") {
    output = output.replace(
      'code = SOURCE.read_text(encoding="utf-8")',
      `code = SOURCE.read_text(encoding="utf-8")\ncode = code.replace(${JSON.stringify(OLD_SCENARIO_COMMIT)}, ${JSON.stringify(bindings.commit)})`,
    );
  }
  if (name === "prepare-tool-suite.mjs") {
    output = output.replace(
      'let code = readFileSync(join(oldRoot, sourceName), "utf8");',
      `let code = readFileSync(join(oldRoot, sourceName), "utf8");\n  code = code.replaceAll(${JSON.stringify(OLD_SCENARIO_COMMIT)}, ${JSON.stringify(bindings.commit)});`,
    );
  }
  if (name === "run-tool-suite.mjs") {
    output = output.replaceAll(OLD_DESIGN_HASH, bindings.designHash);
    output = output.replace(
      'let code = readFileSync(source, "utf8");',
      `let code = readFileSync(source, "utf8");\ncode = code.replaceAll("http://127.0.0.1:18101", ${JSON.stringify(`http://127.0.0.1:${bindings.gatewayPort}`)});`,
    );
  }
  if (name === "build-summary.mjs") {
    const baseline = join(bindings.repo, "evaluation/phase5-missing-metrics-92cb4346/coverage-matrix.json");
    output = output.replace(
      'const old = read("../phase5-missing-metrics-92cb4346/coverage-matrix.json");',
      `const old = JSON.parse(readFileSync(${JSON.stringify(baseline)}, "utf8"));`,
    );
  }
  if (name === "score-tokens.mjs") {
    output = output.replace(
      '["E2E-GRAPH-01", "FAIL"],',
      `["E2E-GRAPH-01", (() => {
    const graph = json(join(root, "graph-e2e/result.json"));
    const call = graph.toolCalls.find((item) => item.name === "run_analysis_graph");
    return graph.exitCode === 0 && call?.result?.details?.status === "COMPLETED" ? "PASS" : "FAIL";
  })()],`,
    );
    output = output.replace(
      'tasks.push({ id: "E2E-GRAPH-01", suite: "graph", slice: "graph_formal_delivery", status: "FAIL", usage:',
      'tasks.push({ id: "E2E-GRAPH-01", suite: "graph", slice: "graph_formal_delivery", status: statusById.get("E2E-GRAPH-01"), usage:',
    );
  }
  return output;
}

function writeRunTemplates(templateRoot, outputRoot, bindings) {
  for (const name of TEMPLATE_FILES) {
    const sourcePath = join(templateRoot, name);
    if (!existsSync(sourcePath)) throw new Error(`missing evaluation template: ${sourcePath}`);
    const transformed = transformTemplate(readFileSync(sourcePath, "utf8"), name, bindings);
    writeFileSync(join(outputRoot, name), transformed);
  }
}

function createWorktree(repo, commit) {
  const root = mkdtempSync(join(tmpdir(), "analytica-eval-"));
  const checkout = join(root, "checkout");
  try {
    commandOutput("git", ["worktree", "add", "--detach", checkout, commit], repo);
    const nodeModules = join(repo, "node_modules");
    const dist = join(repo, "packages/coding-agent/dist");
    if (!existsSync(nodeModules)) throw new Error("node_modules is missing; hydrate dependencies before evaluation");
    if (!existsSync(join(dist, "cli.js")) || !existsSync(join(dist, "rpc-entry.js"))) {
      throw new Error("packages/coding-agent/dist is missing cli.js or rpc-entry.js");
    }
    if (!existsSync(join(checkout, "node_modules"))) symlinkSync(nodeModules, join(checkout, "node_modules"));
    if (!existsSync(join(checkout, "packages/coding-agent/dist"))) symlinkSync(dist, join(checkout, "packages/coding-agent/dist"));
    return { root, checkout };
  } catch (error) {
    spawnSync("git", ["worktree", "remove", "--force", checkout], { cwd: repo, encoding: "utf8" });
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function safeCleanupWorktree(repo, worktree, keep) {
  if (!worktree || keep) return;
  const expectedPrefix = `${resolve(tmpdir())}/analytica-eval-`;
  if (!resolve(worktree.root).startsWith(expectedPrefix) || basename(worktree.checkout) !== "checkout") {
    throw new Error(`refusing to clean unexpected worktree path: ${worktree.root}`);
  }
  spawnSync("git", ["worktree", "remove", "--force", worktree.checkout], { cwd: repo, encoding: "utf8" });
  rmSync(worktree.root, { recursive: true, force: true });
}

function writeState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function publicCommand(command, args) {
  return [command, ...args].join(" ");
}

async function runCommand(stage, command, args, options, state) {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const logPath = join(options.logs, `${stage}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  process.stdout.write(`[${stage}] ${publicCommand(command, args)}\n`);
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  activeCommand = child;
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const result = await new Promise((resolveResult) => {
    child.on("error", (error) => resolveResult({ code: null, signal: null, error: error.message }));
    child.on("close", (code, signal) => resolveResult({ code, signal, error: null }));
  });
  activeCommand = null;
  log.end();
  const record = {
    stage,
    command: publicCommand(command, args),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    exitCode: result.code,
    signal: result.signal,
    status: result.code === 0 ? "PASS" : "INFRA_ERROR",
    error: result.error,
    log: `logs/${stage}.log`,
  };
  state.stages.push(record);
  writeState(options.statePath, state);
  if (record.status !== "PASS") throw new Error(`${stage} failed; see ${logPath}`);
}

async function waitForGateway(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Lakehouse Gateway exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Lakehouse Gateway did not become healthy on port ${port}`);
}

function startGateway(python, worktree, outputRoot, port) {
  const service = join(worktree, "packages/coding-agent/examples/extensions/multimodal-artifact-poc/services/lakehouse-gateway");
  const runtime = join(outputRoot, "tool-calling/runtime");
  const log = createWriteStream(join(outputRoot, "logs/gateway.log"), { flags: "a" });
  const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: service,
    env: {
      ...process.env,
      FEATURE_RUNTIME_PROFILE: "all-enabled",
      LAKEHOUSE_MODE: "local",
      LAKEHOUSE_WAREHOUSE_PATH: join(runtime, "gateway-warehouse"),
      LAKEHOUSE_GATEWAY_URL: `http://127.0.0.1:${port}`,
      LAKEHOUSE_AUDIT_LOG: join(runtime, "gateway-audit.log"),
      DATA_ANALYSIS_ARTIFACT_ROOT: join(runtime, "home/.pi/artifacts/data-analysis"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once("close", () => log.end());
  return child;
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveWait) => child.once("close", resolveWait)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function validatePreflight(repo, python, templateRoot) {
  const checks = [
    [existsSync(templateRoot), `template directory: ${templateRoot}`],
    [existsSync(join(repo, "evaluation/phase2-retest/run_blind_retest.py")), "Pipeline harness"],
    [existsSync(join(repo, "evaluation/phase3-agent-evaluation/run_data_analysis.mts")), "Agent harness"],
    [existsSync(join(repo, "evaluation/phase4-tool-calling-92cb4346/run-cases.mjs")), "tool harness"],
    [existsSync(join(repo, "evaluation/phase5-missing-metrics-92cb4346/run-suite.mjs")), "global harness"],
  ];
  const missing = checks.filter(([present]) => !present).map(([, label]) => label);
  if (missing.length) throw new Error(`missing evaluation dependencies: ${missing.join(", ")}`);
  const imports = ["pyiceberg", "pyspark", "pytest", "fastapi", "uvicorn", "pyarrow", "pandas", "jsonschema"];
  const probe = spawnSync(python, ["-c", `import ${imports.join(",")}`], { cwd: repo, encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`Python dependency preflight failed: ${probe.stderr || probe.stdout}`);
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required because model suites use an isolated HOME");
}

function validateGeneratedRunners(repo, commit, python, templateRoot, gatewayPort) {
  const worktree = createWorktree(repo, commit);
  const generatedRoot = mkdtempSync(join(tmpdir(), "analytica-eval-generated-"));
  try {
    writeRunTemplates(templateRoot, generatedRoot, {
      repo,
      worktree: worktree.checkout,
      commit,
      gatewayPort,
      designHash: "preflight-design-hash",
    });
    for (const name of TEMPLATE_FILES.filter((item) => item.endsWith(".mjs"))) {
      commandOutput(process.execPath, ["--check", join(generatedRoot, name)], generatedRoot);
    }
    for (const name of TEMPLATE_FILES.filter((item) => item.endsWith(".py"))) {
      commandOutput(python, ["-m", "py_compile", join(generatedRoot, name)], generatedRoot);
    }
    const stale = TEMPLATE_FILES.flatMap((name) => {
      const text = readFileSync(join(generatedRoot, name), "utf8");
      return [
        ["worktree", OLD_WORKTREE],
        ...(commit === OLD_COMMIT ? [] : [["commit", OLD_COMMIT]]),
        ["designHash", OLD_DESIGN_HASH],
      ].filter(([, value]) => text.includes(value)).map(([binding]) => `${name}:${binding}`);
    });
    if (stale.length) {
      throw new Error(`generated runners retain stale bindings: ${stale.join(", ")}`);
    }
  } finally {
    safeCleanupWorktree(repo, worktree, false);
    rmSync(generatedRoot, { recursive: true, force: true });
  }
}

function writeSummary(outputRoot, state) {
  const matrixPath = join(outputRoot, "coverage-matrix.json");
  if (!existsSync(matrixPath)) return;
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  const metric = (name) => matrix.metrics.find((item) => item.metric === name);
  const percent = (name) => {
    const value = metric(name)?.value;
    return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "ABSTAIN";
  };
  const latency = metric("Average Successful End-to-End Task Completion Time");
  const tokens = metric("Average Observable Task Token Usage");
  const text = `# Analytica Evaluation Summary

- Commit: \`${state.commit}\`
- Run status: \`${state.status}\`
- Task Success Rate: **${percent("Task Success Rate")}**
- Consistency@3: **${percent("Consistency@3")}**
- Workflow Task Success Rate: **${percent("Workflow Task Success Rate")}**
- Analysis Task Success Rate: **${percent("Analysis Task Success Rate")}**
- Average successful E2E time: **${Number.isFinite(latency?.value) ? `${(latency.value / 1000).toFixed(3)} s` : "ABSTAIN"}**
- Average observable successful-task tokens: **${Number.isFinite(tokens?.value) ? tokens.value.toFixed(1) : "ABSTAIN"}**

Full-system token usage remains ABSTAIN when internal subagent usage is not observable.
`;
  writeFileSync(join(outputRoot, "summary.md"), text);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const repo = commandOutput("git", ["rev-parse", "--show-toplevel"], DRIVER_ROOT);
  const commit = commandOutput("git", ["rev-parse", "HEAD"], repo);
  const shortCommit = commit.slice(0, 10);
  const python = findPython(options.python);
  const templateRoot = join(repo, "evaluation", TEMPLATE_NAME);
  const outputRoot = resolve(options.output ?? join(repo, "evaluation/runs", `${timestamp()}-${shortCommit}`));
  const plan = {
    commit,
    outputRoot,
    python,
    node: process.execPath,
    model: "openai/gpt-5.6-luna",
    reasoningEffort: "max",
    gatewayPort: options.gatewayPort,
    stages: ["freeze", "pipeline", "tool_setup", "agents", "tool_calling", "global", "graph", "score"],
  };
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  if (options.preflight) {
    validatePreflight(repo, python, templateRoot);
    validateGeneratedRunners(repo, commit, python, templateRoot, options.gatewayPort);
    process.stdout.write("PRECHECK_PASS\n");
    return;
  }

  assertNewOutput(outputRoot);
  validatePreflight(repo, python, templateRoot);
  mkdirSync(join(outputRoot, "logs"), { recursive: true });
  const statePath = join(outputRoot, "run-state.json");
  const state = {
    schemaVersion: "1.0",
    commit,
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outputRoot,
    model: plan.model,
    reasoningEffort: plan.reasoningEffort,
    python,
    node: process.execPath,
    stages: [],
  };
  writeState(statePath, state);
  let worktree = null;
  let gateway = null;
  let handlingSignal = false;
  const handleSignal = async (signal) => {
    if (handlingSignal) return;
    handlingSignal = true;
    state.status = "INFRA_ERROR";
    state.finishedAt = new Date().toISOString();
    state.error = `interrupted by ${signal}`;
    writeState(statePath, state);
    await stopGateway(activeCommand);
    await stopGateway(gateway);
    try {
      safeCleanupWorktree(repo, worktree, options.keepWorktree);
    } catch (error) {
      process.stderr.write(`cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = () => void handleSignal("SIGINT");
  const onSigterm = () => void handleSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    worktree = createWorktree(repo, commit);
    state.infrastructure = {
      worktree: worktree.checkout,
      worktreeCommand: `git worktree add --detach ${worktree.checkout} ${commit}`,
      gatewayCommand: `${python} -m uvicorn app.main:app --host 127.0.0.1 --port ${options.gatewayPort}`,
    };
    writeState(statePath, state);
    const initialBindings = { repo, worktree: worktree.checkout, commit, gatewayPort: options.gatewayPort, designHash: OLD_DESIGN_HASH };
    writeRunTemplates(templateRoot, outputRoot, initialBindings);
    const commandOptions = { cwd: outputRoot, logs: join(outputRoot, "logs"), statePath };

    await runCommand("freeze_design", process.execPath, [join(outputRoot, "freeze-design.mjs")], commandOptions, state);
    const design = JSON.parse(readFileSync(join(outputRoot, "design-manifest.json"), "utf8"));
    writeRunTemplates(templateRoot, outputRoot, { ...initialBindings, designHash: design.combinedSha256 });
    await runCommand("capture_environment", process.execPath, [join(outputRoot, "capture-environment.mjs")], commandOptions, state);
    await runCommand("pipeline", python, [join(outputRoot, "run-pipeline-wrapper.py")], commandOptions, state);
    await runCommand("tool_runtime", python, [join(outputRoot, "setup-tool-runtime.py")], commandOptions, state);
    await runCommand("tool_scenarios", process.execPath, [join(outputRoot, "prepare-tool-suite.mjs")], commandOptions, state);
    await runCommand("tool_inputs", process.execPath, ["--experimental-strip-types", join(outputRoot, "register-tool-inputs.mjs")], commandOptions, state);
    await runCommand("agents", process.execPath, [join(outputRoot, "run-agent-suites.mjs")], commandOptions, state);

    gateway = startGateway(python, worktree.checkout, outputRoot, options.gatewayPort);
    await waitForGateway(options.gatewayPort, gateway);
    await runCommand("tool_calling", process.execPath, [join(outputRoot, "run-tool-suite.mjs")], commandOptions, state);
    await runCommand("tool_scoring", process.execPath, [join(outputRoot, "score-tool-suite.mjs")], commandOptions, state);
    await runCommand("global", process.execPath, [join(outputRoot, "run-global-suite.mjs")], commandOptions, state);
    await runCommand("global_scoring", process.execPath, [join(outputRoot, "score-global-suite.mjs")], commandOptions, state);
    await stopGateway(gateway);
    gateway = null;

    await runCommand("graph_e2e", process.execPath, ["--experimental-strip-types", join(outputRoot, "run-graph-e2e.mjs")], commandOptions, state);
    await runCommand("latency", process.execPath, [join(outputRoot, "score-latency.mjs")], commandOptions, state);
    await runCommand("tokens", process.execPath, [join(outputRoot, "score-tokens.mjs")], commandOptions, state);
    await runCommand("summary", process.execPath, [join(outputRoot, "build-summary.mjs")], commandOptions, state);
    state.status = "COMPLETED";
    state.finishedAt = new Date().toISOString();
    writeState(statePath, state);
    writeSummary(outputRoot, state);
    await runCommand("evidence_manifest", process.execPath, [join(outputRoot, "build-evidence-manifest.mjs")], commandOptions, state);
    commandOutput(process.execPath, [join(outputRoot, "build-evidence-manifest.mjs")], outputRoot);
    process.stdout.write(`Evaluation complete: ${outputRoot}\n`);
  } catch (error) {
    state.status = "INFRA_ERROR";
    state.finishedAt = new Date().toISOString();
    state.error = error instanceof Error ? error.message : String(error);
    writeState(statePath, state);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await stopGateway(gateway);
    safeCleanupWorktree(repo, worktree, options.keepWorktree);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
