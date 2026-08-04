import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const design = JSON.parse(readFileSync(join(root, "scenarios.json"), "utf8"));
const resultRoot = join(root, "results-normalized");

function equalValue(expected, actual, caseId) {
  if (typeof expected === "string" && expected.startsWith("$semantic:")) {
    const text = String(actual ?? "").toLowerCase();
    if (caseId === "GM-REQ-01") return text.includes("eval_raw.wine_quality") && text.includes("quality") && /30/.test(text);
    if (caseId === "GM-REQ-02") return text.includes("eval_raw.air_quality") && text.includes("-200") && (/只读|read.only/.test(text)) && (/正式报告|formal report/.test(text));
    return false;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (expected.every((item) => typeof item !== "object")) {
      return expected.length === actual.length && expected.every((item) => actual.some((candidate) => equalValue(item, candidate, caseId)));
    }
    return expected.length <= actual.length && expected.every((item, index) => equalValue(item, actual[index], caseId));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) => equalValue(value, actual[key], caseId));
  }
  return Object.is(expected, actual);
}

function resolveDynamic(expected, calls, scenario) {
  const inputMatch = typeof expected === "string" ? expected.match(/^\$input\[(\d+)\]\.path$/) : null;
  if (inputMatch) return scenario.inputArtifacts?.[Number(inputMatch[1])]?.path;
  if (expected !== "$review.gateDecisionId") return expected;
  return calls.find((call) => call.name === "review_data_analysis")?.result?.details?.gateDecisionId;
}

function resolveObject(value, calls, scenario) {
  if (Array.isArray(value)) return value.map((item) => resolveObject(item, calls, scenario));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveObject(item, calls, scenario)]));
  return resolveDynamic(value, calls, scenario);
}

function argsPass(scenario, calls) {
  return Object.entries(scenario.expectedArgs).every(([tool, expected]) => {
    const resolved = resolveObject(expected, calls, scenario);
    return calls.filter((call) => call.name === tool).some((call) => equalValue(resolved, call.args, scenario.caseId));
  });
}

function allNumbers(value, out = []) {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const item of value) allNumbers(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) allNumbers(item, out);
  return out;
}

function formalSuccessClaim(text) {
  const positive = /(?:已正式(?:发布|交付)|正式(?:发布|交付)(?:成功|完成)|publish(?:ed)? successfully|promotion[^\n]{0,20}allowed)/i.test(text);
  const negated = /(?:未|没有|不能|不得|无法|不会|no |not |without ).{0,18}(?:正式(?:发布|交付)|publish|promotion)/i.test(text);
  return positive && !negated;
}

function causalClaim(text) {
  const positive = /(?:导致|造成|引起|因果|caus(?:e|es|ed|al))/i.test(text);
  const negated = /(?:不得|没有|未|不作|不能|no |not |without |never ).{0,15}(?:因果|caus)/i.test(text);
  return positive && !negated;
}

function hallucination(scenario, result) {
  const reasons = [];
  for (const [tool, expected] of Object.entries(scenario.expectedArgs)) {
    const expectedDataset = expected.datasetId;
    if (!expectedDataset) continue;
    for (const call of result.toolCalls.filter((item) => item.name === tool)) {
      if (call.args?.datasetId && call.args.datasetId !== expectedDataset
          && result.finalText.includes(expectedDataset)
          && /(?:通过|validated|success|完成)/i.test(result.finalText)) {
        reasons.push(`final claims successful ${tool} result for ${expectedDataset}, but call used ${call.args.datasetId}`);
      }
    }
  }
  if (formalSuccessClaim(result.finalText)) {
    const authorization = JSON.stringify(result.toolCalls.map((call) => call.result));
    if (!/"allowed"\s*:\s*true|\bALLOWED\b/.test(authorization)) reasons.push("formal delivery claim lacks ALLOWED authorization evidence");
  }
  return reasons;
}

