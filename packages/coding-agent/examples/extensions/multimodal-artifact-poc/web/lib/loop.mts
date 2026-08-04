/**
 * Analytica Web Adapter — Agent Loop projection.
 *
 * Pure PROJECTION of the real GraphEvent stream onto the six canonical
 * phases (Plan -> Retrieve -> Analyze -> Execute -> Review -> Iterate).
 * No state of its own: every field is derived from events + replayed
 * node state. Node-to-phase mapping is by capability id (spec-derived),
 * never by guessing.
 */
import type { GraphEvent, GraphSpec, GraphRunState } from "../../src/graph-engine/contracts.ts";

export type LoopPhaseId = "plan" | "retrieve" | "analyze" | "execute" | "review" | "iterate";
export type LoopPhaseStatus = "NOT_STARTED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "WAITING";

export interface LoopPhase {
  phaseId: LoopPhaseId;
  label: string;
  status: LoopPhaseStatus;
  nodeIds: string[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** review: verdict / gate decision codes; iterate: revision reasons. */
  details: string[];
}

export interface AgentLoopProjection {
  runId: string;
  currentPhase: LoopPhaseId | null;
  phases: LoopPhase[];
  revisionCycles: number;
  derivedFromEvents: number;
}

const PHASE_ORDER: LoopPhaseId[] = ["plan", "retrieve", "analyze", "execute", "review", "iterate"];
const PHASE_LABELS: Record<LoopPhaseId, string> = {
  plan: "Plan",
  retrieve: "Retrieve",
  analyze: "Analyze",
  execute: "Execute",
  review: "Review",
  iterate: "Iterate",
};

/** Capability families -> phases (spec node capability is the only input). */
function phaseOfNode(spec: GraphSpec, nodeId: string): LoopPhaseId | null {
  if (nodeId === "sys.inputs") return "retrieve";
  const node = spec.nodes.find((n) => n.nodeId === nodeId);
  if (!node) return null;
  const cap = node.capabilityId;
  if (cap === "graph.governance.preflight") return "plan";
  if (cap.startsWith("graph.catalog") || cap.startsWith("graph.dataset") || cap.startsWith("graph.query")) return "retrieve";
  if (cap.startsWith("graph.analysis.run") || cap.startsWith("graph.agent") || cap.startsWith("graph.document") || cap.startsWith("graph.image")) return "analyze";
  if (cap === "graph.analysis.fan_in" || cap.startsWith("skill.") || cap === "graph.deliverable.verify" || cap.startsWith("graph.data.")) return "execute";
  if (cap.startsWith("graph.review") || cap === "graph.human.review") return "review";
  return null;
}

const TERMINAL_NODE_STATUS = new Set(["SUCCEEDED", "FAILED", "BLOCKED", "SKIPPED", "CANCELLED"]);

export function projectAgentLoop(spec: GraphSpec, state: GraphRunState, events: GraphEvent[]): AgentLoopProjection {
  const phaseNodes = new Map<LoopPhaseId, string[]>();
  for (const id of PHASE_ORDER) phaseNodes.set(id, []);
  for (const node of spec.nodes) {
    const phase = phaseOfNode(spec, node.nodeId);
    if (phase) phaseNodes.get(phase)!.push(node.nodeId);
  }

  const phases: LoopPhase[] = PHASE_ORDER.map((phaseId) => {
    const nodeIds = phaseNodes.get(phaseId)!;
    const runs = nodeIds.map((id) => state.nodeRuns[id]).filter(Boolean);
    const statuses = runs.map((r) => r.status);
    const started = runs.map((r) => r.startedAt).filter(Boolean).sort();
    const ended = runs.map((r) => r.completedAt).filter(Boolean).sort();
    let status: LoopPhaseStatus = "NOT_STARTED";
    if (phaseId === "iterate") {
      // iterate exists only when revisions actually happened
      status = state.revisionCycles > 0 ? "SUCCEEDED" : "NOT_STARTED";
    } else if (statuses.some((s) => s === "RUNNING" || s === "READY")) {
      status = "RUNNING";
    } else if (statuses.some((s) => s === "FAILED")) {
      status = "FAILED";
    } else if (statuses.some((s) => s === "BLOCKED")) {
      status = "BLOCKED";
    } else if (statuses.some((s) => s === "WAITING_FOR_HUMAN")) {
      status = "WAITING";
    } else if (nodeIds.length > 0 && statuses.length > 0 && statuses.every((s) => TERMINAL_NODE_STATUS.has(s)) && statuses.some((s) => s === "SUCCEEDED" || s === "SKIPPED")) {
      status = "SUCCEEDED";
    }
    const startedAt = started[0];
    const endedAt = statuses.every((s) => TERMINAL_NODE_STATUS.has(s)) && ended.length > 0 ? ended[ended.length - 1] : undefined;
    const durationMs = startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : undefined;
    const details: string[] = [];
    if (phaseId === "review") {
      for (const ev of events) {
        if (ev.eventType === "REVIEW_GATE_DECIDED" || ev.eventType === "REVIEW_COMPLETED") {
          details.push(`${ev.eventType} ${ev.meta["verdict"] ?? ev.meta["resolution"] ?? ""}`.trim());
        }
      }
      for (const r of runs) if (r.summary) details.push(`${r.nodeId}: ${r.summary}`);
    }
    if (phaseId === "iterate") {
      for (const ev of events) {
        if (ev.eventType === "REVISION_REQUESTED") {
          details.push(`revision: ${ev.meta["reason"] ?? ev.errorCode ?? "requested"}`);
        }
      }
    }
    for (const r of runs) if (r.errorCode) details.push(`${r.nodeId}: ${r.errorCode}`);
    return { phaseId, label: PHASE_LABELS[phaseId], status, nodeIds, startedAt, endedAt, durationMs, details };
  });

  // current phase = first non-terminal phase in order (or last if all done)
  let currentPhase: LoopPhaseId | null = null;
  for (const p of phases) {
    if (p.status === "RUNNING" || p.status === "WAITING" || p.status === "NOT_STARTED") {
      if (p.nodeIds.length > 0 || p.phaseId === "iterate") {
        currentPhase = p.phaseId;
        break;
      }
    }
  }
  if (!currentPhase && state.status === "RUNNING") currentPhase = phases.find((p) => p.status !== "SUCCEEDED")?.phaseId ?? null;

  return { runId: state.runId, currentPhase, phases, revisionCycles: state.revisionCycles, derivedFromEvents: events.length };
}
