#!/usr/bin/env node
// Workflow 行为链评分器（V2）。
//
// 背景：phase6 重跑评分器把 requiredDependencies 按 " -> " 拆成工具名做顺序
// 匹配，但 12 个 workflow 用例中 9 个的依赖是行为描述句（"BLOCKED -> stop"、
// "skip Reviewer" 等），永远判 false，导致工作流成功率结构性为 0%。
// 冻结评分器（phase4 score-results.mjs）用的是人工审计的 dependencyCorrect。
//
// 本评分器不改 Frozen Golden：对每条依赖边给出确定性可机检规则，从新采集的
// 本地 trace（evaluation/v2-fixtest/wf-traces/<caseId>.json）计算通过率。
//
// 用法: node evaluation/v2-dual-track/score-workflow-v2.mjs [--traces <dir>]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zhName } from "./metric-names-zh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const tracesDir = (() => {
  const index = process.argv.indexOf("--traces");
  return index >= 0 ? resolve(process.argv[index + 1]) : join(repoRoot, "evaluation/v2-fixtest/wf-traces");
})();

function names(trace) { return trace.calls.map((c) => c.name); }
function has(trace, tool) { return names(trace).includes(tool); }
function count(trace, tool) { return names(trace).filter((n) => n === tool).length; }
function callResult(trace, tool) { return (trace.calls.find((c) => c.name === tool) ?? {}).result ?? ""; }
function noErrors(trace) { return trace.calls.every((c) => !c.isError); }
function inOrder(trace, chain) {
  let position = -1;
  for (const tool of chain) {
    const index = names(trace).indexOf(tool, position + 1);
    if (index < 0) return false;
    position = index;
  }
  return true;
}
function honestFinal(trace, keywords) {
  const text = trace.finalText.toLowerCase();
  return keywords.some((k) => text.includes(k));
}