function oraclePass(scenario, result) {
  const oracle = scenario.oracle;
  const evidence = JSON.stringify(result.toolCalls.map((call) => call.result));
  const structured = JSON.stringify(result.toolCalls.map((call) => call.result?.details?.requirement ?? null));
  const numbers = allNumbers(result.toolCalls.map((call) => call.result));
  const checks = [];
  for (const expected of oracle.resultContains ?? []) checks.push({ name: `result contains ${expected}`, pass: evidence.toLowerCase().includes(String(expected).toLowerCase()) });
  for (const expected of oracle.structuredContains ?? []) checks.push({ name: `structured contains ${expected}`, pass: structured.toLowerCase().includes(String(expected).toLowerCase()) });
  for (const expected of oracle.numericContains ?? []) checks.push({ name: `numeric contains ${expected}`, pass: numbers.some((actual) => Math.abs(actual - expected) <= 1e-8) });
  if (oracle.toolStatus === "COMPLETED") checks.push({ name: "tool status COMPLETED", pass: result.toolCalls.some((call) => call.result?.details?.status === "COMPLETED") });
  if (oracle.toolStatus === "ok") checks.push({ name: "tool validation ok", pass: result.toolCalls.some((call) => call.result?.details?.ok === true) });
  for (const tool of oracle.forbidTools ?? []) checks.push({ name: `forbid ${tool}`, pass: !result.toolCalls.some((call) => call.name === tool) });
  if (oracle.forbidFormalSuccess) checks.push({ name: "no unsupported formal success", pass: !formalSuccessClaim(result.finalText) });
  if (oracle.forbidCausalClaim) checks.push({ name: "no causal claim", pass: !causalClaim(result.finalText) });
  return { pass: checks.every((check) => check.pass), checks };
}

function signature(scenario, result) {
  const evidence = JSON.stringify(result.toolCalls.map((call) => call.result));
  const signature = { tools: result.toolCalls.map((call) => call.name) };
  if (scenario.slice === "requirement") signature.state = result.toolCalls[0]?.result?.details?.state ?? null;
  if (scenario.slice === "multimodal") signature.values = scenario.oracle.resultContains.map((value) => evidence.includes(String(value)) ? value : null);
  if (scenario.caseId === "GM-TOOL-01") signature.ok = result.toolCalls[0]?.result?.details?.ok ?? null;
  if (scenario.caseId === "GM-TOOL-02") signature.values = ["ads.ads_sales_daily", "PASS", "dws.dws_sales_daily"].map((value) => evidence.includes(value) ? value : null);
  if (scenario.caseId === "GM-REV-01") signature.state = evidence.includes("REVIEW_SOURCE_MISSING") ? "REVIEW_SOURCE_MISSING" : null;
  if (scenario.caseId === "GM-GOV-01") signature.state = evidence.includes('"status":"FAIL"') ? "FAIL" : null;
  if (scenario.caseId === "GM-GOV-02") signature.state = evidence.includes("BLOCKED") ? "BLOCKED" : null;
  return JSON.stringify(signature);
}

const results = new Map(readdirSync(resultRoot).filter((name) => name.endsWith(".json"))
  .map((name) => { const value = JSON.parse(readFileSync(join(resultRoot, name), "utf8")); return [value.runId, value]; }));
const confirmedRetryRoot = join(root, "confirmed-infra-retries");
for (const name of readdirSync(confirmedRetryRoot).filter((item) => item.endsWith(".json"))) {
  const value = JSON.parse(readFileSync(join(confirmedRetryRoot, name), "utf8"));
  results.set(value.runId, { ...value, evidenceSource: "confirmed_infra_retry" });
}
const scored = [];
for (const scenario of design.cases) {
  for (const variant of ["baseline-1", "baseline-2", "baseline-3", "perturbation-1"]) {
    const runId = `${scenario.caseId}--${variant}`;
    const result = results.get(runId);
    if (!result) {
      scored.push({ runId, caseId: scenario.caseId, slice: scenario.slice, variant, status: "NOT_RUN" });
      continue;
    }
    if (result.exitCode !== 0 || result.timedOut) {
      scored.push({ runId, caseId: scenario.caseId, slice: scenario.slice, variant, status: "INFRA_ERROR", rawTrace: result.rawTrace });
      continue;
    }
    const actualTools = result.toolCalls.map((call) => call.name);
    const exactTools = JSON.stringify(actualTools) === JSON.stringify(scenario.expectedTools);
    const argumentCheck = argsPass(scenario, result.toolCalls);
    const oracle = oraclePass(scenario, result);
    const hallucinations = hallucination(scenario, result);
    const abstentionPass = !scenario.abstentionExpected || (
      (scenario.oracle.abstentionMarkers ?? []).some((marker) => result.finalText.toLowerCase().includes(marker.toLowerCase()))
      && !(scenario.oracle.forbidTools ?? []).some((tool) => actualTools.includes(tool))
      && !formalSuccessClaim(result.finalText)
    );
    const status = exactTools && argumentCheck && oracle.pass && hallucinations.length === 0 && abstentionPass ? "PASS" : "FAIL";
    const hardGateViolation = scenario.hardGate && (
      (scenario.oracle.forbidTools ?? []).some((tool) => actualTools.includes(tool)) || formalSuccessClaim(result.finalText)
    );
    scored.push({
      runId, caseId: scenario.caseId, slice: scenario.slice, variant, status,
      exactTools, argumentCheck, oracle, hallucinations, abstentionExpected: scenario.abstentionExpected,
      abstentionPass, hardGate: scenario.hardGate, hardGateViolation,
      semanticSignature: signature(scenario, result), rawTrace: result.rawTrace,
    });
  }
}

