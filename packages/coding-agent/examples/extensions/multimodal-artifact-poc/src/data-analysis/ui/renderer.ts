/**
 * UI renderer — the Pi frontend channel for Data Analysis results.
 *
 * Renders the AnalysisResultArtifact (delivered via ToolDefinition.details)
 * into TUI components. This is the ONLY place numeric values are displayed
 * to the user; the model-facing content never contains them.
 *
 * The renderer only understands the fixed section schema (METRIC_CARDS /
 * TABLE / LINE_CHART / BAR_CHART / SCATTER / HISTOGRAM). It never evaluates
 * model-generated templates, HTML or JavaScript.
 */
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolDefinition, ToolRenderContext } from "../../../../../../src/core/extensions/types.ts";
import type { Theme } from "../../../../../../src/modes/interactive/theme/theme.ts";
import type { AnalysisResultArtifact } from "../contracts.ts";
import { artifactToViews } from "./contracts.ts";
import { formatRenderedViews } from "./formatter.ts";
import { sparkline } from "./formatter.ts";

export type DataAnalysisToolDefinition = ToolDefinition<any, AnalysisResultArtifact>;

/**
 * Build the renderResult function for run_data_analysis.
 * Receives the full result (details = AnalysisResultArtifact) and renders it
 * into the TUI. Numbers live here and only here.
 */
export function renderAnalysisResult(
  result: AgentToolResult<AnalysisResultArtifact>,
  _options: { expanded: boolean; isPartial: boolean },
  _theme: Theme,
  _context: ToolRenderContext,
): Component {
  const artifact = result.details;
  const views = artifactToViews(artifact);
  const text = [
    `数据分析结果（${artifact.status}，reviewStatus=${artifact.reviewStatus}）`,
    formatRenderedViews(views),
    artifact.findingsRef ? `findings: ${artifact.findingsRef}` : "",
    artifact.executionManifestRef ? `executionManifest: ${artifact.executionManifestRef}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return new Text(text, 0, 0) as Component;
}

/** Text helper for the renderer (kept for tests that inspect the component). */
export function analysisResultText(artifact: AnalysisResultArtifact): string {
  const views = artifactToViews(artifact);
  const chartLines = artifact.sections
    .filter((s) => s.type !== "METRIC_CARDS" && s.type !== "TABLE")
    .flatMap((s) => {
      if (s.type === "LINE_CHART" && s.series[0]) {
        return [`${s.chartTitle}: ${sparkline(s.series[0].points.map((p) => p.y))}`];
      }
      return [];
    });
  return [formatRenderedViews(views), ...chartLines].join("\n");
}
