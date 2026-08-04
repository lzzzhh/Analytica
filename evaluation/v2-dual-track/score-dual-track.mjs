#!/usr/bin/env node
// V2 dual-track scoring for the frozen phase4 tool-calling suite.
//
// Does NOT modify or overwrite the frozen golden cases or the original
// score-results.mjs output. Recomputes an additional "business" track from
// the existing evidence (scores.json, results-normalized, raw traces) of a
// completed run, and keeps the original strict track untouched.
//
// Tracks:
//   strict:   identical to frozen score-results.mjs (exact contract conformance)
//   business: task success under verified relaxations:
//     - contentHash leaf errors are exempted only when the hash value is
//       verifiable (it appears in the case raw trace or runtime manifest);
//       wrong or fabricated hashes remain failures.
//     - alias leaf errors are exempted when the golden alias is not consumed
//       downstream (the expected alias value does not appear as an argument
//       value of a later observed call); alias mismatches that break a
//       downstream column reference remain failures.
//     - extra leaf fields without side effects are exempted; unexpected whole
//       calls and missing calls remain failures.
//     - tool selection, forbidden calls, dependencies, results and runtime
//       checks are unchanged from the strict track.
//
// Usage:
//   node evaluation/v2-dual-track/score-dual-track.mjs [--run <run-directory>]
// Default run directory: the newest evaluation/runs/* with tool-calling/scores.json.
// Output: <run>/tool-calling/scores-dual-track.json and a comparison table.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zhName } from "./metric-names-zh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function parseArgs(argv) {
  let runDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run") runDir = argv[++index];
    else if (argv[index] === "--help") {
      process.stdout.write("Usage: score-dual-track.mjs [--run <run-directory>]\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (runDir) return resolve(runDir);
  const runsRoot = join(repoRoot, "evaluation/runs");
  const candidates = readdirSync(runsRoot)
    .map((name) => join(runsRoot, name))
    .filter((path) => existsSync(join(path, "tool-calling/scores.json")))
    .sort();
  if (candidates.length === 0) throw new Error(`no completed tool-calling run under ${runsRoot}`);
  return candidates[candidates.length - 1];
}

// Classify one frozen-scorer argument error string.
function classifyError(error) {
  if (error.includes("unexpected call arguments") || error.includes("missing call")) return "structure";
  if (error.includes("contentHash")) return "hash";
  const pointer = error.split(":")[0];
  if (pointer.includes("/alias") || pointer.endsWith("alias")) return "alias";
  if (error.includes("unexpected")) return "extra";
  return "wrong";
}

// Extract expected/got values from an error string, e.g.
// 'tool/ptr: expected "a", got "b"' -> expected "a", got "b" ;
// 'tool/ptr: unexpected 50' -> got 50.
function parseErrorValues(error) {
  const expected = /expected (.+?), got/.exec(error)?.[1];
  const got = /got (.+)$/.exec(error)?.[1];
  const unexpected = /unexpected (.+)$/.exec(error)?.[1];
  const parse = (raw) => {
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  return { expected: parse(expected), got: parse(got ?? unexpected) };
}

// Collect every sha256-shaped string in the case trace or runtime manifest.
// A passed contentHash is "verifiable" iff it is in this set.
function collectVerifiableHashes(runDir, caseId) {
  const hashes = new Set();
  const pattern = /[0-9a-f]{64}/g;
  const sources = [join(runDir, "tool-calling/raw-traces", `${caseId}.jsonl`)];
  const manifestPath = join(runDir, "tool-calling/runtime-manifest.json");
  if (existsSync(manifestPath)) sources.push(manifestPath);
  for (const source of sources) {
    if (!existsSync(source)) continue;
    const text = readFileSync(source, "utf8");
    for (const match of text.match(pattern) ?? []) hashes.add(match);
  }
  return hashes;
}

// The golden alias must not be consumed downstream: the expected alias value
// must not appear as an argument value of any later observed call.
function aliasConsumedDownstream(expectedAlias, normalizedCalls, callIndex) {
  if (typeof expectedAlias !== "string") return false;
  const laterCalls = normalizedCalls.slice(callIndex + 1);
  const seen = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      seen.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) walk(value[key]);
    }
  };
  for (const call of laterCalls) walk(call.args ?? {});
  return seen.has(expectedAlias);
}

