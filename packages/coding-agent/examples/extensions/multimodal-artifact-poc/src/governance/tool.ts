/**
 * Governance status dashboard tool — the Pi frontend wiring for the Phase 6
 * dashboard (round2.pipeline_status_dashboard).
 *
 * The tool reads the authoritative RunStateSnapshot projections from
 * pipelines/governance/status_dashboard.py (via a controlled python3 child
 * process — the projection code lives in the pipeline package, never
 * re-implemented here). The model-facing content carries only the compact
 * ref/state summary; the full dashboard rows travel through the UI-only
 * details channel rendered by renderResult.
 */
import {
  execFileSync,
} from "node:child_process";
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "../../../../../src/core/extensions/types.ts";
import {
  modelSummaryText,
  renderGovernanceDashboard,
  type GovernanceDashboardDetails,
} from "./ui/renderer.ts";

const StatusSchema = Type.Object({});

type StatusParams = Static<typeof StatusSchema>;

export interface BuildGovernanceToolOptions {
  /** Extension root (repo root) — where the python package lives. */
  repoRoot: string;
  /** Test hook: override the python command (default "python3"). */
  python?: string;
  /** Override the governance data root (default PIPELINE_GOVERNANCE_ROOT). */
  governanceRoot?: string;
}

const SEED = `
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.event_store import EventStore
from pipelines.governance.state_reducer import StateReducer
from pipelines.governance.status_dashboard import StatusDashboard
repo = Repository(); store = EventStore(repo); reducer = StateReducer(store)
d = StatusDashboard(reducer)
print(json.dumps(d.ui_details()))
`;

/**
 * Read the dashboard details by running the authoritative Python projection.
 * The child process writes no files (read-only) and the payload is the fixed
 * structured ui_details() view.
 */
export function fetchGovernanceDashboard(options: {
  repoRoot: string;
  python?: string;
  governanceRoot?: string;
}): GovernanceDashboardDetails {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PIPELINE_GOVERNANCE_ROOT: options.governanceRoot ?? process.env.PIPELINE_GOVERNANCE_ROOT ?? ".data/pipeline-governance",
  };
  const out = execFileSync(options.python ?? "python3", ["-c", SEED], {
    cwd: options.repoRoot,
    encoding: "utf8",
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").pop()!) as GovernanceDashboardDetails;
}

export function buildGovernanceStatusTool(
  options: BuildGovernanceToolOptions,
): ToolDefinition<typeof StatusSchema, GovernanceDashboardDetails> {
  const tool: ToolDefinition<typeof StatusSchema, GovernanceDashboardDetails> = {
    name: "governance_dashboard",
    label: "Governance Status Dashboard",
    description:
      "Multi-pipeline data governance status: per-run state, business phase, open findings and pending approvals, projected from the authoritative governance event store (single source of truth). Returns a compact state/ref summary to the model; the full dashboard is rendered in the UI.",
    promptSnippet: "governance_dashboard() — show the data governance status dashboard",
    promptGuidelines: [
      "Call governance_dashboard to inspect governance state of pipeline runs.",
      "The dashboard state comes from the reducer projection — do not infer state from other sources.",
      "Open findings and pending approvals are refs; the full detail lives in the UI channel.",
    ],
    parameters: StatusSchema,
    renderShell: "self",
    renderResult: renderGovernanceDashboard as never,
    async execute(
      _toolCallId: string,
      _params: StatusParams,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<GovernanceDashboardDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<GovernanceDashboardDetails>> {
      try {
        const details = fetchGovernanceDashboard(options);
        return {
          content: [{ type: "text", text: modelSummaryText(details) }],
          details,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `governance_dashboard failed: ${message}` }],
          details: {
            dashboardType: "PIPELINE_GOVERNANCE",
            rows: [],
            generatedAt: new Date().toISOString(),
          },
        };
      }
    },
  };
  return tool;
}
