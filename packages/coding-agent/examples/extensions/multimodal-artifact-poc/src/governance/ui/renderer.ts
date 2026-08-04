/**
 * Governance dashboard UI renderer — the Pi frontend channel.
 *
 * Renders the StatusDashboard overview payload (delivered via
 * ToolDefinition.details) into the TUI. This is the ONLY place the full
 * dashboard rows are displayed; the model-facing content carries only the
 * compact ref/state summary (see modelSummaryText).
 *
 * The renderer only formats the fixed structured payload — it never
 * evaluates model-generated templates, HTML or JavaScript.
 */
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  ToolDefinition,
  ToolRenderContext,
} from "../../../../../../src/core/extensions/types.ts";
import type { Theme } from "../../../../../../src/modes/interactive/theme/theme.ts";

/** Structured overview row produced by pipelines/governance/status_dashboard.py. */
export interface GovernanceDashboardRow {
  pipelineId: string;
  pipelineVersion: number;
  runId: string;
  state: string;
  businessPhase: string;
  engine: string;
  currentJob?: string | null;
  currentStage?: string | null;
  lastHeartbeatAt?: string | null;
  lastProgressAt?: string | null;
  openFindings: number;
  pendingApproval?: string | null;
  severity: string;
}

/** The details payload: status_dashboard.ui_details(). */
export interface GovernanceDashboardDetails {
  dashboardType: "PIPELINE_GOVERNANCE";
  rows: GovernanceDashboardRow[];
  generatedAt: string;
}

export type GovernanceToolDefinition = ToolDefinition<any, GovernanceDashboardDetails>;

const STATE_STYLES: Record<string, string> = {
  FAILED: "x",
  BLOCKED: "x",
  ISSUE_DETECTED: "!",
  WAITING_REMEDIATION_APPROVAL: "?",
  RUNNING: ">",
  QUEUED: ".",
  PUBLISHED: "*",
  CANCELLED: "-",
};

function stateMarker(state: string): string {
  return STATE_STYLES[state] ?? "?";
}

/** Render the dashboard details into a TUI Text component. */
export function renderGovernanceDashboard(
  result: AgentToolResult<GovernanceDashboardDetails>,
  _options: { expanded: boolean; isPartial: boolean },
  _theme: Theme,
  _context: ToolRenderContext,
): Component {
  const details = result.details;
  const rows = details?.rows ?? [];
  const lines: string[] = [
    `Governance Dashboard (${details?.generatedAt ?? "n/a"})`,
    "state  pipeline v run findings pending",
  ];
  for (const r of rows) {
    const marker = stateMarker(r.state);
    lines.push(
      `${marker}     ${r.pipelineId} v${r.pipelineVersion} ${r.runId} ` +
        `${r.openFindings} ${r.pendingApproval ?? "-"} [${r.state}]`,
    );
  }
  if (rows.length === 0) lines.push("(no pipeline runs in governance store)");
  return new Text(lines.join("\n"), 0, 0) as Component;
}

/** Compact model-facing summary text (refs/state only, no payloads). */
export function modelSummaryText(details: GovernanceDashboardDetails): string {
  const rows = details?.rows ?? [];
  if (rows.length === 0) return "no pipeline runs in governance store";
  const lines = rows.map((r) =>
    `${r.pipelineId} v${r.pipelineVersion} run=${r.runId} state=${r.state} ` +
    `phase=${r.businessPhase} findings=${r.openFindings} ` +
    `pendingApproval=${r.pendingApproval ?? "none"}`);
  return `governance dashboard:\n${lines.join("\n")}`;
}
