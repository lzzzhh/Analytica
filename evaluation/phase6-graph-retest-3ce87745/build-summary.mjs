import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("./", import.meta.url).pathname;
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const commit = "3ce87745f9b1546a10ab7fd015dc543eec8bc7ba";

const global = read("global/scores.json").metrics;
const tools = read("tool-calling/scores.json").metrics;
const requirement = read("agents/requirement/metrics.json");
const multimodal = read("agents/multimodal/metrics.json");
const analysis = read("agents/data-analysis/metrics.json");
const pipeline = read("pipeline/metrics.json");
const reviewer = read("agents/reviewer/metrics.json");
const latency = read("latency.json");
const tokens = read("token-usage.json");
const old = read("../phase5-missing-metrics-92cb4346/coverage-matrix.json");
const oldByName = new Map(old.metrics.map((entry) => [entry.metric, entry]));

function metric(category, name, value, evidence, details = {}) {
  const baseline = oldByName.get(name);
  return {
    category,
    metric: name,
    value,
    ...details,
    baselineValue: baseline?.value ?? null,
    delta: baseline?.value == null || value == null ? null : value - baseline.value,
    commit,
    evidence,
  };
}

const metrics = [
  metric("global", "Task Success Rate", global.taskSuccessRate.value, "global/scores.json", { numerator: global.taskSuccessRate.pass, denominator: global.taskSuccessRate.total }),
  metric("global", "Consistency@3", global.consistencyAt3.value, "global/scores.json", { numerator: global.consistencyAt3.pass, denominator: global.consistencyAt3.total }),
  metric("global", "Hallucination Rate", global.hallucinationRate.value, "global/scores.json", { numerator: global.hallucinationRate.hallucinatedTasks, denominator: global.hallucinationRate.total }),
  metric("global", "Correct Abstention Rate", global.correctAbstentionRate.value, "global/scores.json", { numerator: global.correctAbstentionRate.pass, denominator: global.correctAbstentionRate.total }),
  metric("global", "Robustness Drop", global.robustnessDrop.value, "global/scores.json", { baselineAccuracy: global.robustnessDrop.baselineAccuracy, perturbedAccuracy: global.robustnessDrop.perturbedAccuracy }),
  metric("global", "Worst-Slice Accuracy", global.worstSliceAccuracy.value, "global/scores.json", { worstSlice: "data_analysis" }),
  metric("tool_calling", "Single-Tool Task Success Rate", tools.singleToolTaskSuccessRate.value, "tool-calling/scores.json", { numerator: tools.singleToolTaskSuccessRate.pass, denominator: tools.singleToolTaskSuccessRate.total }),
  metric("tool_calling", "Argument Accuracy", tools.argumentAccuracy.value, "tool-calling/scores.json", { numerator: tools.argumentAccuracy.correct, denominator: tools.argumentAccuracy.total }),
  metric("tool_calling", "Tool Set F1", tools.toolSetF1.value, "tool-calling/scores.json", { tp: tools.toolSetF1.tp, fp: tools.toolSetF1.fp, fn: tools.toolSetF1.fn }),
  metric("tool_calling", "Multi-Tool Task Success Rate", tools.multiToolTaskSuccessRate.value, "tool-calling/scores.json", { numerator: tools.multiToolTaskSuccessRate.pass, denominator: tools.multiToolTaskSuccessRate.total }),
  metric("tool_calling", "Workflow Task Success Rate", tools.workflowSuccessRate.value, "tool-calling/scores.json", { numerator: tools.workflowSuccessRate.pass, denominator: tools.workflowSuccessRate.total }),
  metric("tool_calling", "Orchestration Accuracy", tools.orchestrationAccuracy.value, "tool-calling/scores.json", { numerator: tools.orchestrationAccuracy.correct, denominator: tools.orchestrationAccuracy.total }),
  metric("requirement", "Route Accuracy", requirement.routeAccuracy, "agents/requirement/metrics.json", { numerator: requirement.routeCorrect, denominator: requirement.routeTotal }),
  metric("requirement", "Constraint Recall", requirement.constraintRecall, "agents/requirement/metrics.json", { numerator: requirement.slotsFound, denominator: requirement.slotsTotal }),
  metric("multimodal", "pass@1", multimodal.passAt1, "agents/multimodal/metrics.json", { numerator: multimodal.byScenario.filter((item) => item.passAt1).length, denominator: multimodal.byScenario.length }),
  metric("multimodal", "pass@3", multimodal.passAt3, "agents/multimodal/metrics.json", { numerator: multimodal.byScenario.filter((item) => item.passAt3).length, denominator: multimodal.byScenario.length }),
  metric("multimodal", "Structured Extraction F1", multimodal.structuredExtraction.f1, "agents/multimodal/metrics.json", { tp: multimodal.structuredExtraction.truePositive, fp: multimodal.structuredExtraction.falsePositive, fn: multimodal.structuredExtraction.falseNegative }),
  metric("data_analysis", "Analysis Task Success Rate", analysis.analysisTaskSuccessRate, "agents/data-analysis/metrics.json", { numerator: analysis.taskPass, denominator: analysis.taskTotal }),
  metric("data_analysis", "Numerical Correctness", analysis.numericalCorrectness, "agents/data-analysis/metrics.json", { numerator: analysis.correctNumericalAssertions, denominator: analysis.totalNumericalAssertions }),
  metric("pipeline", "Pipeline Run Success Rate", pipeline.pipelineRunSuccessRate, "pipeline/metrics.json", { numerator: pipeline.pipelineRunsPassed, denominator: pipeline.pipelineRunsTotal }),
  metric("pipeline", "Data Correctness Rate", pipeline.dataCorrectnessRate, "pipeline/metrics.json", { numerator: pipeline.correctnessAssertionsPassed, denominator: pipeline.correctnessAssertionsTotal }),
  metric("pipeline", "Data Quality Defect Detection F1", pipeline.dataQualityDefectDetection.f1, "pipeline/metrics.json", { precision: pipeline.dataQualityDefectDetection.precision, recall: pipeline.dataQualityDefectDetection.recall }),
  metric("pipeline", "Idempotent Rerun Success Rate", pipeline.idempotentRerunSuccessRate, "pipeline/metrics.json", { numerator: pipeline.idempotentRerunsPassed, denominator: pipeline.idempotentRerunsTotal }),
  metric("reviewer", "High-Severity Defect Recall", reviewer.highSeverityDefectRecall, "agents/reviewer/metrics.json", { numerator: reviewer.positiveExecuted, denominator: reviewer.positiveTotal }),
  metric("reviewer", "Reviewer False Positive Rate", reviewer.reviewerFalsePositiveRate, "agents/reviewer/metrics.json", { numerator: 0, denominator: reviewer.cleanTotal }),
  metric("hard_gate", "Hard-Gate Violation Count / Rate", global.hardGateViolation.rate, "global/scores.json", { count: global.hardGateViolation.count, denominator: global.hardGateViolation.total }),
  metric("latency", "Average Successful End-to-End Task Completion Time", latency.meanMs, "latency.json", { status: latency.status, unit: "ms", numerator: latency.successfulTasks, denominator: latency.totalScenarios, medianMs: latency.medianMs, p95Ms: latency.p95Ms }),
  metric("tokens", "Average Observable Task Token Usage", tokens.successfulObservableTasks.mean.totalTokens, "token-usage.json", { status: "PARTIAL_OBSERVABILITY", unit: "tokens", numerator: tokens.successfulObservableTasks.tasks, denominator: tokens.allObservableTasks.tasks, allTaskMean: tokens.allObservableTasks.mean.totalTokens, fullSystemStatus: "ABSTAIN" }),
];

const output = {
  schemaVersion: "1.0",
  commit,
  primaryMetricCount: 27,
  postFreezeTelemetryCount: 1,
  note: "The token metric was requested after the 27-metric design freeze and does not alter any success oracle.",
  metrics,
};
writeFileSync(join(root, "coverage-matrix.json"), `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(join(root, "scores.json"), `${JSON.stringify({ commit, global, tools, requirement, multimodal, analysis, pipeline, reviewer, latency, tokens }, null, 2)}\n`);