// Map each argument error to the observed call index it belongs to, using the
// tool-name occurrence order (matches the frozen scorer's greedy best-match).
function assignErrorsToCalls(errors, normalizedCalls) {
  const usedCounts = new Map();
  return errors.map((error) => {
    const toolName = error.split(/[/:]/)[0];
    const occurrences = normalizedCalls
      .map((call, index) => ({ call, index }))
      .filter((entry) => entry.call.name === toolName);
    const consumed = usedCounts.get(toolName) ?? 0;
    usedCounts.set(toolName, consumed + 1);
    const entry = occurrences[consumed] ?? occurrences[occurrences.length - 1];
    return entry ? entry.index : -1;
  });
}

function main() {
  const runDir = parseArgs(process.argv.slice(2));
  const frozen = JSON.parse(readFileSync(join(runDir, "tool-calling/scores.json"), "utf8"));
  const cases = [];
  let strictArgCorrect = 0;
  let strictArgTotal = 0;
  let businessArgCorrect = 0;
  let businessArgTotal = 0;
  const deviationLedger = [];

  for (const item of frozen.casesDetail) {
    const normalized = JSON.parse(
      readFileSync(join(runDir, "tool-calling/results-normalized", `${item.caseId}.json`), "utf8"),
    );
    const hashes = collectVerifiableHashes(runDir, item.caseId);
    const callIndexOf = assignErrorsToCalls(item.arguments.errors, normalized.toolCalls);

    let exemptedLeaves = 0;
    const residualErrors = [];
    item.arguments.errors.forEach((error, position) => {
      const kind = classifyError(error);
      const { expected, got } = parseErrorValues(error);
      let exempt = false;
      let reason = null;
      if (kind === "hash") {
        const value = typeof got === "string" ? got : expected;
        if (typeof value === "string" && hashes.has(value)) {
          exempt = true;
          reason = "contentHash verified against trace/runtime manifest";
        } else {
          reason = "contentHash not verifiable (wrong or fabricated)";
        }
      } else if (kind === "alias") {
        const callIndex = callIndexOf[position];
        if (!aliasConsumedDownstream(expected, normalized.toolCalls, callIndex)) {
          exempt = true;
          reason = "alias only renames output; not consumed downstream";
        } else {
          reason = "golden alias is consumed by a downstream call";
        }
      } else if (kind === "extra") {
        exempt = true;
        reason = "extra leaf field without side effect";
      }
      if (exempt) {
        exemptedLeaves += 1;
        deviationLedger.push({ caseId: item.caseId, kind, error, reason });
      } else {
        residualErrors.push(error);
      }
    });

    const businessArgsPass = residualErrors.length === 0;
    const dependenciesPass = item.dependencies.correct === item.dependencies.total;
    const businessStatus =
      item.exactTools && item.forbiddenCalls.length === 0 && dependenciesPass && item.resultsPass && businessArgsPass
        ? "PASS"
        : "FAIL";

    strictArgCorrect += item.arguments.correct;
    strictArgTotal += item.arguments.correct + item.arguments.incorrect;
    businessArgCorrect += item.arguments.correct + exemptedLeaves;
    businessArgTotal += item.arguments.correct + item.arguments.incorrect;

    cases.push({
      caseId: item.caseId,
      layer: item.layer,
      strictStatus: item.status,
      businessStatus,
      exemptedLeaves,
      residualErrors,
      resultFailure: item.resultFailure,
    });
  }

  const rate = (layer, track) => {
    const selected = cases.filter((item) => item.layer === layer);
    const pass = selected.filter((item) => item[track] === "PASS").length;
    return { pass, total: selected.length, value: selected.length === 0 ? null : pass / selected.length };
  };

  const output = {
    schemaVersion: "1.0",
    frozenCommit: frozen.frozenCommit,
    sourceRun: runDir,
    policy: {
      contentHash: "exempt only when verifiable against trace/runtime manifest",
      alias: "exempt only when the golden alias is not consumed downstream",
      extraLeaf: "exempt side-effect-free extra leaf fields",
      unchanged: ["tool selection", "forbidden tools", "dependencies", "results", "runtime"],
    },
    metrics: {
      strict: {
        singleToolTaskSuccessRate: { nameZh: zhName("Single-Tool Task Success Rate"), ...rate("single_tool", "strictStatus") },
        multiToolTaskSuccessRate: { nameZh: zhName("Multi-Tool Task Success Rate"), ...rate("multi_tool", "strictStatus") },
        workflowSuccessRate: { nameZh: zhName("Workflow Task Success Rate"), ...rate("workflow", "strictStatus") },
        argumentAccuracy: { nameZh: zhName("Argument Accuracy"), correct: strictArgCorrect, total: strictArgTotal, value: strictArgCorrect / strictArgTotal },
      },
      business: {
        singleToolTaskSuccessRate: { nameZh: zhName("Business Single-Tool Success"), ...rate("single_tool", "businessStatus") },
        multiToolTaskSuccessRate: { nameZh: zhName("Business Multi-Tool Success"), ...rate("multi_tool", "businessStatus") },
        workflowSuccessRate: { nameZh: zhName("Business Workflow Success"), ...rate("workflow", "businessStatus") },
        argumentAccuracy: { nameZh: zhName("Business Argument Accuracy"), correct: businessArgCorrect, total: businessArgTotal, value: businessArgCorrect / businessArgTotal },
        contractDeviationRate: {
          nameZh: zhName("Contract Deviation Rate"),
          exemptedLeaves: deviationLedger.length,
          totalLeaves: strictArgTotal,
          value: deviationLedger.length / strictArgTotal,
        },
      },
    },
    deviationLedger,
    cases,
  };

  const outPath = join(runDir, "tool-calling/scores-dual-track.json");
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);

  const pct = (metric) => (metric.total === 0 ? "-" : `${((metric.pass / metric.total) * 100).toFixed(2)}% (${metric.pass}/${metric.total})`);
  const acc = (metric) => `${(metric.value * 100).toFixed(2)}%`;
  const rows = [
    [zhName("Single-Tool Task Success Rate"), pct(output.metrics.strict.singleToolTaskSuccessRate), pct(output.metrics.business.singleToolTaskSuccessRate)],
    [zhName("Multi-Tool Task Success Rate"), pct(output.metrics.strict.multiToolTaskSuccessRate), pct(output.metrics.business.multiToolTaskSuccessRate)],
    [zhName("Workflow Task Success Rate"), pct(output.metrics.strict.workflowSuccessRate), pct(output.metrics.business.workflowSuccessRate)],
    [zhName("Argument Accuracy"), acc(output.metrics.strict.argumentAccuracy), acc(output.metrics.business.argumentAccuracy)],
  ];
  process.stdout.write("双轨评分（V2）\n");
  process.stdout.write(`评测目录: ${runDir}\n`);
  process.stdout.write(`${"指标".padEnd(20)}${"严格契约轨".padEnd(18)}业务任务轨\n`);
  for (const [name, strict, business] of rows) {
    process.stdout.write(`${name.padEnd(20)}${strict.padEnd(18)}${business}\n`);
  }
  const deviation = output.metrics.business.contractDeviationRate;
  process.stdout.write(`${zhName("Contract Deviation Rate")}: ${deviation.exemptedLeaves}/${deviation.totalLeaves} 个叶子字段 = ${(deviation.value * 100).toFixed(2)}%\n`);
  process.stdout.write(`已写入: ${outPath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
