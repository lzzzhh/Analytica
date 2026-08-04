import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ArtifactStore } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/data-analysis/artifact-store.ts";
import type { AnalysisResultArtifact, DataAnalysisRequest } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/data-analysis/contracts.ts";
import { runDataAnalysis } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/data-analysis/index.ts";
import { createDataAnalysisSubagentCaller } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/data-analysis/subagent.ts";
import type { WorkspacePaths } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/data-analysis/workspace.ts";
import { createFeatureResolver } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/features/resolver.ts";

interface SourceColumn { name: string; arrowType: string }
interface SourceEntry { slug: string; file: string; sha256: string; frozenRows: number; schema: SourceColumn[] }
interface SnapshotEntry { dataset: string; snapshotId: string }
interface NumberExpectation { label: string; value: number; tolerance: number }
interface RowExpectation { keyField: string; key: string | number; value: number; tolerance: number }
interface SeriesExpectation { x: string; y: number; tolerance: number }
interface Scenario {
  id: string; category: string; dataset: string; objective: string; analysisType: DataAnalysisRequest["analysisType"];
  metricDefinitions?: DataAnalysisRequest["metricDefinitions"]; dimensions?: string[]; timeField?: string;
  expectedViews: string[]; expectedNumbers?: NumberExpectation[]; expectedRows?: RowExpectation[]; expectedSeries?: SeriesExpectation[];
  requiredWarning?: string; forbidCausalClaim?: boolean; requiredProvenance?: boolean; requiredLimitations?: boolean;
}
interface Standards { scenarios: Scenario[] }

const root = resolve("evaluation/phase3-agent-evaluation");
const phase2 = resolve("evaluation/phase2-retest/artifacts");
const outputDir = resolve(root, "results/data-analysis");
const storeDir = resolve(root, "artifacts/data-analysis-store");
const workspaceDir = resolve(root, "artifacts/data-analysis-workspaces");
mkdirSync(outputDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });
const standards = JSON.parse(readFileSync(resolve(root, "scenarios/data-analysis.json"), "utf8")) as Standards;
const sources = JSON.parse(readFileSync(resolve(phase2, "dataset-source-manifest.json"), "utf8")) as SourceEntry[];
const snapshots = JSON.parse(readFileSync(resolve(phase2, "warehouse-snapshot.json"), "utf8")) as SnapshotEntry[];
const store = new ArtifactStore(storeDir);
const resolver = createFeatureResolver({ runtimeProfile: "all-enabled" });
const snapshot = resolver.getEffectiveFeatureSnapshot({ modelId: "deepseek-v4-flash", datasetSnapshot: "phase2-retest" });
const subagent = createDataAnalysisSubagentCaller({ provider: "deepseek", modelId: "deepseek-v4-flash", timeoutMs: 180_000 });

function workspace(runId: string): WorkspacePaths {
  const runRoot = resolve(workspaceDir, runId);
  const paths = { root: runRoot, inputDir: resolve(runRoot, "input"), planDir: resolve(runRoot, "plan"), codeDir: resolve(runRoot, "code"), outputDir: resolve(runRoot, "output"), logsDir: resolve(runRoot, "logs") };
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true });
  return { ...paths, inputManifest: resolve(paths.inputDir, "input-manifest.json"), planFile: resolve(paths.planDir, "analysis-plan.json"), scriptFile: resolve(paths.codeDir, "analysis.py"), resultFile: resolve(paths.outputDir, "analysis-result.json"), findingsFile: resolve(paths.outputDir, "analysis-findings.json"), chartDataFile: resolve(paths.outputDir, "chart-data.json"), executionManifestFile: resolve(paths.outputDir, "execution-manifest.json"), stdoutLog: resolve(paths.logsDir, "stdout.log"), stderrLog: resolve(paths.logsDir, "stderr.log") };
}

