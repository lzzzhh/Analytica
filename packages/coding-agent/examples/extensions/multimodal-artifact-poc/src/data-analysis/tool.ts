/**
 * run_data_analysis — public tool of the Data Analysis Subagent suite.
 *
 * Registration contract (all must hold, checked by the caller):
 *   round4.data_analysis + round4.data_analysis_tool + round4.analysis_subagent
 *   + round4.analysis_script_execution + round4.analysis_artifacts
 *   + round4.analysis_frontend_render
 *
 * The tool NEVER returns numbers to the model: content is the sanitized
 * summary; details carries the full AnalysisResultArtifact for the UI
 * renderer (renderResult). When frontendRender is off the tool is not
 * registered at all — there is no fallback to model recitation.
 */
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "../../../../../src/core/extensions/types.ts";
import type { FeatureSnapshot } from "../features/types.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { analysisFlags, canRegisterDataAnalysisTool } from "./feature-bindings.ts";
import { runDataAnalysis, type RunAnalysisOptions, type SubagentCaller } from "./index.ts";
import { renderAnalysisResult } from "./ui/renderer.ts";

const DataRefSchema = Type.Object({
  artifactId: Type.String(),
  sourceType: Type.Union([
    Type.Literal("LAKEHOUSE_QUERY"),
    Type.Literal("TABULAR_ARTIFACT"),
    Type.Literal("DERIVED_ARTIFACT"),
  ]),
  queryId: Type.Optional(Type.String()),
  snapshotId: Type.Optional(Type.String()),
  contentHash: Type.Optional(Type.String()),
  format: Type.Union([
    Type.Literal("JSON"),
    Type.Literal("CSV"),
    Type.Literal("PARQUET"),
    Type.Literal("ARROW"),
  ]),
  schema: Type.Optional(Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.String(),
      sensitive: Type.Optional(Type.Boolean()),
    }),
  )),
  rowCount: Type.Optional(Type.Number()),
  allowedColumns: Type.Optional(Type.Array(Type.String())),
  masked: Type.Boolean(),
});

const MetricDefinitionSchema = Type.Object({
  metricId: Type.String(),
  label: Type.String(),
  expression: Type.Optional(Type.String()),
  aggregation: Type.Optional(Type.Union([
    Type.Literal("sum"),
    Type.Literal("avg"),
    Type.Literal("min"),
    Type.Literal("max"),
    Type.Literal("count"),
    Type.Literal("distinct"),
  ])),
  valueType: Type.Optional(Type.Union([
    Type.Literal("NUMBER"),
    Type.Literal("PERCENT"),
    Type.Literal("CURRENCY"),
    Type.Literal("INTEGER"),
    Type.Literal("DURATION"),
    Type.Literal("TEXT"),
  ])),
  unit: Type.Optional(Type.String()),
  precision: Type.Optional(Type.Number()),
});

const AnalysisRequestSchema = Type.Object({
  objective: Type.String({ minLength: 1 }),
  questions: Type.Optional(Type.Array(Type.String())),
  analysisType: Type.Union([
    Type.Literal("DESCRIPTIVE"),
    Type.Literal("TREND"),
    Type.Literal("PERIOD_COMPARISON"),
    Type.Literal("BREAKDOWN"),
    Type.Literal("DISTRIBUTION"),
    Type.Literal("CORRELATION"),
    Type.Literal("STATISTICAL_TEST"),
    Type.Literal("CUSTOM"),
  ]),
  dataRefs: Type.Array(DataRefSchema, { minItems: 1 }),
  metricDefinitions: Type.Optional(Type.Array(MetricDefinitionSchema)),
  dimensions: Type.Optional(Type.Array(Type.String())),
  timeField: Type.Optional(Type.String()),
  timeRange: Type.Optional(Type.Object({
    start: Type.Optional(Type.String()),
    end: Type.Optional(Type.String()),
    timezone: Type.Optional(Type.String()),
  })),
  comparison: Type.Optional(Type.Object({
    baselineStart: Type.Optional(Type.String()),
    baselineEnd: Type.Optional(Type.String()),
    method: Type.Optional(Type.String()),
  })),
  expectedViews: Type.Optional(Type.Array(Type.Union([
    Type.Literal("METRIC_CARDS"),
    Type.Literal("TABLE"),
    Type.Literal("LINE_CHART"),
    Type.Literal("BAR_CHART"),
    Type.Literal("SCATTER"),
    Type.Literal("HISTOGRAM"),
  ]))),
  constraints: Type.Optional(Type.Object({
    maxAttempts: Type.Optional(Type.Number()),
    timeoutSeconds: Type.Optional(Type.Number()),
    maxOutputRows: Type.Optional(Type.Number()),
    maxSeriesPoints: Type.Optional(Type.Number()),
  })),
});

type AnalysisRequestParams = Static<typeof AnalysisRequestSchema>;

export interface BuildDataAnalysisToolOptions {
  snapshot: FeatureSnapshot;
  store: ArtifactStore;
  subagent: SubagentCaller;
  defaultTimeoutSeconds?: number;
}

export function buildDataAnalysisTool(
  options: BuildDataAnalysisToolOptions,
): ToolDefinition<typeof AnalysisRequestSchema, unknown> {
  const flags = analysisFlags(options.snapshot);
  if (!canRegisterDataAnalysisTool(flags)) {
    throw new Error(
      "run_data_analysis requires subagent + script execution + artifacts + frontend render — refusing to register a tool that would fall back to model recitation",
    );
  }

  const runOptions: RunAnalysisOptions = {
    snapshot: options.snapshot,
    store: options.store,
    subagent: options.subagent,
    defaultTimeoutSeconds: options.defaultTimeoutSeconds ?? 120,
  };

  const tool: ToolDefinition<typeof AnalysisRequestSchema, unknown> = {
    name: "run_data_analysis",
    label: "Run Data Analysis (Subagent)",
    description:
      "Run complex data analysis (period comparison, trends, breakdowns, distributions, correlation, statistical tests, chart data) via an isolated Data Analysis Subagent that writes and executes a Python script under controlled conditions. Simple aggregations (single count/sum/avg/min/max) should use execute_query instead. Results are displayed directly in the UI; the tool returns only a status summary (never numeric values).",
    promptSnippet: "run_data_analysis(objective, analysisType, dataRefs) — complex analysis via isolated subagent + controlled script execution",
    promptGuidelines: [
      "Use run_data_analysis only for complex analysis (multi-period comparison, breakdown, distribution, correlation, statistical tests, charts).",
      "For simple aggregations (single avg/sum/count/min/max/group by), use execute_query instead — the task gate rejects them here.",
      "Data must come from validated query materializations or trusted artifacts; never pass raw SQL, code, paths or credentials.",
      "The numeric results are displayed by the UI directly. Do not repeat numbers from analysis results in your reply.",
      "If the tool returns DATA_INPUT_REQUIRED, ask the user for the missing fields rather than guessing.",
    ],
    parameters: AnalysisRequestSchema,
    renderShell: "self",
    renderResult: renderAnalysisResult as never,
    async execute(
      toolCallId: string,
      params: AnalysisRequestParams,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const output = await runDataAnalysis(params as never, runOptions);
      if (output.details) {
        return {
          content: [{ type: "text", text: output.content }],
          details: output.details,
        };
      }
      return {
        content: [{ type: "text", text: output.content }],
        details: { state: output.route, failure: output.failure ?? null },
      };
    },
  };
  return tool;
}
