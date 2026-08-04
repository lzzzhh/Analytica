/**
 * inspect_review_gate — read-only gate tool (P1).
 *
 * The main agent may INSPECT a frozen gate decision (mode, scores, triggers
 * and their sources, upgrade hits, budget, required checks, delivery
 * restrictions, artifact ref). It can never modify, downgrade, or
 * re-choose the mode — mode selection belongs to the orchestrator.
 *
 * Explanation rendering doubles as the UI details channel (dashboardType
 * REVIEW_GATE); the summary text is what the main agent sees.
 */
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "../../../../../../src/core/extensions/types.ts";
import { ReviewerStore, canonicalHash } from "../store.ts";
import type { ReviewGateDecisionArtifact } from "./review-gate.ts";

const GateInspectSchema = Type.Object({
  gateDecisionId: Type.String({ description: "frozen gate decision id (e.g. final_<id>)" }),
});

type GateInspectParams = Static<typeof GateInspectSchema>;

const MODE_RANK: Record<string, number> = { NONE: 0, DETERMINISTIC_ONLY: 1, STANDARD: 2, STRICT: 3 };

/** Human-readable explanation (main-agent content — read only). */
export function renderGateExplanation(gate: ReviewGateDecisionArtifact): string {
  const lines = [
    `Review gate ${gate.gateDecisionId} [${gate.stage}] — mode ${gate.reviewMode}`,
    `  subject: ${gate.subjectType} ${gate.subjectId} (hash ${gate.subjectContentHash.slice(0, 12)}…)`,
    `  scores: impact ${gate.scores.impact} / reversibility ${gate.scores.reversibility} / complexity ${gate.scores.complexity} / uncertainty ${gate.scores.uncertainty} / autonomy ${gate.scores.autonomy} (total ${gate.scores.total})`,
  ];
  if (gate.triggerSources.length > 0) {
    lines.push(`  triggers (${gate.triggerSources.length}):`);
    for (const t of gate.triggerSources) {
      // model content gets a sanitized evidence line: structured code +
      // truncated evidence; raw evidence stays in the UI-only details
      lines.push(`    - ${t.trigger} [${t.source}] — ${sanitizeEvidence(t.evidence)}`);
    }
  } else {
    lines.push("  triggers: none");
  }
  if (gate.deliveryMode === "EXPLORATORY_UNREVIEWED") {
    lines.push(`  delivery: EXPLORATORY_UNREVIEWED (restrictions: ${gate.restrictions.join(", ")})`);
  } else if (gate.restrictions.length > 0) {
    lines.push(`  restrictions: ${gate.restrictions.join(", ")}`);
  }
  lines.push(`  required checks: ${gate.requiredChecks.join(", ") || "(none — NONE mode)"}`);
  lines.push(
    `  budget: input ${gate.budget.maxInputTokens} tok / semantic calls ${gate.budget.maxSemanticCalls} / files ${gate.budget.maxFiles} / diff ${gate.budget.maxDiffLines} lines`,
  );
  if (gate.override) {
    lines.push(`  override: ${gate.override.requestedMode} (${gate.override.authority})`);
  }
  lines.push(`  policyVersion ${gate.policyVersion} | ref gate/${gate.gateDecisionId}.json`);
  return lines.join("\n");
}

/** Upgrade explanation: why the mode is what it is (score tier + hard triggers + overrides). */
export function explainModeDecision(gate: ReviewGateDecisionArtifact): string[] {
  const out: string[] = [];
  const tier =
    gate.scores.total <= 3 ? "NONE" :
      gate.scores.total <= 6 ? "DETERMINISTIC_ONLY" :
        gate.scores.total <= 10 ? "STANDARD" : "STRICT";
  out.push(`score tier ${tier} (total ${gate.scores.total})`);
  const hard = gate.triggers;
  if (hard.length > 0) out.push(`hard triggers: ${hard.join(", ")}`);
  if (gate.deliveryMode === "EXPLORATORY_UNREVIEWED") out.push("delivery EXPLORATORY_UNREVIEWED -> NONE with restrictions");
  if (gate.override) out.push(`OPERATOR_CLI override to ${gate.override.requestedMode}`);
  const rank = MODE_RANK[gate.reviewMode] ?? 0;
  const tierRank = MODE_RANK[tier] ?? 0;
  if (rank > tierRank) out.push(`mode upgraded ${tier} -> ${gate.reviewMode}`);
  return out;
}

/** Sanitize trigger evidence for model content: truncate + strip control chars. */
function sanitizeEvidence(evidence: string): string {
  const clean = evidence.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
  return clean.length < evidence.length ? `${clean}…` : clean;
}

/** UI-only details payload (dashboardType REVIEW_GATE — never model content). */
export function gateInspectDetails(gate: ReviewGateDecisionArtifact): {
  dashboardType: "REVIEW_GATE";
  gate: ReviewGateDecisionArtifact;
  explanation: string[];
} {
  return { dashboardType: "REVIEW_GATE", gate, explanation: explainModeDecision(gate) };
}

export const INSPECT_REVIEW_GATE_TOOL: ToolDefinition<typeof GateInspectSchema, unknown> = {
  name: "inspect_review_gate",
  label: "Inspect Review Gate",
  description:
    "Read-only explanation of a frozen review-gate decision: mode, five risk " +
    "scores, hard triggers with their sources, upgrade reasons, budget, " +
    "required checks and delivery restrictions. The mode is decided by the " +
    "orchestrator — this tool cannot change it.",
  promptSnippet: "inspect_review_gate(gateDecisionId) — why a review runs at this strength",
  promptGuidelines: [
    "Use to explain to the user why a task runs NONE / deterministic-only / standard / strict review.",
    "Never claim you can change the gate mode or skip review.",
  ],
  parameters: GateInspectSchema,

  async execute(
    _toolCallId: string,
    params: GateInspectParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    // store root comes from the host environment only — the agent cannot
    // point the tool at arbitrary directories
    const root = process.env.REVIEWER_STORE_ROOT;
    if (!root) {
      return {
        content: [{ type: "text", text: "inspect_review_gate: REVIEWER_STORE_ROOT not set (host-injected)" }],
        details: { error: "store not configured" },
      };
    }
    try {
      const store = new ReviewerStore(root);
      const rec = await store.read<ReviewGateDecisionArtifact>(`gate/${params.gateDecisionId}.json`);
      if (!rec) {
        return {
          content: [{ type: "text", text: `inspect_review_gate: gate ${params.gateDecisionId} not found` }],
          details: { error: "GATE_DECISION_MISSING" },
        };
      }
      const gate = rec.content;
      // re-verify the stored artifact hash (a tampered store entry must not
      // be presented as authoritative)
      const { contentHash: _c, ...body } = gate;
      if (canonicalHash(body) !== gate.contentHash) {
        return {
          content: [{ type: "text", text: `inspect_review_gate: gate ${params.gateDecisionId} failed hash verification` }],
          details: { error: "GATE_DECISION_TAMPERED" },
        };
      }
      return {
        content: [{ type: "text", text: renderGateExplanation(gate) }],
        details: gateInspectDetails(gate),
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `inspect_review_gate failed: ${String(error)}` }],
        details: { error: String(error) },
      };
    }
  },
};
