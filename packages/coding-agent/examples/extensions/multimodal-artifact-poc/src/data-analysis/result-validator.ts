/**
 * Result validator — validates a script-produced AnalysisResultArtifact
 * against the fixed schema. Also enforces bounded output (max rows/series
 * points) and refuses artifacts that embed executable content.
 */
import type {
  AnalysisResultArtifact,
  AnalysisSection,
  ChartSection,
  MetricCard,
  TableSection,
} from "./contracts.ts";
import { CANARY_NUMBER } from "./contracts.ts";

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidateResultInput {
  artifact: unknown;
  maxOutputRows: number;
  maxSeriesPoints: number;
  maxSections: number;
}

const SECTION_KINDS = new Set([
  "METRIC_CARDS",
  "TABLE",
  "LINE_CHART",
  "BAR_CHART",
  "SCATTER",
  "HISTOGRAM",
]);

const VALUE_TYPES = new Set([
  "NUMBER",
  "PERCENT",
  "CURRENCY",
  "INTEGER",
  "DURATION",
  "TEXT",
]);

export function validateResultArtifact(input: ValidateResultInput): {
  valid: boolean;
  issues: ValidationIssue[];
  artifact: AnalysisResultArtifact | null;
} {
  const issues: ValidationIssue[] = [];
  const a = input.artifact as Partial<AnalysisResultArtifact> | null;

  if (a === null || typeof a !== "object") {
    return { valid: false, issues: [{ code: "NOT_JSON_OBJECT", message: "result is not a JSON object" }], artifact: null };
  }
  if (typeof a.schemaVersion !== "string") issues.push({ code: "SCHEMA_VERSION", message: "schemaVersion missing" });
  if (typeof a.artifactId !== "string") issues.push({ code: "ARTIFACT_ID", message: "artifactId missing" });
  if (typeof a.runId !== "string") issues.push({ code: "RUN_ID", message: "runId missing" });
  if (a.status !== "COMPLETED" && a.status !== "PARTIAL" && a.status !== "FAILED") {
    issues.push({ code: "STATUS", message: "status must be COMPLETED/PARTIAL/FAILED" });
  }
  if (typeof a.title !== "string" || !a.title) issues.push({ code: "TITLE", message: "title missing" });
  if (a.reviewStatus !== "NOT_REVIEWED") {
    issues.push({ code: "REVIEW_STATUS", message: "reviewStatus must be NOT_REVIEWED in round 4" });
  }
  if (!Array.isArray(a.sections)) {
    issues.push({ code: "SECTIONS", message: "sections must be an array" });
    return { valid: issues.length === 0, issues, artifact: a as AnalysisResultArtifact };
  }
  if (a.sections.length > input.maxSections) {
    issues.push({ code: "TOO_MANY_SECTIONS", message: `> ${input.maxSections} sections` });
  }

  const sections = a.sections as AnalysisSection[];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i] as Partial<AnalysisSection> & { type?: string };
    if (!s || typeof s.type !== "string" || !SECTION_KINDS.has(s.type)) {
      issues.push({ code: "SECTION_TYPE", message: `section ${i} has invalid type` });
      continue;
    }
    if (s.type === "METRIC_CARDS") {
      const cards = (s as MetricCardsLike).metrics ?? [];
      if (!Array.isArray(cards) || cards.length === 0) {
        issues.push({ code: "METRICS_EMPTY", message: `section ${i}: no metrics` });
      }
      for (const m of cards as Partial<MetricCard>[]) {
        if (typeof m.metricId !== "string") issues.push({ code: "METRIC_ID", message: `section ${i}: metricId missing` });
        if (m.value === undefined || m.value === null) issues.push({ code: "METRIC_VALUE", message: `section ${i}: metric value missing` });
        if (m.valueType && !VALUE_TYPES.has(m.valueType)) issues.push({ code: "METRIC_VALUE_TYPE", message: `section ${i}: bad valueType` });
        if (typeof m.value === "string" && m.value.includes("<")) {
          issues.push({ code: "HTML_FORBIDDEN", message: `section ${i}: HTML in metric value` });
        }
      }
    } else if (s.type === "TABLE") {
      const table = s as TableLike;
      if (!Array.isArray(table.columns) || table.columns.length === 0) {
        issues.push({ code: "TABLE_COLUMNS", message: `section ${i}: no columns` });
      }
      if (!Array.isArray(table.rows)) issues.push({ code: "TABLE_ROWS", message: `section ${i}: rows not array` });
      if (Array.isArray(table.rows) && table.rows.length > input.maxOutputRows) {
        issues.push({ code: "TABLE_TOO_LARGE", message: `section ${i}: ${table.rows.length} rows > ${input.maxOutputRows}` });
      }
    } else {
      const chart = s as ChartLike;
      if (typeof chart.chartTitle !== "string") issues.push({ code: "CHART_TITLE", message: `section ${i}: chartTitle missing` });
      if (typeof chart.x !== "string") issues.push({ code: "CHART_X", message: `section ${i}: x missing` });
      if (!Array.isArray(chart.series)) issues.push({ code: "CHART_SERIES", message: `section ${i}: series not array` });
      if (Array.isArray(chart.series)) {
        let points = 0;
        for (const ser of chart.series as Array<{ points?: unknown[] }>) {
          points += Array.isArray(ser.points) ? ser.points.length : 0;
        }
        if (points > input.maxSeriesPoints) {
          issues.push({ code: "CHART_TOO_MANY_POINTS", message: `section ${i}: ${points} points > ${input.maxSeriesPoints}` });
        }
      }
    }
  }

  return { valid: issues.length === 0, issues, artifact: a as AnalysisResultArtifact };
}

interface MetricCardsLike { metrics?: unknown }
interface TableLike { columns?: unknown; rows?: unknown }
interface ChartLike { chartTitle?: unknown; x?: unknown; series?: unknown }

/** Deterministic downsampling of chart series when over the point limit. */
export function downsampleSeries(
  chart: ChartSection,
  maxPoints: number,
): ChartSection {
  const out = { ...chart, series: chart.series.map((s) => ({ ...s, points: [...s.points] })) };
  for (const ser of out.series) {
    if (ser.points.length <= maxPoints) continue;
    const step = Math.ceil(ser.points.length / maxPoints);
    ser.points = ser.points.filter((_, i) => i % step === 0);
  }
  return out;
}

/** Bound table rows to the display limit (full result stays on disk). */
export function boundTableRows(table: TableSection, maxRows: number): TableSection {
  if (table.rows.length <= maxRows) return table;
  return {
    ...table,
    rows: table.rows.slice(0, maxRows),
    displayedRows: maxRows,
  };
}

/** Canary guard used by the isolation test — the unique number must never be
 *  synthesized by the validator into model content; it only validates shape. */
export function canaryNumber(): string {
  return CANARY_NUMBER;
}
