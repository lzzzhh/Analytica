#!/usr/bin/env node
// 中文指标报告生成器：读取一次完整评测的 coverage-matrix.json（28 项指标）
// 与可选的 scores-dual-track.json（V2 双轨），输出中文指标表。
//
// 用法:
//   node evaluation/v2-dual-track/report-metrics-zh.mjs [--run <run-directory>] [--markdown <out.md>]

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { METRIC_NAMES_ZH, zhName } from "./metric-names-zh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const CATEGORY_ZH = {
  global: "全局",
  tool_calling: "工具调用",
  requirement: "需求遵循",
  multimodal: "多模态",
  data_analysis: "数据分析",
  pipeline: "数据管道",
  reviewer: "审阅",
  hard_gate: "硬门禁",
  latency: "效能",
  tokens: "效能",
};

function parseArgs(argv) {
  let runDir = null;
  let markdownPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run") runDir = argv[++index];
    else if (argv[index] === "--markdown") markdownPath = argv[++index];
  }
  if (!runDir) {
    const runsRoot = join(repoRoot, "evaluation/runs");
    const candidates = readdirSync(runsRoot)
      .map((name) => join(runsRoot, name))
      .filter((path) => existsSync(join(path, "coverage-matrix.json")))
      .sort();
    if (candidates.length === 0) throw new Error(`no completed run under ${runsRoot}`);
    runDir = candidates[candidates.length - 1];
  }
  return { runDir: resolve(runDir), markdownPath };
}

function fmt(entry) {
  if (entry.value === null || entry.value === undefined) return "不适用";
  if (entry.metric.includes("Time") || entry.metric.includes("Completion")) {
    return `${Number(entry.value).toFixed(3)} 秒`;
  }
  if (entry.metric.includes("Token")) {
    return `${Number(entry.value).toFixed(1)}`;
  }
  if (entry.metric.includes("Count")) {
    return `${entry.value}`;
  }
  const ratio = Number(entry.value);
  const frac = entry.numerator !== undefined && entry.denominator !== undefined
    ? ` (${entry.numerator}/${entry.denominator})`
    : "";
  return `${(ratio * 100).toFixed(2)}%${frac}`;
}

function main() {
  const { runDir, markdownPath } = parseArgs(process.argv.slice(2));
  const matrix = JSON.parse(readFileSync(join(runDir, "coverage-matrix.json"), "utf8"));
  const dualPath = join(runDir, "tool-calling/scores-dual-track.json");
  const dual = existsSync(dualPath) ? JSON.parse(readFileSync(dualPath, "utf8")) : null;

  const lines = [];
  lines.push(`# 评测指标报告（中文）`);
  lines.push("");
  lines.push(`- 评测目录: \`${runDir}\``);
  lines.push(`- 绑定 Commit: \`${matrix.commit}\``);
  lines.push(`- 指标数: ${matrix.metrics.length}（冻结 ${matrix.primaryMetricCount} + 冻结后追加 ${matrix.postFreezeTelemetryCount}）`);
  lines.push("");
  lines.push("| 类别 | 指标 | 数值 | 对比基线 |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of matrix.metrics) {
    const delta = entry.delta === undefined || entry.delta === null
      ? "-"
      : `${entry.delta >= 0 ? "+" : ""}${entry.metric.includes("Time") || entry.metric.includes("Token") ? entry.delta.toFixed(3) : `${(entry.delta * 100).toFixed(2)}%`}`;
    lines.push(`| ${CATEGORY_ZH[entry.category] ?? entry.category} | ${zhName(entry.metric)} | ${fmt(entry)} | ${delta} |`);
  }
  if (dual) {
    lines.push("");
    lines.push("## V2 双轨评分（严格契约轨 / 业务任务轨）");
    lines.push("");
    lines.push("| 指标 | 严格契约轨 | 业务任务轨 |");
    lines.push("| --- | --- | --- |");
    const pct = (m) => `${(m.value * 100).toFixed(2)}% (${m.pass}/${m.total})`;
    const acc = (m) => `${(m.value * 100).toFixed(2)}%`;
    lines.push(`| ${METRIC_NAMES_ZH["Single-Tool Task Success Rate"]} | ${pct(dual.metrics.strict.singleToolTaskSuccessRate)} | ${pct(dual.metrics.business.singleToolTaskSuccessRate)} |`);
    lines.push(`| ${METRIC_NAMES_ZH["Multi-Tool Task Success Rate"]} | ${pct(dual.metrics.strict.multiToolTaskSuccessRate)} | ${pct(dual.metrics.business.multiToolTaskSuccessRate)} |`);
    lines.push(`| ${METRIC_NAMES_ZH["Workflow Task Success Rate"]} | ${pct(dual.metrics.strict.workflowSuccessRate)} | ${pct(dual.metrics.business.workflowSuccessRate)} |`);
    lines.push(`| ${METRIC_NAMES_ZH["Argument Accuracy"]} | ${acc(dual.metrics.strict.argumentAccuracy)} | ${acc(dual.metrics.business.argumentAccuracy)} |`);
    lines.push(`| ${METRIC_NAMES_ZH["Contract Deviation Rate"]} | - | ${(dual.metrics.business.contractDeviationRate.value * 100).toFixed(2)}% |`);
  }
  const text = lines.join("\n") + "\n";
  process.stdout.write(text);
  if (markdownPath) writeFileSync(markdownPath, text);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
