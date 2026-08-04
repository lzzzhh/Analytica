/**
 * Graph Engine — public tools (feature-gated round6.graph_tool).
 *
 * run_analysis_graph: compile the requirement task into a graph and execute
 * it. Inputs are user goal / plan ref / trusted dataRefs / output format /
 * constraints — NEVER an arbitrary GraphSpec, NEVER a review-mode choice.
 * trusted principal is host-injected, not a model parameter.
 *
 * inspect_graph_run: read-only graph state (node statuses, refs, error and
 * warning codes, human actions). Cannot modify, skip, inject or re-mode.
 */
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "../../../../../src/core/extensions/types.ts";

const RunGraphSchema = Type.Object({
  objective: Type.String({ description: "user goal for the analysis" }),
  dataRefs: Type.Optional(Type.Array(Type.String({ description: "trusted artifact ids (art_<16hex>)" }), { description: "trusted dataset artifact ids" })),
  format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("docx"), Type.Literal("pdf")], { description: "report format" })),
  /** Trusted resume: re-running the SAME runId resumes a WAITING_FOR_HUMAN
   *  run after the operator recorded a resolution (never starts a new run). */
  runId: Type.Optional(Type.String({ description: "existing run id to resume ([a-z0-9_-]{1,64})" })),
});

type RunGraphParams = Static<typeof RunGraphSchema>;

const InspectGraphSchema = Type.Object({
  runId: Type.String({ description: "graph run id ([a-z0-9_-]{1,64})" }),
});

type InspectGraphParams = Static<typeof InspectGraphSchema>;

/** Model-facing summary must never contain business numbers. */
export function runGraphSummary(run: { runId: string; status: string; nodeCount: number; failedNodes: string[]; blockedCodes: string[] }): string {
  const lines = [
    `graph run ${run.runId}: ${run.status} (${run.nodeCount} nodes)`,
  ];
  if (run.failedNodes.length > 0) lines.push(`  failed nodes: ${run.failedNodes.join(", ")}`);
  if (run.blockedCodes.length > 0) lines.push(`  blocked codes: ${run.blockedCodes.join(", ")}`);
  return lines.join("\n");
}

export const RUN_ANALYSIS_GRAPH_TOOL: ToolDefinition<typeof RunGraphSchema, unknown> = {
  name: "run_analysis_graph",
  label: "Run Analysis Graph",
  description:
    "Compile a requirement into a deterministic execution graph and run it: " +
    "query/materialize -> preflight governance -> data analysis -> quality/" +
    "lineage/snapshot -> reviewer -> promotion -> report. The review mode is " +
    "decided by the deterministic gate, never by this tool. Feature gated by " +
    "round6.graph_tool (off: not registered).",
  promptSnippet: "run_analysis_graph(objective, dataRefs?, format?) — deterministic analysis pipeline",
  promptGuidelines: [
    "Only reference trusted artifact ids from materialize_query / the catalog.",
    "You cannot choose or lower the review mode; the gate decides.",
    "Reports are produced by the analysis-report Skill, not by a report agent.",
  ],
  parameters: RunGraphSchema,

  async execute(
    _toolCallId: string,
    params: RunGraphParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    try {
      const { runAnalysisGraph } = await import("./tool-runner.ts");
      const result = await runAnalysisGraph({
        objective: params.objective,
        dataRefs: params.dataRefs ?? [],
        format: params.format ?? "markdown",
        runId: params.runId,
      });
      return {
        content: [{ type: "text", text: runGraphSummary(result) }],
        details: result,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `run_analysis_graph failed: ${String(error)}` }],
        details: { error: String(error) },
      };
    }
  },
};

export const INSPECT_GRAPH_RUN_TOOL: ToolDefinition<typeof InspectGraphSchema, unknown> = {
  name: "inspect_graph_run",
  label: "Inspect Graph Run",
  description:
    "Read-only graph run state: node statuses, artifact refs, error codes, " +
    "human actions. Cannot modify nodes, skip the reviewer, reset human " +
    "gates, inject artifacts or change the review mode.",
  promptSnippet: "inspect_graph_run(runId) — read-only graph state",
  promptGuidelines: [
    "Use to explain run progress or failures; never claim you can modify a run.",
  ],
  parameters: InspectGraphSchema,

  async execute(
    _toolCallId: string,
    params: InspectGraphParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    try {
      const { inspectGraphRun } = await import("./tool-runner.ts");
      const view = await inspectGraphRun(params.runId);
      return { content: [{ type: "text", text: view.summary }], details: view.details };
    } catch (error) {
      return {
        content: [{ type: "text", text: `inspect_graph_run failed: ${String(error)}` }],
        details: { error: String(error) },
      };
    }
  },
};
