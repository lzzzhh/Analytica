import fs from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const layers = ["single-tool", "multi-tool", "workflow"];
const cases = layers.flatMap((name) => JSON.parse(fs.readFileSync(path.join(root, "resolved-scenarios", `${name}.json`), "utf8")).cases);

function counts(values) {
  const out = new Map();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function multisetScore(expected, observed) {
  const e = counts(expected);
  const o = counts(observed);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const name of new Set([...e.keys(), ...o.keys()])) {
    tp += Math.min(e.get(name) ?? 0, o.get(name) ?? 0);
    fp += Math.max(0, (o.get(name) ?? 0) - (e.get(name) ?? 0));
    fn += Math.max(0, (e.get(name) ?? 0) - (o.get(name) ?? 0));
  }
  return { tp, fp, fn, f1: (2 * tp) / (2 * tp + fp + fn || 1), expected };
}

function leaves(value, prefix = "") {
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, `${prefix}/${index}`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => leaves(item, `${prefix}/${key}`));
  return [{ pointer: prefix || "/", value }];
}

function inputPath(caseDef, index) {
  const artifact = caseDef.inputArtifacts[index];
  return artifact?.path ?? artifact?.localPath;
}

function resultDetails(call) {
  return call?.result?.details ?? {};
}

function resolveExpected(value, caseDef, observed) {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  if (value.startsWith("$input[")) return inputPath(caseDef, Number(value.match(/\[(\d+)\]/)?.[1] ?? 0));
  if (value === "$search.bestDatasetId") return "ads.ads_sales_daily";
  if (value === "$validate.validatedQueryId") return resultDetails(observed.find((call) => call.name === "validate_query")).validatedQueryId;
  if (value === "$materialize.artifactId") return resultDetails(observed.find((call) => call.name === "materialize_query")).artifactId;
  if (value === "$materialize.queryId") return resultDetails(observed.find((call) => call.name === "materialize_query")).queryId;
  if (value === "$materialize.contentHash") return resultDetails(observed.find((call) => call.name === "materialize_query")).contentHash;
  if (value === "$analysis.artifactId") return resultDetails(observed.find((call) => call.name === "run_data_analysis" && resultDetails(call).status === "COMPLETED")).artifactId;
  if (value === "$review.reviewId") return resultDetails(observed.find((call) => call.name === "review_data_analysis")).reviewId;
  if (value === "$review.gateDecisionId") return resultDetails(observed.find((call) => call.name === "review_data_analysis")).gateDecisionId;
  return value;
}

function semanticMatch(caseId, expected, actual) {
  if (typeof actual !== "string") return false;
  const text = actual.toLowerCase();
  if (caseId === "MT-06") return /red|红/.test(text) && /white|白/.test(text);
  if (caseId === "WF-02") return /pearson/.test(text) && /alcohol/.test(text) && /quality/.test(text) && !/caus(e|al)/.test(text.replace(/without causal|不得.*因果/g, ""));
  if (caseId === "WF-04") return /revenue/.test(text) && /trend|趋势/.test(text) && /event_date/.test(text);
  if (caseId === "WF-07") return /artifact|产物/.test(text);
  if (caseId === "WF-08") return /trend|趋势/.test(text);
  return expected === actual;
}

function isDefaultEquivalent(tool, pointer, value) {
  return tool === "validate_query" && pointer === "/limit" && value === 100
    || tool === "assess_training_data" && pointer === "/purpose" && value === "model_training";
}

function scoreArgs(caseDef, observed, expectedSet) {
  const expectedByName = new Map();
  for (const name of new Set(expectedSet)) {
    const spec = caseDef.expectedArguments[name];
    const queue = expectedByName.get(name) ?? [];
    if (Array.isArray(spec) && expectedSet.filter((item) => item === name).length > 1) queue.push(...spec);
    else queue.push(spec ?? {});
    expectedByName.set(name, queue);
  }
  let correct = 0;
  let incorrect = 0;
  const errors = [];
  const used = new Set();
  for (const [name, specs] of expectedByName) {
    const candidates = observed.map((call, index) => ({ call, index })).filter((entry) => entry.call.name === name);
    for (const spec of specs) {
      let best = null;
      for (const candidate of candidates.filter((entry) => !used.has(entry.index))) {
        const expectedLeaves = leaves(spec);
        const actualLeaves = leaves(candidate.call.args ?? {});
        let c = 0;
        let i = 0;
        const localErrors = [];
        for (const expectedLeaf of expectedLeaves) {
          const actualLeaf = actualLeaves.find((leaf) => leaf.pointer === expectedLeaf.pointer);
          const resolved = resolveExpected(expectedLeaf.value, caseDef, observed);
          const ok = String(expectedLeaf.value).startsWith("$semantic:")
            ? semanticMatch(caseDef.caseId, expectedLeaf.value, actualLeaf?.value)
            : JSON.stringify(actualLeaf?.value) === JSON.stringify(resolved);
          if (ok) c += 1;
          else {
            i += 1;
            localErrors.push(`${name}${expectedLeaf.pointer}: expected ${JSON.stringify(resolved)}, got ${JSON.stringify(actualLeaf?.value)}`);
          }
        }
        for (const actualLeaf of actualLeaves) {
          if (!expectedLeaves.some((leaf) => leaf.pointer === actualLeaf.pointer) && !isDefaultEquivalent(name, actualLeaf.pointer, actualLeaf.value)) {
            i += 1;
            localErrors.push(`${name}${actualLeaf.pointer}: unexpected ${JSON.stringify(actualLeaf.value)}`);
          }
        }
        if (!best || c - i > best.correct - best.incorrect) best = { ...candidate, correct: c, incorrect: i, errors: localErrors };
      }
      if (!best) {
        const missing = leaves(spec).length;
        incorrect += missing;
        errors.push(`${name}: missing call (${missing} expected leaf fields)`);
      } else {
        used.add(best.index);
        correct += best.correct;
        incorrect += best.incorrect;
        errors.push(...best.errors);
      }
    }
  }
  for (const [index, call] of observed.entries()) {
    if (used.has(index)) continue;
    const extra = leaves(call.args ?? {}).length;
    incorrect += extra;
    errors.push(`${call.name}: unexpected call arguments (${extra} leaf fields)`);
  }
  return { correct, incorrect, errors };
}