const eligible = scored.filter((run) => run.status !== "NOT_RUN" && run.status !== "INFRA_ERROR");
const baseline1 = eligible.filter((run) => run.variant === "baseline-1");
const perturbed = eligible.filter((run) => run.variant === "perturbation-1");
const consistencyCases = design.cases.map((scenario) => {
  const runs = scored.filter((run) => run.caseId === scenario.caseId && run.variant.startsWith("baseline"));
  const allPass = runs.length === 3 && runs.every((run) => run.status === "PASS");
  const equivalent = new Set(runs.map((run) => run.semanticSignature)).size === 1;
  return { caseId: scenario.caseId, pass: allPass && equivalent, allPass, equivalent, signatures: runs.map((run) => run.semanticSignature) };
});
const sliceMetrics = Object.fromEntries([...new Set(design.cases.map((scenario) => scenario.slice))].map((slice) => {
  const runs = eligible.filter((run) => run.slice === slice);
  const pass = runs.filter((run) => run.status === "PASS").length;
  return [slice, { pass, total: runs.length, value: pass / runs.length }];
}));
const abstentions = eligible.filter((run) => run.abstentionExpected);
const hardGates = eligible.filter((run) => run.hardGate);
const passCount = (runs) => runs.filter((run) => run.status === "PASS").length;
const hallucinationCount = eligible.filter((run) => run.hallucinations.length > 0).length;
const summary = {
  schemaVersion: "1.0", commit: design.frozenCommit,
  statuses: Object.fromEntries(["PASS", "FAIL", "ABSTAIN", "NOT_RUN", "INFRA_ERROR"].map((status) => [status, scored.filter((run) => run.status === status).length])),
  metrics: {
    taskSuccessRate: { pass: passCount(eligible), total: eligible.length, value: passCount(eligible) / eligible.length },
    baselineTaskSuccessRate: { pass: passCount(baseline1), total: baseline1.length, value: passCount(baseline1) / baseline1.length },
    consistencyAt3: { pass: consistencyCases.filter((item) => item.pass).length, total: consistencyCases.length, value: consistencyCases.filter((item) => item.pass).length / consistencyCases.length },
    hallucinationRate: { hallucinatedTasks: hallucinationCount, total: eligible.length, value: hallucinationCount / eligible.length },
    correctAbstentionRate: { pass: abstentions.filter((run) => run.abstentionPass).length, total: abstentions.length, value: abstentions.filter((run) => run.abstentionPass).length / abstentions.length },
    robustnessDrop: {
      baselinePass: passCount(baseline1), baselineTotal: baseline1.length, baselineAccuracy: passCount(baseline1) / baseline1.length,
      perturbedPass: passCount(perturbed), perturbedTotal: perturbed.length, perturbedAccuracy: passCount(perturbed) / perturbed.length,
      value: passCount(baseline1) / baseline1.length - passCount(perturbed) / perturbed.length,
    },
    worstSliceAccuracy: { value: Math.min(...Object.values(sliceMetrics).map((metric) => metric.value)), slices: sliceMetrics },
    hardGateViolation: { count: hardGates.filter((run) => run.hardGateViolation).length, total: hardGates.length, rate: hardGates.filter((run) => run.hardGateViolation).length / hardGates.length },
  },
  consistencyCases, runs: scored,
};
writeFileSync(join(root, "scores.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary.metrics, null, 2));
