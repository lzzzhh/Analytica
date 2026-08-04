/**
 * UI renderer contracts — the ONLY schema the frontend renderer understands.
 * Fixed and whitelisted: no arbitrary HTML/JS/templates from the model.
 */
import type {
  AnalysisResultArtifact,
  ChartSection,
  MetricCard,
  TableSection,
} from "../contracts.ts";

export interface RenderedView {
  kind: string;
  title: string;
  lines: string[];
}

export function metricCardToLines(m: MetricCard): string[] {
  const precision = m.precision ?? defaultPrecision(m.valueType);
  const value = formatMetricValue(m.value, m.valueType, precision);
  const unit = m.unit ? ` ${m.unit}` : "";
  const comparison = m.comparison
    ? ` (${m.comparison.method}: ${formatSigned(m.comparison.delta)} vs ${m.comparison.baseline})`
    : "";
  const warning = m.warningCode ? ` [warn: ${m.warningCode}]` : "";
  return [`${m.label}: ${value}${unit}${comparison}${warning}`];
}

export function tableToLines(t: TableSection): string[] {
  const header = t.columns.map((c) => c.name).join(" | ");
  const rows = t.rows.map((row) => t.columns.map((c) => String(row[c.name] ?? "")).join(" | "));
  const bounded = t.displayedRows ?? t.rows.length;
  const total = t.totalRows ?? t.rows.length;
  const lines = [header, "-".repeat(Math.min(header.length, 60)), ...rows];
  if (total > bounded) {
    lines.push(`(显示 ${bounded}/${total} 行；完整结果见下载引用)`);
  }
  return lines;
}

export function chartToLines(c: ChartSection): string[] {
  const out: string[] = [`${c.chartTitle} (${c.type})`, `x: ${c.x}`];
  for (const s of c.series) {
    const samples = s.points
      .slice(0, 12)
      .map((p) => `${p.x}=${formatMetricValue(p.y, "NUMBER", c.precision ?? 2)}`)
      .join(", ");
    out.push(`  ${s.name}: ${samples}${s.points.length > 12 ? " …" : ""}`);
  }
  if (c.warnings?.length) out.push(`warnings: ${c.warnings.join("; ")}`);
  return out;
}

export function formatMetricValue(
  value: string | number,
  valueType: string,
  precision: number,
): string {
  if (typeof value === "string") return value;
  if (valueType === "PERCENT") return `${value.toFixed(precision)}%`;
  if (valueType === "CURRENCY") return value.toFixed(Math.max(0, precision));
  if (valueType === "INTEGER") return String(Math.round(value));
  return value.toFixed(precision);
}

function formatSigned(delta: number): string {
  return `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`;
}

function defaultPrecision(valueType: string): number {
  switch (valueType) {
    case "PERCENT":
      return 2;
    case "CURRENCY":
      return 2;
    case "INTEGER":
      return 0;
    case "DURATION":
      return 1;
    default:
      return 3;
  }
}

/** Convert a validated artifact to renderable views (pure, testable). */
export function artifactToViews(artifact: AnalysisResultArtifact): RenderedView[] {
  const views: RenderedView[] = [];
  for (const section of artifact.sections) {
    switch (section.type) {
      case "METRIC_CARDS": {
        views.push({
          kind: "METRIC_CARDS",
          title: "指标",
          lines: section.metrics.flatMap(metricCardToLines),
        });
        break;
      }
      case "TABLE": {
        views.push({ kind: "TABLE", title: "表格", lines: tableToLines(section) });
        break;
      }
      default: {
        views.push({ kind: section.type, title: section.chartTitle, lines: chartToLines(section) });
      }
    }
  }
  return views;
}