const resultFailures = {
  "MT-11": "discovery did not reach dataset inspection",
  "MT-12": "approved target was falsely reported BLOCKED and dry-run was not reached",
  "ST-08": "visual backend returned HTTP 405 after a forbidden parse_image call",
  "WF-02": "analysis required retries and final views omitted SCATTER",
  "WF-04": "Reviewer could not resolve the completed analysis artifact; no promotion decision",
  "WF-05": "review result omitted gateDecisionId, so frozen gate inspection failed",
  "WF-06": "promotion crashed on missing ./review-gate.ts module",
  "WF-07": "missing artifact was sent to Reviewer instead of analysis",
  "WF-08": "failure was SCRIPT_SYNTAX_ERROR rather than the frozen timeout behavior",
  "WF-09": "stored ABSTAIN review was not found and its reason was lost",
};

const dependencyCorrect = {
  "MT-01": 2, "MT-02": 1, "MT-04": 1, "MT-07": 1, "MT-09": 1, "MT-10": 1, "MT-11": 0, "MT-12": 0,
  "ST-05": 1,
  "WF-01": 3, "WF-02": 1, "WF-03": 1, "WF-04": 3, "WF-05": 1, "WF-06": 2, "WF-07": 0, "WF-08": 1,
  "WF-09": 1, "WF-10": 1, "WF-11": 1, "WF-12": 2,
};

const output = [];
let tp = 0;
let fp = 0;
let fn = 0;
let argCorrect = 0;
let argIncorrect = 0;
let edgeCorrect = 0;
let edgeTotal = 0;
for (const caseDef of cases) {
  const observedResult = JSON.parse(fs.readFileSync(path.join(root, "results-normalized", `${caseDef.caseId}.json`), "utf8"));
  const observedNames = observedResult.toolCalls.map((call) => call.name);
  const candidates = caseDef.acceptableToolSets.map((set) => multisetScore(set, observedNames)).sort((a, b) => b.f1 - a.f1);
  const toolScore = candidates[0];
  tp += toolScore.tp;
  fp += toolScore.fp;
  fn += toolScore.fn;
  const argScore = scoreArgs(caseDef, observedResult.toolCalls, toolScore.expected);
  argCorrect += argScore.correct;
  argIncorrect += argScore.incorrect;
  const expectedEdges = caseDef.requiredDependencies.length;
  const correctEdges = dependencyCorrect[caseDef.caseId] ?? 0;
  edgeCorrect += correctEdges;
  edgeTotal += expectedEdges;
  const forbidden = observedNames.filter((name) => caseDef.forbiddenTools.includes(name));
  const exactTools = toolScore.fp === 0 && toolScore.fn === 0;
  const argsPass = argScore.incorrect === 0;
  const dependenciesPass = correctEdges === expectedEdges;
  const resultsPass = !resultFailures[caseDef.caseId];
  const runtimePass = observedResult.exitCode === 0 && !observedResult.timedOut;
  const status = runtimePass && exactTools && forbidden.length === 0 && argsPass && dependenciesPass && resultsPass ? "PASS" : "FAIL";
  output.push({
    caseId: caseDef.caseId,
    layer: caseDef.layer,
    status,
    exactTools,
    toolCounts: { tp: toolScore.tp, fp: toolScore.fp, fn: toolScore.fn },
    arguments: argScore,
    dependencies: { correct: correctEdges, total: expectedEdges },
    resultsPass,
    resultFailure: resultFailures[caseDef.caseId] ?? null,
    forbiddenCalls: forbidden,
    rawTrace: observedResult.rawTrace,
  });
}

function rate(layer) {
  const selected = output.filter((item) => item.layer === layer);
  return { pass: selected.filter((item) => item.status === "PASS").length, total: selected.length };
}

const summary = {
  schemaVersion: "1.0",
  frozenCommit: "92cb4346ac5f0b4edc3eefcdcb81978e570fd220",
  cases: output.length,
  statuses: Object.fromEntries(["PASS", "FAIL", "ABSTAIN", "NOT_RUN", "INFRA_ERROR"].map((status) => [status, output.filter((item) => item.status === status).length])),
  metrics: {
    singleToolTaskSuccessRate: { ...rate("single_tool"), value: rate("single_tool").pass / rate("single_tool").total },
    argumentAccuracy: { correct: argCorrect, total: argCorrect + argIncorrect, value: argCorrect / (argCorrect + argIncorrect) },
    toolSetF1: { tp, fp, fn, value: (2 * tp) / (2 * tp + fp + fn) },
    multiToolTaskSuccessRate: { ...rate("multi_tool"), value: rate("multi_tool").pass / rate("multi_tool").total },
    workflowSuccessRate: { ...rate("workflow"), value: rate("workflow").pass / rate("workflow").total },
    orchestrationAccuracy: { correct: edgeCorrect, total: edgeTotal, value: edgeCorrect / edgeTotal },
  },
  casesDetail: output,
};

fs.writeFileSync(path.join(root, "scores.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary.metrics, null, 2));
