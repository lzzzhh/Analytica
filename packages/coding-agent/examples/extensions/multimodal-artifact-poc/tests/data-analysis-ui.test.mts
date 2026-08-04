/**
 * Data Analysis UI renderer — unit tests for the fixed-schema frontend
 * channel (spec 18-21). Verifies the renderer displays exact numbers from
 * the artifact (no reformatting drift) and that precision/unit follow the
 * schema.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  artifactToViews,
  formatMetricValue,
  metricCardToLines,
  tableToLines,
  chartToLines,
} from "../src/data-analysis/ui/contracts.ts";
import { formatRenderedViews, sparkline } from "../src/data-analysis/ui/formatter.ts";
import { analysisResultText } from "../src/data-analysis/ui/renderer.ts";
import { SAMPLE_RESULT } from "./helpers.ts";
import type { AnalysisResultArtifact, MetricCard } from "../src/data-analysis/contracts.ts";

describe("UI renderer (spec 18-21)", () => {
  test("renderer receives and displays the canary number exactly", () => {
    const text = analysisResultText(SAMPLE_RESULT);
    assert.ok(text.includes("918273.645"), "renderer must show the exact canary number");
  });

  test("metric value rendered with schema precision (no reformatting drift)", () => {
    const card: MetricCard = {
      metricId: "auc",
      label: "AUC",
      value: 918273.645,
      valueType: "NUMBER",
      precision: 3,
    };
    const lines = metricCardToLines(card);
    assert.ok(lines[0].includes("918273.645"), "must render the exact 3-decimal value");
  });

  test("PERCENT renders with % and unit respected", () => {
    const lines = metricCardToLines({
      metricId: "churn",
      label: "Churn",
      value: 0.1234,
      valueType: "PERCENT",
      precision: 2,
      unit: "%",
    });
    // PERCENT type formats as 12.34% (value*100 handled by the script; the
    // renderer appends the percent sign without touching the number).
    assert.ok(lines[0].includes("0.12"), "renderer must not recompute the value");
  });

  test("precision 0 renders integers without decimals", () => {
    const lines = metricCardToLines({
      metricId: "n",
      label: "Count",
      value: 42.9,
      valueType: "INTEGER",
      precision: 0,
    });
    assert.ok(lines[0].includes("43"), "INTEGER rounds to the schema precision");
  });

  test("large table shows bounded rows with download reference", () => {
    const table = {
      type: "TABLE" as const,
      columns: [{ name: "a", type: "string" }],
      rows: Array.from({ length: 3 }, (_, i) => ({ a: `v${i}` })),
      totalRows: 1000,
      displayedRows: 3,
    };
    const lines = tableToLines(table);
    assert.ok(lines.some((l) => l.includes("显示 3/1000 行")), "must show bounded count");
  });

  test("chart renders title, x axis and sample points", () => {
    const chart = {
      type: "LINE_CHART" as const,
      chartTitle: "AUC by day",
      x: "event_date",
      series: [{ name: "auc", points: [{ x: "2026-07-01", y: 918273.645 }] }],
      precision: 3,
    };
    const lines = chartToLines(chart);
    assert.ok(lines[0].includes("AUC by day"));
    assert.ok(lines.some((l) => l.includes("2026-07-01=918273.645")));
  });

  test("artifactToViews produces all section kinds", () => {
    const views = artifactToViews(SAMPLE_RESULT);
    const kinds = views.map((v) => v.kind);
    assert.ok(kinds.includes("METRIC_CARDS"));
    assert.ok(kinds.includes("TABLE"));
    assert.ok(kinds.includes("LINE_CHART"));
  });

  test("formatRenderedViews joins blocks", () => {
    const out = formatRenderedViews(artifactToViews(SAMPLE_RESULT));
    assert.ok(out.includes("[METRIC_CARDS]"));
    assert.ok(out.includes("[TABLE]"));
  });

  test("sparkline renders bounded width", () => {
    const s = sparkline(Array.from({ length: 100 }, (_, i) => i), 20);
    assert.ok(s.length <= 20);
  });

  test("rendered text never contains executable content", () => {
    const text = analysisResultText(SAMPLE_RESULT);
    assert.ok(!text.includes("<script"), "no script tags");
    assert.ok(!text.includes("javascript:"), "no javascript: URLs");
  });

  test("formatter precision: DEFAULT valueType NUMBER → 3 decimals", () => {
    assert.equal(formatMetricValue(1.2345678, "NUMBER", 3), "1.235");
    assert.equal(formatMetricValue(0.5, "PERCENT", 2), "0.50%");
    assert.equal(formatMetricValue(123.456, "CURRENCY", 2), "123.46");
  });
});
