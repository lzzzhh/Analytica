/**
 * Analytica Web Adapter — graph data source (read-only).
 *
 * Reads the real GraphEventStore roots:
 *   1. dev seed store:  <web>/dev-data/graph-engine   (labeled dev-seed)
 *   2. production root: $GRAPH_STORE_ROOT or ~/.pi/artifacts/graph-engine
 * State is always replayed from the event stream (single source of truth);
 * this layer never keeps a second state machine.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphEventStore } from "../../src/graph-engine/event-store.ts";
import { newRunState, replayRunState } from "../../src/graph-engine/state-reducer.ts";
import type { GraphEvent, GraphRunState, GraphSpec } from "../../src/graph-engine/contracts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RUN_ID_SAFE = /^[a-z0-9_-]{1,64}$/;

export interface StoreRoot {
  label: string;
  root: string;
}

export function storeRoots(): StoreRoot[] {
  const roots: StoreRoot[] = [];
  const prod = process.env.GRAPH_STORE_ROOT ?? join(homedir(), ".pi", "artifacts", "graph-engine");
  if (existsSync(join(prod, "runs"))) roots.push({ label: "production", root: prod });
  const devSeed = join(here, "..", "dev-data", "graph-engine");
  if (existsSync(join(devSeed, "runs"))) roots.push({ label: "dev-seed", root: devSeed });
  return roots;
}

export function storeFor(label: string): GraphEventStore | null {
  const found = storeRoots().find((r) => r.label === label);
  return found ? new GraphEventStore(found.root) : null;
}

export interface RunSummary {
  runId: string;
  storeLabel: string;
  graphId: string;
  graphVersion: number;
  status: GraphRunState["status"];
  eventCount: number;
  nodeCount: number;
  revisionCycles: number;
  createdAt?: string;
  updatedAt?: string;
}

function runIds(root: string): string[] {
  const dir = join(root, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

/** Replay the event stream into the run state (single source of truth).
 *  Mirrors the executor recovery path: genesis spec + genesis event meta. */
export function replayFromEvents(store: GraphEventStore, runId: string, events: GraphEvent[]): GraphRunState | null {
  const genesis = events.find((e) => e.eventType === "GRAPH_CREATED");
  if (!genesis) return null;
  const spec = store.readSpec(runId, genesis.graphVersion) as GraphSpec | null;
  if (!spec) return null;
  const initial = newRunState({
    runId,
    graphId: spec.graphId,
    graphVersion: spec.graphVersion,
    graphContentHash: genesis.meta["graphContentHash"] ?? spec.contentHash,
    featureSnapshotHash: genesis.meta["featureSnapshotHash"] ?? spec.featureSnapshotHash,
    nodeIds: spec.nodes.map((n) => n.nodeId),
  });
  return replayRunState(initial, events);
}

export function listRuns(): RunSummary[] {
  const out: RunSummary[] = [];
  for (const { label, root } of storeRoots()) {
    const store = new GraphEventStore(root);
    for (const runId of runIds(root)) {
      const events = store.allEvents(runId);
      if (events.length === 0) continue;
      const state = replayFromEvents(store, runId, events);
      if (!state) continue;
      const genesis = events[0];
      out.push({
        runId,
        storeLabel: label,
        graphId: state.graphId,
        graphVersion: state.graphVersion,
        status: state.status,
        eventCount: events.length,
        nodeCount: Object.keys(state.nodeRuns).length,
        revisionCycles: state.revisionCycles,
        createdAt: genesis?.timestamp,
        updatedAt: state.updatedAt,
      });
    }
  }
  out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return out;
}

export interface RunDetail {
  runId: string;
  storeLabel: string;
  spec: GraphSpec | null;
  specVersions: number[];
  state: GraphRunState;
  events: GraphEvent[];
  integrityIssues: string[];
}

export function getRunDetail(label: string, runId: string): RunDetail | null {
  if (!RUN_ID_SAFE.test(runId)) return null;
  const store = storeFor(label);
  if (!store) return null;
  const events = store.allEvents(runId);
  if (events.length === 0) return null;
  const state = replayFromEvents(store, runId, events);
  if (!state) return null;
  const specVersions: number[] = [];
  for (let v = 1; v <= 16; v++) {
    if (store.readSpec(runId, v)) specVersions.push(v);
  }
  const latest = specVersions[specVersions.length - 1];
  const spec = latest ? (store.readSpec(runId, latest) as GraphSpec) : null;
  return { runId, storeLabel: label, spec, specVersions, state, events, integrityIssues: store.scan(runId) };
}

/** Cheap change-detection fingerprint for the SSE channel. */
export function storeFingerprint(): string {
  const parts: string[] = [];
  for (const { label, root } of storeRoots()) {
    for (const runId of runIds(root)) {
      const store = new GraphEventStore(root);
      const last = store.lastEvent(runId);
      parts.push(`${label}:${runId}:${last?.sequence ?? -1}:${last?.contentHash.slice(0, 12) ?? ""}`);
    }
  }
  return parts.join("|");
}
