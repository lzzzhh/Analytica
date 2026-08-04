/**
 * Graph Engine — tool runner (host-side wiring for run_analysis_graph).
 *
 * First version: deterministic catalog -> inspect -> validate -> execute
 * sub-graph driven by the executor with FAKE analysis adapters is NOT used
 * here — this runner wires the REAL adapters (data-analysis with an
 * injected subagent, reviewer with the real orchestrator) once the host
 * provides them. Until then it reports GRAPH_TOOL_NOT_WIRED without
 * fabricating a run.
 */
import { contentHash } from "./canonical.ts";
import type { ArtifactRef } from "./contracts.ts";
import type { AdapterContext } from "./adapters/types.ts";
import type { SubagentCaller } from "../data-analysis/index.ts";

export interface RunAnalysisGraphInput {
  objective: string;
  dataRefs: string[];
  format: "markdown" | "html" | "docx" | "pdf";
  /** Stable run id (re-run resumes the SAME run — used by live/replay
   *  comparison and human-resolution continuation). */
  runId?: string;
}

/** Host-configured roots + snapshot + runtime options — never model params. */
export interface GraphToolConfig {
  storeRoot: string;
  featureSnapshotHash: string;
  effectiveFeatures: string[];
  /** Full feature states for snapshot hash recomputation (host-provided). */
  disabledFeatures?: string[];
  /** Resolves a trusted artifact id into a full ArtifactRef (host store). */
  artifactResolver?: (artifactId: string) => Promise<ArtifactRefLike | null>;
  /** The SAME event store the host wires into promotion (single instance,
   *  never re-derived paths). */
  eventStore?: import("./event-store.ts").GraphEventStore;
  /** Runtime options (ablation-controlled, not feature-controlled). */
  runtimeOptions?: {
    parallelism?: boolean;
    recovery?: boolean;
    feedbackRouting?: boolean;
    observability?: boolean;
  };
}

export interface ArtifactRefLike {
  artifactId: string;
  artifactType: string;
  contentHash: string;
  schemaVersion: string;
  createdByNodeId: string;
  queryId?: string;
  snapshotId?: string;
}

/** Deterministic runtime options from the active ablation profile. */
export function graphRuntimeOptions(): NonNullable<GraphToolConfig["runtimeOptions"]> {
  const profile = process.env.FEATURE_RUNTIME_PROFILE ?? "";
  // resolver profile names include the directory: ablation/no-graph-*
  return {
    parallelism: !profile.includes("no-graph-parallelism"),
    recovery: !profile.includes("no-graph-recovery"),
    feedbackRouting: !profile.includes("no-graph-feedback-routing"),
    observability: !profile.includes("no-graph-observability"),
  };
}

export interface RunAnalysisGraphResult {
  runId: string;
  status: string;
  nodeCount: number;
  failedNodes: string[];
  blockedCodes: string[];
  /** Deterministic projection of the final state (live vs replay compare). */
  stateHash: string;
}

/** Host wiring point: the extension injects real adapters here. */
export interface GraphToolHost {
  adapters: Map<string, import("./adapters/types.ts").GraphNodeAdapter>;
  subagent?: SubagentCaller;
  capabilities?: Map<string, import("./graph-validator.ts").CapabilityDescriptor>;
  principal?: AdapterContext["principal"];
}

let host: GraphToolHost | null = null;
let config: GraphToolConfig | null = null;

export function setGraphToolHost(h: GraphToolHost | null, cfg?: GraphToolConfig): void {
  host = h;
  if (cfg) config = cfg;
}

