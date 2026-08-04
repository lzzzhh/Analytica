/**
 * Analysis Task Gate — deterministic route decision.
 *
 * Simple aggregations (single count/sum/avg/min/max, single filter, single
 * group by, no cross-query math, no stats, no charts) stay on the Lakehouse
 * Query Gateway. Anything needing multi-step computation, period comparison,
 * distributions, correlation, statistical tests, or chart data preparation
 * routes to the Data Analysis Subagent.
 */
import type { DataAnalysisRequest, TaskGateResult } from "./contracts.ts";

const SIMPLE_VERBS = /^(avg|average|mean|sum|count|min|max)\b/i;
const COMPLEX_HINTS = [
  /同比|环比|前\s*\d+|上[个一二三四五六七八九十]?[季度月周]|vs\.?|对比|比较|baseline/i,
  /趋势|波动|变化方向|异常|分布|分位|标准差|方差|相关|显著性|p\s*值|检验/i,
  /拆解|贡献|占比|原因|多维度|维度分析|分层/i,
  /图表|图|曲线|直方图|散点/i,
];

export function evaluateTaskGate(request: DataAnalysisRequest): TaskGateResult {
  const reasons: string[] = [];
  let complexityScore = 0;
  const text = request.objective;

  // Complex signals
  if (COMPLEX_HINTS.some((re) => re.test(text))) {
    complexityScore += 2;
    reasons.push("period comparison or trend/anomaly language");
  }
  if (request.analysisType !== "DESCRIPTIVE" && request.analysisType !== "CUSTOM") {
    complexityScore += 1;
    reasons.push(`analysisType=${request.analysisType}`);
  }
  const multiQuery = (request.dataRefs ?? []).length > 1;
  if (multiQuery) {
    complexityScore += 1;
    reasons.push("multiple data refs require cross-query computation");
  }
  const hasDerivedMetrics = (request.metricDefinitions ?? []).some(
    (m) => m.aggregation === undefined && m.expression !== undefined,
  );
  if (hasDerivedMetrics) {
    complexityScore += 1;
    reasons.push("derived metric definitions");
  }
  const wantsCharts = (request.expectedViews ?? []).some(
    (v) => v !== "METRIC_CARDS" && v !== "TABLE",
  );
  if (wantsCharts) {
    complexityScore += 1;
    reasons.push("chart views requested");
  }
  if (request.comparison) {
    complexityScore += 1;
    reasons.push("explicit comparison baseline");
  }

  // Simple: single ref + simple aggregation language + no complex signals.
  const simpleAgg = SIMPLE_VERBS.test(text) && !multiQuery && !hasDerivedMetrics &&
    !wantsCharts && !request.comparison && (request.expectedViews ?? []).length <= 1;
  if (simpleAgg && complexityScore === 0) {
    return {
      route: "QUERY_GATEWAY",
      reasons: ["single aggregation over one data ref — gateway can compute it"],
      complexityScore: 0,
    };
  }

  if (complexityScore >= 2) {
    return {
      route: "DATA_ANALYSIS_SUBAGENT",
      reasons,
      complexityScore,
    };
  }

  // Low complexity but not a plain single aggregation — subagent is the
  // honest default for anything the gateway cannot express in one query.
  return {
    route: "DATA_ANALYSIS_SUBAGENT",
    reasons: [...reasons, "not a single-gateway aggregation"],
    complexityScore,
  };
}