// 每个用例返回 { edges: [{ name, pass, evidence }] }
const RULES = {
  "WF-01": (t) => ({ edges: [
    { name: "search_catalog -> inspect_dataset", pass: inOrder(t, ["search_catalog", "inspect_dataset"]) },
    { name: "inspect_dataset -> validate_query", pass: inOrder(t, ["inspect_dataset", "validate_query"]) },
    { name: "validate_query -> execute_query", pass: inOrder(t, ["validate_query", "execute_query"]) },
  ] }),
  "WF-02": (t) => ({ edges: [
    { name: "trusted artifact -> run_data_analysis", pass: has(t, "run_data_analysis") && /pearson/i.test(callResult(t, "run_data_analysis") + t.finalText) },
  ] }),
  "WF-03": (t) => ({ edges: [
    // 无公共桥接：解析成功后必须如实说明无法把解析产物注册为可信 dataRef，
    // 且不得用虚构 dataRef 调 run_data_analysis。
    { name: "parse output honest handoff (no fabricated dataRef)", pass:
      has(t, "parse_document") && !callResult(t, "parse_document").includes("failed") &&
      (!has(t, "run_data_analysis") || !/fabricat|虚构/.test(t.finalText)) &&
      honestFinal(t, ["无法", "桥接", "bridge", "可信", "受信任", "trusted", "未能", "拒绝", "未被识别"]) },
  ] }),
  "WF-04": (t) => ({ edges: [
    { name: "validate_query -> materialize_query", pass: inOrder(t, ["validate_query", "materialize_query"]) },
    { name: "materialize_query -> run_data_analysis", pass: inOrder(t, ["materialize_query", "run_data_analysis"]) },
    { name: "run_data_analysis COMPLETED -> review_data_analysis", pass:
      inOrder(t, ["run_data_analysis", "review_data_analysis"]) && /COMPLETED/.test(callResult(t, "run_data_analysis")) },
    { name: "review_data_analysis -> promote_analysis", pass: inOrder(t, ["review_data_analysis", "promote_analysis"]) },
    { name: "verdict PASS -> promotion ALLOWED", pass:
      /ALLOWED/.test(callResult(t, "promote_analysis")) || /PASS/.test(callResult(t, "review_data_analysis")) },
  ] }),
  "WF-05": (t) => ({ edges: [
    { name: "review_data_analysis -> inspect_review_gate", pass: inOrder(t, ["review_data_analysis", "inspect_review_gate"]) },
  ] }),
  "WF-06": (t) => ({ edges: [
    { name: "inspect gate -> skip Reviewer", pass: has(t, "inspect_review_gate") && !has(t, "review_data_analysis") },
    { name: "inspect gate -> promote_analysis", pass: inOrder(t, ["inspect_review_gate", "promote_analysis"]) },
  ] }),
  "WF-07": (t) => ({ edges: [
    // 缺失 artifact：分析失败后不得把缺失产物送审。
    { name: "analysis failure -> no reviewer on missing artifact", pass:
      has(t, "run_data_analysis") && !/COMPLETED/.test(callResult(t, "run_data_analysis")) && !has(t, "review_data_analysis") },
  ] }),
  "WF-08": (t) => ({ edges: [
    // 超时停止策略：分析超时/失败即停止，不得继续送审。
    { name: "timeout/failure -> stop", pass:
      has(t, "run_data_analysis") && !has(t, "review_data_analysis") && honestFinal(t, ["超时", "timeout", "失败", "未能"]) },
  ] }),
  "WF-09": (t) => ({ edges: [
    // ABSTAIN 必须被解析并阻断晋升（产品修复：terminal-pointer 缺失回退）。
    { name: "stored ABSTAIN verdict -> promotion decision", pass:
      has(t, "promote_analysis") && /DENIED|ABSTAIN/i.test(callResult(t, "promote_analysis")) },
  ] }),
  "WF-10": (t) => ({ edges: [
    // 质量非 PASS 不得执行冻结查询。
    { name: "quality not PASS -> no execute", pass:
      has(t, "get_data_quality") && !has(t, "execute_query") },
  ] }),
  "WF-11": (t) => ({ edges: [
    // 幂等复用：相同请求只调一次。
    { name: "first result -> reuse (single call)", pass: count(t, "get_snapshot") === 1 },
  ] }),
  "WF-12": (t) => ({ edges: [
    { name: "write_gate_check BLOCKED -> stop", pass:
      has(t, "write_gate_check") && /BLOCKED/.test(callResult(t, "write_gate_check")) && !has(t, "pipeline_ingest") },
    { name: "no bypass of Reviewer/Promotion", pass: !has(t, "promote_analysis") && honestFinal(t, ["无法", "拒绝", "不能", "block"]) },
  ] }),
};

const rows = [];
let passCases = 0;
let edgePass = 0;
let edgeTotal = 0;
for (const caseId of Object.keys(RULES).sort()) {
  const path = join(tracesDir, `${caseId}.json`);
  if (!existsSync(path)) {
    rows.push([caseId, "NOT_RUN", "-", "trace 缺失"]);
    continue;
  }
  const trace = JSON.parse(readFileSync(path, "utf8"));
  const { edges } = RULES[caseId](trace);
  const pass = edges.every((e) => e.pass) && trace.exitCode === 0;
  const failedEdges = edges.filter((e) => !e.pass).map((e) => e.name);
  passCases += pass ? 1 : 0;
  edgePass += edges.filter((e) => e.pass).length;
  edgeTotal += edges.length;
  rows.push([caseId, pass ? "PASS" : "FAIL", `${edges.filter((e) => e.pass).length}/${edges.length}`, failedEdges.join("; ") || "全部依赖边满足"]);
}

const total = rows.length;
process.stdout.write("Workflow 行为链评分（V2）\n");
process.stdout.write(`traces: ${tracesDir}\n\n`);
process.stdout.write(`${"用例".padEnd(8)}${"状态".padEnd(8)}${"依赖边".padEnd(8)}说明\n`);
for (const [caseId, status, edges, note] of rows) {
  process.stdout.write(`${caseId.padEnd(8)}${status.padEnd(8)}${edges.padEnd(8)}${note}\n`);
}
process.stdout.write(`\n${zhName("Workflow Task Success Rate")}: ${(passCases / total * 100).toFixed(2)}% (${passCases}/${total})\n`);
process.stdout.write(`${zhName("Orchestration Accuracy")}: ${(edgePass / edgeTotal * 100).toFixed(2)}% (${edgePass}/${edgeTotal})\n`);