const refs = new Map<string, DataAnalysisRequest["dataRefs"][number]>();
for (const slug of [...new Set(standards.scenarios.map((scenario) => scenario.dataset))]) {
  const source = sources.find((entry) => entry.slug === slug);
  const sourceSnapshot = snapshots.find((entry) => entry.dataset === slug);
  if (!source || !sourceSnapshot) throw new Error(`missing frozen source metadata for ${slug}`);
  const bytes = readFileSync(source.file);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== source.sha256) throw new Error(`source hash mismatch for ${slug}`);
  const artifactId = `art_${source.sha256.slice(0, 16)}`;
  const schema = source.schema.map((column) => ({ name: column.name, type: column.arrowType }));
  store.register({ artifactId, contentType: "text/csv", rowCount: source.frozenRows, columns: schema.map((column) => column.name), contentHash: source.sha256, snapshotId: sourceSnapshot.snapshotId, masked: false, createdAt: "2026-08-03T00:00:00.000Z" }, bytes);
  refs.set(slug, { artifactId, sourceType: "TABULAR_ARTIFACT", snapshotId: sourceSnapshot.snapshotId, contentHash: source.sha256, format: "CSV", schema, rowCount: source.frozenRows, allowedColumns: schema.map((column) => column.name), masked: false });
}

function allText(value: unknown): string { return JSON.stringify(value).toLowerCase(); }
function valueCandidates(artifact: AnalysisResultArtifact): Array<{ key: string; value: number }> {
  const values: Array<{ key: string; value: number }> = [];
  for (const section of artifact.sections) {
    if (section.type === "METRIC_CARDS") {
      for (const metric of section.metrics) if (typeof metric.value === "number") values.push({ key: `${metric.metricId} ${metric.label}`.toLowerCase(), value: metric.value });
    } else if (section.type === "TABLE") {
      for (const row of section.rows) for (const [key, value] of Object.entries(row)) if (typeof value === "number") values.push({ key: `${key} ${allText(row)}`.toLowerCase(), value });
    } else {
      for (const series of section.series) for (const point of series.points) values.push({ key: `${series.name} ${point.x}`.toLowerCase(), value: point.y });
    }
  }
  return values;
}

function numericMatches(artifact: AnalysisResultArtifact, expected: NumberExpectation): boolean {
  const aliases: Record<string, string[]> = { denominator: ["denominator", "sample size", "row count", "total rows"], worst_column_count: ["worst", "nmhc(gt)", "8443"] };
  const labels = aliases[expected.label] ?? [expected.label, expected.label.replaceAll("_", " ")];
  return valueCandidates(artifact).some((candidate) => labels.some((label) => candidate.key.includes(label.toLowerCase())) && Math.abs(candidate.value - expected.value) <= expected.tolerance);
}

function rowMatches(artifact: AnalysisResultArtifact, expected: RowExpectation): boolean {
  return artifact.sections.some((section) => section.type === "TABLE" && section.rows.some((row) => String(row[expected.keyField]) === String(expected.key) && Object.values(row).some((value) => typeof value === "number" && Math.abs(value - expected.value) <= expected.tolerance)));
}

function seriesMatches(artifact: AnalysisResultArtifact, expected: SeriesExpectation): boolean {
  return artifact.sections.some((section) => section.type !== "METRIC_CARDS" && section.type !== "TABLE" && section.series.some((series) => series.points.some((point) => String(point.x).startsWith(expected.x) && Math.abs(point.y - expected.y) <= expected.tolerance)));
}