export async function runAnalysisGraph(input: RunAnalysisGraphInput): Promise<RunAnalysisGraphResult> {
  if (!host) {
    throw new Error("GRAPH_TOOL_NOT_WIRED: no graph tool host configured (round6.graph_tool needs host wiring)");
  }
  const { GraphEventStore } = await import("./event-store.ts");
  const { GraphExecutor, RUN_ID_RE } = await import("./executor.ts");
  const { graphCapabilityMap } = await import("./capability-registry.ts");
  const { compileGraphSpec } = await import("./graph-compiler.ts");

  // store root is HOST-configured; never derived from model input. The host
  // MAY inject its own GraphEventStore instance (the SAME one its promotion
  // adapter reads) so event paths can never diverge.
  const storeRoot = config?.storeRoot ?? process.env.GRAPH_STORE_ROOT ?? `${process.env.HOME ?? ""}/.pi/artifacts/graph-engine`;
  const store = config?.eventStore ?? new GraphEventStore(storeRoot);
  const caps = host.capabilities ?? graphCapabilityMap();

  // semantic A: dataRefs are TRUSTED MATERIALIZED artifact ids. They enter
  // the run as initial artifacts (never as validatedQueryIds to execute).
  const initialArtifacts: ArtifactRefLike[] = [];
  if (input.dataRefs.length > 0) {
    if (!config?.artifactResolver) {
      throw new Error("GRAPH_TOOL_NOT_WIRED: host artifactResolver required for dataRefs");
    }
    for (const id of input.dataRefs) {
      const ref = await config.artifactResolver(id);
      if (!ref) {
        throw new Error(`GRAPH_INPUT_UNRESOLVABLE: trusted artifact ${id} not found`);
      }
      // sys.inputs owns these refs in the graph (origin preserved)
      initialArtifacts.push({ ...ref, createdByNodeId: "sys.inputs" });
    }
  }

  const plan = {
    planId: `plan_${input.objective.slice(0, 24)}`,
    version: 1,
    goal: input.objective,
    tasks: [{
      taskId: "analysis",
      title: input.objective,
      objective: input.objective,
      capability: "analysis.run",
      dependsOn: [] as string[],
      inputs: input.dataRefs.length ? ["dataset"] : [],
      expectedOutputs: ["analysis-result"],
      parallelizable: false,
      optional: false,
    }],
  };
  const spec = compileGraphSpec({
    plan,
    planRef: {
      artifactId: `plan_${contentHash(input.objective).slice(0, 16)}`,
      artifactType: "task-plan",
      contentHash: contentHash({ objective: input.objective, format: input.format }),
      schemaVersion: "1.0",
      createdByNodeId: "requirement-planning",
    },
    objective: input.objective,
    featureSnapshotHash: config?.featureSnapshotHash ?? "runtime",
    graphVersion: 1,
    formalReport: true,
    reportFormat: input.format,
    initialArtifacts: initialArtifacts as ArtifactRef[],
  });

  const options = config?.runtimeOptions ?? graphRuntimeOptions();
  const executor = new GraphExecutor({
    store,
    adapters: host.adapters,
    capabilities: caps,
    effectiveFeatures: new Set(config?.effectiveFeatures ?? []),
    featureSnapshot: config ? {
      effectiveFeatureHash: config.featureSnapshotHash,
      effectiveFeatures: config.effectiveFeatures ?? [],
      disabledFeatures: config.disabledFeatures,
    } : undefined,
    parallelismEnabled: options.parallelism,
    recoveryEnabled: options.recovery,
    feedbackRoutingEnabled: options.feedbackRouting,
    principal: host.principal,
  });
  const run = await executor.run(spec, {
    initialArtifacts: initialArtifacts as ArtifactRef[],
    runId: input.runId,
  });
  const failedNodes = Object.values(run.state.nodeRuns)
    .filter((n) => n.status === "FAILED" || n.status === "BLOCKED")
    .map((n) => n.nodeId);
  const blockedCodes = [...new Set(Object.values(run.state.nodeRuns)
    .filter((n) => n.errorCode)
    .map((n) => n.errorCode!))];
  return {
    runId: run.runId,
    status: run.state.status,
    nodeCount: spec.nodes.length,
    failedNodes,
    blockedCodes,
    // deterministic projection of the final state (live vs replay compare)
    stateHash: (await import("./state-reducer.ts")).stateHash(run.state),
  };
}

/** Read-only inspection (never mutates). */
export async function inspectGraphRun(runId: string): Promise<{
  summary: string;
  details: Record<string, unknown>;
}> {
  if (!graphRuntimeOptions().observability) {
    return { summary: "inspect_graph_run: observability disabled (ablation)", details: { disabled: true } };
  }
  if (!/^[a-z0-9_-]{1,64}$/.test(runId)) {
    return { summary: `inspect_graph_run: invalid runId`, details: { error: "INVALID_RUN_ID" } };
  }
  const root = config?.storeRoot ?? process.env.GRAPH_STORE_ROOT ?? `${process.env.HOME ?? ""}/.pi/artifacts/graph-engine`;
  const { GraphEventStore } = await import("./event-store.ts");
  const store = new GraphEventStore(root);
  const events = store.allEvents(runId);
  const nodeRuns: Array<{ nodeId: string; status: string; errorCode?: string }> = [];
  for (const ev of events) {
    if (ev.nodeId && (ev.eventType === "NODE_SUCCEEDED" || ev.eventType === "NODE_FAILED" || ev.eventType === "NODE_BLOCKED")) {
      nodeRuns.push({ nodeId: ev.nodeId, status: ev.eventType.replace("NODE_", ""), errorCode: ev.errorCode });
    }
  }
  const last = events[events.length - 1];
  return {
    summary: `graph run ${runId}: ${last?.eventType ?? "NO_EVENTS"} (${events.length} events, ${nodeRuns.length} node results)`,
    details: { runId, eventCount: events.length, lastEvent: last?.eventType ?? null, nodes: nodeRuns },
  };
}