const records = [];
let correctAssertions = 0;
let totalAssertions = 0;
let correctNumericalAssertions = 0;
let totalNumericalAssertions = 0;
for (const scenario of standards.scenarios) {
  const dataRef = refs.get(scenario.dataset);
  if (!dataRef) throw new Error(`unregistered dataset ${scenario.dataset}`);
  const request: DataAnalysisRequest = { objective: scenario.objective, analysisType: scenario.analysisType, dataRefs: [dataRef], metricDefinitions: scenario.metricDefinitions, dimensions: scenario.dimensions, timeField: scenario.timeField, expectedViews: scenario.expectedViews as DataAnalysisRequest["expectedViews"], constraints: { maxAttempts: 2, timeoutSeconds: 180, maxOutputRows: 500, maxSeriesPoints: 2000 } };
  const startedAt = new Date().toISOString();
  try {
    const output = await runDataAnalysis(request, { snapshot, store, subagent, createWorkspaceForRun: workspace, defaultTimeoutSeconds: 180 });
    const assertions: Array<{ name: string; pass: boolean }> = [];
    assertions.push({ name: "route", pass: output.route === "DATA_ANALYSIS_SUBAGENT" });
    assertions.push({ name: "completed_artifact", pass: output.artifact?.status === "COMPLETED" && output.manifest?.attempts.some((attempt) => attempt.status === "SUCCEEDED") === true });
    for (const view of scenario.expectedViews) assertions.push({ name: `view:${view}`, pass: output.artifact?.sections.some((section) => section.type === view) === true });
    for (const expected of scenario.expectedNumbers ?? []) assertions.push({ name: `number:${expected.label}`, pass: output.artifact ? numericMatches(output.artifact, expected) : false });
    for (const expected of scenario.expectedRows ?? []) assertions.push({ name: `row:${expected.key}`, pass: output.artifact ? rowMatches(output.artifact, expected) : false });
    for (const expected of scenario.expectedSeries ?? []) assertions.push({ name: `series:${expected.x}`, pass: output.artifact ? seriesMatches(output.artifact, expected) : false });
    if (scenario.requiredWarning) assertions.push({ name: "required_warning", pass: allText(output).includes(scenario.requiredWarning.toLowerCase()) });
    if (scenario.forbidCausalClaim) assertions.push({ name: "no_causal_claim", pass: !/(causes|导致|因果)/iu.test(allText(output.artifact ?? {})) });
    if (scenario.requiredProvenance) assertions.push({ name: "provenance", pass: Boolean(output.manifest?.inputArtifacts.length && output.manifest.scriptHash) });
    if (scenario.requiredLimitations) {
      const planFiles = output.manifest ? [resolve(workspaceDir, output.manifest.runId, "plan/analysis-plan.json")] : [];
      assertions.push({ name: "limitations", pass: planFiles.some((file) => { try { const parsed = JSON.parse(readFileSync(file, "utf8")) as { limitations?: unknown[] }; return Array.isArray(parsed.limitations) && parsed.limitations.length > 0; } catch { return false; } }) });
    }
    const pass = assertions.every((assertion) => assertion.pass);
    correctAssertions += assertions.filter((assertion) => assertion.pass).length;
    totalAssertions += assertions.length;
    const numericalAssertions = assertions.filter((assertion) => /^(number|row|series):/u.test(assertion.name));
    correctNumericalAssertions += numericalAssertions.filter((assertion) => assertion.pass).length;
    totalNumericalAssertions += numericalAssertions.length;
    const record = { id: scenario.id, category: scenario.category, startedAt, status: pass ? "PASS" : "FAIL", assertions, output };
    records.push(record);
    writeFileSync(resolve(outputDir, `${scenario.id}.json`), JSON.stringify(record, null, 2) + "\n");
  } catch (error) {
    const record = { id: scenario.id, category: scenario.category, startedAt, status: "INFRA_ERROR", error: error instanceof Error ? error.message : String(error) };
    records.push(record);
    writeFileSync(resolve(outputDir, `${scenario.id}.json`), JSON.stringify(record, null, 2) + "\n");
  }
}
const executed = records.filter((record) => record.status === "PASS" || record.status === "FAIL");
const metrics = { status: executed.length === 0 ? "INFRA_ERROR" : "PASS", analysisTaskSuccessRate: executed.length === 0 ? null : executed.filter((record) => record.status === "PASS").length / executed.length, taskPass: executed.filter((record) => record.status === "PASS").length, taskExecuted: executed.length, taskTotal: standards.scenarios.length, numericalCorrectness: totalNumericalAssertions === 0 ? null : correctNumericalAssertions / totalNumericalAssertions, correctNumericalAssertions, totalNumericalAssertions, correctAssertions, totalAssertions, infraErrors: records.length - executed.length, featureSnapshotHash: snapshot.effectiveFeatureHash, records };
writeFileSync(resolve(outputDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
