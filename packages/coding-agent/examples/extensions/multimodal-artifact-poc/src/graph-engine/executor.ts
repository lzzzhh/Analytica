/**
 * Graph Engine — deterministic executor (hardened).
 *
 * Fail-closed guarantees:
 *  - BLOCKED nodes (upstream failed / condition false / artifact missing /
 *    capability unavailable) are NEVER executed and emit NODE_BLOCKED.
 *  - Reviewer verdicts control downstream execution through DECISION edges:
 *    PASS -> promotion authorizeAction(PUBLISH_REPORT) -> report READY;
 *    CHANGES_REQUIRED -> feedback router (revision);
 *    REJECT -> graph failed (no auto revision); ABSTAIN -> human gate/stop.
 *  - Human gates are NEVER approved by the executor: it writes
 *    HUMAN_ACTION_REQUIRED, sets WAITING_FOR_HUMAN and stops. An external
 *    operator entry submits an immutable resolution artifact; recovery
 *    re-verifies it.
 *  - Recovery scans the event chain first (any issue -> refuse), binds
 *    genesis events to the graph hash and run id, and never reruns
 *    succeeded nodes.
 */
import { contentHash, specContentHash } from "./canonical.ts";
import type { ArtifactRef, GraphRunState, GraphSpec } from "./contracts.ts";
import { GraphError, RETRYABLE_CODES } from "./errors.ts";
import { GraphEventStore } from "./event-store.ts";
import { assertValidGraphSpec, type CapabilityDescriptor } from "./graph-validator.ts";
import { nextGraphVersion } from "./graph-compiler.ts";
import { nextWave } from "./scheduler.ts";
import { newRunState, reduceEvent, replayRunState } from "./state-reducer.ts";
import type { AdapterContext, AdapterResult, GraphNodeAdapter } from "./adapters/types.ts";
import { routeFeedback, type FeedbackReasonCode } from "./router.ts";

export const RUN_ID_RE = /^[a-z0-9_-]{1,64}$/;

type NodeOutcome =
  | { nodeId: string; kind: "SUCCEEDED"; refs: ArtifactRef[]; result?: AdapterResult }
  | { nodeId: string; kind: "FAILED"; errorCode: string }
  | { nodeId: string; kind: "RETRY"; errorCode: string }
  | { nodeId: string; kind: "HUMAN_WAIT" };

/** Operator resolution action — the operator EXPLICITLY authorizes the
 *  follow-up. The adapter/executor NEVER upgrades a generic approval into
 *  a publish authorization: promotion only executes what this artifact
 *  explicitly allows. */
export type HumanResolutionAction =
  | "ACCEPT_RISK_FOR_REPORT"   // explicit: publish the report accepting risk
  | "REQUEST_NEW_REVIEW"       // explicit: re-run the review, no publish
  | "ALLOW_EXPLORATORY_ONLY"   // explicit: exploratory use only, no publish
  | "APPROVE_EXECUTION";       // generic execution approval (WRITE gates)

export interface HumanResolutionInput {
  actionRef: string;
  resolution: "APPROVED" | "REJECTED";
  /** Explicit operator-chosen action (REJECTED requires REQUEST_NEW_REVIEW
   *  or ALLOW_EXPLORATORY_ONLY; APPROVED may use any). */
  action: HumanResolutionAction;
  /** Actions this resolution explicitly allows (authorization source of
   *  truth for promotion — never inferred). */
  allowedActions: string[];
  /** The ABSTAIN review this resolution refers to. */
  originalReviewId: string;
  gateDecisionId: string;
  policySnapshotHash: string;
  actorId: string;
  principal: { source: "OPERATOR_CLI" | "USER_UI"; authenticated: boolean };
  reason?: string;
  timestamp: string;
}

export interface ExecutorOptions {
  store: GraphEventStore;
  adapters: Map<string, GraphNodeAdapter>;
  capabilities: Map<string, CapabilityDescriptor>;
  /** IMMUTABLE effective feature set of the run — mandatory; missing or
   *  mismatched snapshots refuse to start. */
  effectiveFeatures: ReadonlySet<string>;
  /** Feedback-loop budget: REVISION_REQUESTED cycles before the graph
   *  fails closed (REVISION_BUDGET_EXHAUSTED). */
  maxRevisionCycles?: number;
  /** Authoritative FULL feature snapshot (host-provided): when present, the
   *  executor RECOMPUTES the effective hash from the enabled/disabled sets
   *  and refuses to start on any mismatch — a caller can never pair a
   *  legitimate hash with a different feature set. */
  featureSnapshot?: {
    effectiveFeatureHash: string;
    effectiveFeatures: string[];
    disabledFeatures?: string[];
  };
  maxParallelNodes?: number;
  parallelismEnabled?: boolean;
  recoveryEnabled?: boolean;
  feedbackRoutingEnabled?: boolean;
  principal?: AdapterContext["principal"];
}

export interface ExecutorRunResult {
  runId: string;
  state: GraphRunState;
  terminal: boolean;
}

const SYSTEM_PRINCIPAL = { source: "SYSTEM" as const, actorId: "graph-executor", authenticated: true };

export class GraphExecutor {
  private readonly store: GraphEventStore;
  private readonly adapters: Map<string, GraphNodeAdapter>;
  private readonly capabilities: Map<string, CapabilityDescriptor>;
  private readonly maxParallelNodes: number;
  private readonly parallelismEnabled: boolean;
  private readonly recoveryEnabled: boolean;
  private readonly feedbackRoutingEnabled: boolean;
  private readonly effectiveFeatures: ReadonlySet<string>;
  private readonly maxRevisionCycles: number;
  private readonly featureSnapshot?: {
    effectiveFeatureHash: string;
    effectiveFeatures: string[];
    disabledFeatures?: string[];
  };
  private readonly principal: AdapterContext["principal"];

  constructor(opts: ExecutorOptions) {
    this.store = opts.store;
    this.adapters = opts.adapters;
    this.capabilities = opts.capabilities;
    if (!opts.effectiveFeatures) {
      throw new GraphError("SCHEMA_INVALID", "executor requires the immutable effective feature set", { retryable: false });
    }
    this.effectiveFeatures = opts.effectiveFeatures;
    this.featureSnapshot = opts.featureSnapshot;
    this.maxRevisionCycles = opts.maxRevisionCycles ?? 1;
    this.maxParallelNodes = opts.maxParallelNodes ?? 4;
    this.parallelismEnabled = opts.parallelismEnabled ?? true;
    this.recoveryEnabled = opts.recoveryEnabled ?? true;
    this.feedbackRoutingEnabled = opts.feedbackRoutingEnabled ?? true;
    this.principal = opts.principal ?? SYSTEM_PRINCIPAL;
  }

  /** Capabilities whose feature is effective in THIS run. */
  private availableCapabilities(): Set<string> {
    const out = new Set<string>();
    for (const [id, cap] of this.capabilities) {
      if (this.effectiveFeatures.has(cap.featureId)) out.add(id);
    }
    return out;
  }

  async run(spec: GraphSpec, input: { runId?: string; featureSnapshotHash?: string; initialArtifacts?: ArtifactRef[] } = {}): Promise<ExecutorRunResult> {
    if (input.featureSnapshotHash !== undefined && input.featureSnapshotHash !== spec.featureSnapshotHash) {
      throw new GraphError("SCHEMA_INVALID", "run featureSnapshotHash does not match the graph spec", { retryable: false });
    }
    if (this.featureSnapshot) {
      if (this.featureSnapshot.effectiveFeatureHash !== spec.featureSnapshotHash) {
        throw new GraphError("SCHEMA_INVALID", "spec featureSnapshotHash does not match the host snapshot", { retryable: false });
      }
      // RECOMPUTE the hash from the actual feature set: enabled + disabled
      // must reproduce the declared hash, and the enabled set must equal the
      // executor's immutable effectiveFeatures
      const states: Record<string, boolean> = {};
      for (const id of this.featureSnapshot.effectiveFeatures) states[id] = true;
      for (const id of this.featureSnapshot.disabledFeatures ?? []) states[id] = false;
      const { featureHash } = await import("../features/hash.ts");
      if (featureHash({ features: states }) !== this.featureSnapshot.effectiveFeatureHash) {
        throw new GraphError("SCHEMA_INVALID", "feature snapshot hash does not match its feature set (forged snapshot)", { retryable: false });
      }
      const enabledFromSnapshot = new Set(this.featureSnapshot.effectiveFeatures);
      const enabledDiff = [...this.effectiveFeatures].filter((id) => !enabledFromSnapshot.has(id));
      const extraDiff = [...enabledFromSnapshot].filter((id) => !this.effectiveFeatures.has(id));
      if (enabledDiff.length > 0 || extraDiff.length > 0) {
        throw new GraphError("SCHEMA_INVALID", "executor feature set does not match the host snapshot", { retryable: false });
      }
    }
    // feature gating is MANDATORY: the immutable effective set gates every
    // capability (a static capability map alone is never sufficient)
    assertValidGraphSpec(spec, {
      capabilities: this.capabilities,
      featureSnapshotHash: spec.featureSnapshotHash,
      effectiveFeatures: this.effectiveFeatures,
    });
    const runId = input.runId ?? `run_${contentHash({ g: spec.graphId, v: spec.graphVersion, t: Date.now() }).slice(0, 12)}`;
    if (!RUN_ID_RE.test(runId)) {
      throw new GraphError("SCHEMA_INVALID", `invalid runId '${runId}' (path characters forbidden)`, { retryable: false });
    }
    const featureSnapshotHash = input.featureSnapshotHash ?? spec.featureSnapshotHash;

    // recovery: integrity-scan the event chain FIRST (fail closed on damage)
    const existing = this.store.lastEvent(runId);
    if (existing) {
      return this.resume(spec, runId, featureSnapshotHash);
    }

    let state = newRunState({
      runId, graphId: spec.graphId, graphVersion: spec.graphVersion,
      graphContentHash: spec.contentHash, featureSnapshotHash,
      nodeIds: spec.nodes.map((n) => n.nodeId),
    });
    // genesis event BINDS the run to the exact graph + snapshot
    // persist the genesis spec immutably: recovery can always rebuild the
    // exact graph a run was created for
    this.store.writeSpec(runId, spec.graphVersion, spec);
    const genesis = this.store.append(runId, {
      graphId: spec.graphId, graphVersion: spec.graphVersion,
      eventType: "GRAPH_CREATED",
      refs: [{
        artifactId: spec.graphId, artifactType: "graph-spec",
        contentHash: spec.contentHash, schemaVersion: "1.0", createdByNodeId: "compiler",
      }],
      errorCode: undefined,
      meta: { graphContentHash: spec.contentHash, featureSnapshotHash },
    });
    void genesis;
    this.store.append(runId, { graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "GRAPH_VALIDATED", refs: [], meta: {} });
    state = reduceEvent(state, this.store.lastEvent(runId)!);
    // initial artifact protocol: trusted input refs enter the run as the
    // dataset source for preflight/analysis
    const initial = input.initialArtifacts ?? [];
    if (initial.length > 0) {
      state = reduceEvent(state, this.store.append(runId, {
        graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "ARTIFACT_ATTACHED", refs: initial, meta: {},
      }));
    }
    // sys.inputs node: the initial artifact source (deterministic, no adapter).
    // The refs are re-owned by sys.inputs (origin preserved) so the
    // scheduler's createdByNodeId binding holds.
    if (spec.nodes.some((n) => n.nodeId === "sys.inputs")) {
      const owned = initial.map((r) => ({
        ...r,
        createdByNodeId: "sys.inputs",
        originArtifactId: r.originArtifactId ?? r.artifactId,
        originCreatedBy: r.originCreatedBy ?? r.createdByNodeId,
      }));
      state = reduceEvent(state, this.store.append(runId, {
        graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "NODE_SUCCEEDED", nodeId: "sys.inputs",
        refs: owned, meta: {},
      }));
    }

    const terminal = await this.advance(spec, state, runId, featureSnapshotHash);
    return { runId, state: terminal.state, terminal: terminal.terminal };
  }

  private async advance(
    specIn: GraphSpec,
    initialState: GraphRunState,
    runId: string,
    featureSnapshotHash: string,
    resumed = false,
  ): Promise<{ state: GraphRunState; terminal: boolean }> {
    let spec = specIn;
    let state = initialState;
    let guard = 0;
    let lastRevisionCycles = initialState.revisionCycles ?? 0;
    while (guard++ < 512) {
      if (state.status === "WAITING_FOR_HUMAN") {
        return { state, terminal: false };
      }
      const wave = nextWave({
        spec, state,
        availableCapabilities: this.availableCapabilities(),
        maxParallelNodes: this.maxParallelNodes,
        parallelismEnabled: this.parallelismEnabled,
      });
      // BLOCKED nodes are recorded and never run (fail closed)
      for (const blocked of wave.blocked) {
        if (state.nodeRuns[blocked.nodeId]?.status !== "BLOCKED") {
          state = reduceEvent(state, this.store.append(runId, {
            graphId: spec.graphId, graphVersion: spec.graphVersion,
            eventType: "NODE_BLOCKED", nodeId: blocked.nodeId, refs: [],
            errorCode: "reasonCode" in blocked ? blocked.reasonCode : "BLOCKED",
          }));
        }
      }
      if (wave.ready.length === 0) break;
      // 1) SERIAL phase: NODE_STARTED per node, applied one by one — each
      //    node gets its OWN started attempt (no lastEvent guessing).
      //    RESUME SAFETY (P1-10): a crashed RUNNING node whose attempt
      //    budget is already spent is failed WITHOUT recording a phantom
      //    NODE_STARTED — the audit trail only ever shows attempts that
      //    actually ran.
      const startedStates = new Map<string, GraphRunState>();
      const readyOutcomes = new Map<string, NodeOutcome>();
      for (const r of wave.ready) {
        const wasResumedRunning = resumed && initialState.nodeRuns[r.nodeId]?.status === "RUNNING";
        const run = state.nodeRuns[r.nodeId];
        const nodeSpec = spec.nodes.find((n) => n.nodeId === r.nodeId);
        // human gates re-verify EXTERNAL resolutions and are never
        // attempt-bound
        if (nodeSpec?.kind !== "HUMAN_GATE" && wasResumedRunning && run && run.attempt >= Math.min(nodeSpec?.maxAttempts ?? 1, (nodeSpec ? this.capabilities.get(nodeSpec.capabilityId)?.retryPolicy.maxAttempts : undefined) ?? 1)) {
          readyOutcomes.set(r.nodeId, { nodeId: r.nodeId, kind: "FAILED", errorCode: "ATTEMPTS_EXHAUSTED" });
          continue;
        }
        state = reduceEvent(state, this.store.append(runId, {
          graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "NODE_STARTED",
          nodeId: r.nodeId, refs: [], meta: {},
        }));
        startedStates.set(r.nodeId, state);
      }
      // 2) PARALLEL phase: adapters run concurrently on their own started
      //    context (attempt count frozen per node); budget-exhausted resumed
      //    nodes are already decided (no phantom attempt recorded)
      const outcomes = [
        ...readyOutcomes.values(),
        ...await Promise.all(wave.ready
          .filter((r) => !readyOutcomes.has(r.nodeId))
          .map((r) => {
            const wasResumedRunning = resumed && initialState.nodeRuns[r.nodeId]?.status === "RUNNING";
            return this.executeNodeAdapter(spec, startedStates.get(r.nodeId)!, runId, featureSnapshotHash, r.nodeId, wasResumedRunning);
          })),
      ];
      // 3) SERIAL phase: apply each outcome to the live state
      for (const outcome of outcomes) {
        state = this.applyNodeOutcome(spec, state, runId, outcome);
      }
      // FEEDBACK LOOP: a REVISION_REQUESTED applied by an outcome started a
      // revision cycle — the routed nodes were reset by the reducer, so the
      // next wave re-executes them under a NEW graph version. The budget
      // bounds the cycles (fail closed, never an infinite loop).
      if ((state.revisionCycles ?? 0) > lastRevisionCycles) {
        lastRevisionCycles = state.revisionCycles ?? 0;
        if (lastRevisionCycles > this.maxRevisionCycles) {
          state = reduceEvent(state, this.store.append(runId, {
            graphId: spec.graphId, graphVersion: spec.graphVersion,
            eventType: "NODE_FAILED", nodeId: "sys.reviewer",
            refs: [], errorCode: "REVISION_BUDGET_EXHAUSTED", meta: {},
          }));
          this.store.append(runId, { graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "GRAPH_FAILED", refs: [], meta: {} });
          state = reduceEvent(state, this.store.lastEvent(runId)!);
          return { state, terminal: true };
        }
        spec = nextGraphVersion(spec);
        // persist the NEW spec immutably and bind it into the event so
        // recovery loads the LATEST spec, never the genesis one. (The
        // findings reach the revised target via the REVISION_REQUESTED
        // event refs — an ARTIFACT edge would deadlock on the reset chain.)
        this.store.writeSpec(runId, spec.graphVersion, spec);
        state = reduceEvent(state, this.store.append(runId, {
          graphId: spec.graphId, graphVersion: spec.graphVersion,
          eventType: "GRAPH_VERSION_CREATED",
          refs: [{
            artifactId: `${runId}/specs/v${spec.graphVersion}`,
            artifactType: "graph-spec",
            contentHash: spec.contentHash,
            schemaVersion: "1.0",
            createdByNodeId: "graph-executor",
          }],
          meta: { version: String(spec.graphVersion), contentHash: spec.contentHash },
        }));
        continue;
      }
    }
    const allTerminalDone = spec.terminalNodeIds.every((id) => {
      const s = state.nodeRuns[id];
      return s && (s.status === "SUCCEEDED" || s.status === "SKIPPED");
    });
    const anyFailed = Object.values(state.nodeRuns).some((n) => n.status === "FAILED" || n.status === "BLOCKED");
    if (anyFailed) {
      this.store.append(runId, { graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "GRAPH_FAILED", refs: [], meta: {} });
      state = reduceEvent(state, this.store.lastEvent(runId)!);
      return { state, terminal: true };
    }
    if (allTerminalDone) {
      this.store.append(runId, { graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "GRAPH_COMPLETED", refs: [], meta: {} });
      state = reduceEvent(state, this.store.lastEvent(runId)!);
      return { state, terminal: true };
    }
    return { state, terminal: false };
  }

  /** Parallel phase: run the adapter (STARTED is written first, serially). */
  private async executeNodeAdapter(
    spec: GraphSpec,
    state: GraphRunState,
    runId: string,
    featureSnapshotHash: string,
    nodeId: string,
    resumed = false,
  ): Promise<NodeOutcome> {
    const node = spec.nodes.find((n) => n.nodeId === nodeId)!;
    const run = state.nodeRuns[nodeId]!;
    if (run.status === "SUCCEEDED") return { nodeId, kind: "SUCCEEDED", refs: [] }; // never rerun
    // recovery safety: on RESUME a RUNNING node (in-flight attempt, crashed
    // before its outcome) must not re-execute past maxAttempts — attempts
    // are consumed by NODE_STARTED, so a crash after the last allowed
    // attempt FAILS instead of duplicating side effects. (In a live wave the
    // RUNNING status is the node's own in-flight attempt — never blocked.)
    // human gates are not attempt-bound: they re-verify EXTERNAL resolutions
    if (node.kind === "HUMAN_GATE") {
      const action = state.pendingHumanActions.find((a) => a.nodeId === nodeId);
      if (action?.resolved === true && action.resolution === "APPROVED") {
        return { nodeId, kind: "SUCCEEDED", refs: [] };
      }
      if (action?.resolved === true && action.resolution === "REJECTED") {
        return { nodeId, kind: "FAILED", errorCode: "HUMAN_APPROVAL_REQUIRED" };
      }
      return { nodeId, kind: "HUMAN_WAIT" };
    }
    const cap = this.capabilities.get(node.capabilityId);
    const budget = Math.min(node.maxAttempts, cap?.retryPolicy.maxAttempts ?? 1);
    if (resumed && run.status === "RUNNING" && run.attempt >= budget) {
      return { nodeId, kind: "FAILED", errorCode: "ATTEMPTS_EXHAUSTED" };
    }
    const maxAttempts = budget;
    const adapter = this.adapters.get(node.capabilityId);
    if (!adapter) {
      return { nodeId, kind: "FAILED", errorCode: "CAPABILITY_UNAVAILABLE" };
    }
    const timeoutMs = node.timeoutMs > 0
      ? Math.min(node.timeoutMs, cap?.timeoutPolicyMs ?? node.timeoutMs)
      : cap?.timeoutPolicyMs ?? 60_000;
    const inputRefs = [
      ...this.inputRefsFor(spec, state, nodeId),
      ...this.revisionFindingsFor(runId, nodeId),
    ];
    const controller = new AbortController();
    // STABLE operation key: runId/nodeId — attempt is separate (ctx.attempt)
    // so a retry can never look like a different operation to the adapter
    const idempotencyKey = `${runId}/${nodeId}`;
    const ctx: AdapterContext = {
      node, runId, graphId: spec.graphId, graphVersion: spec.graphVersion,
      state, inputRefs, featureSnapshotHash, principal: this.principal,
      idempotencyKey, attempt: run.attempt, abortSignal: controller.signal,
    };
    // single attempt per scheduling round; retries are scheduled across
    // waves so each retry gets its own NODE_STARTED (attempt counting)
    try {
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let result: AdapterResult;
      try {
        result = await withTimeout(adapter.execute(ctx), timeoutMs);
      } finally {
        clearTimeout(timer);
      }
      if (controller.signal.aborted) {
        return { nodeId, kind: "RETRY", errorCode: "TIMEOUT" };
      }
      for (const r of result.outputRefs) {
        if (!r.artifactId || !r.contentHash) {
          throw new GraphError("SCHEMA_INVALID", `adapter ${node.capabilityId} returned an invalid ref`, { retryable: false });
        }
      }
      return { nodeId, kind: "SUCCEEDED", refs: result.outputRefs, result };
    } catch (error) {
      const code = error instanceof GraphError ? error.code : "UNKNOWN_ERROR";
      const retryable = error instanceof GraphError
        ? (error.retryable ?? RETRYABLE_CODES.has(code))
        : node.retryPolicy.retryableErrorCodes.includes(code);
      if (retryable && run.attempt < maxAttempts) {
        return { nodeId, kind: "RETRY", errorCode: code };
      }
      return { nodeId, kind: "FAILED", errorCode: code };
    }
  }

  /** Serial phase: apply events + state transitions for one outcome. */
  private applyNodeOutcome(spec: GraphSpec, state: GraphRunState, runId: string, outcome: NodeOutcome): GraphRunState {
    const { nodeId } = outcome;
    if (outcome.kind === "HUMAN_WAIT") {
      const actionRef = `ha_${runId}@${nodeId}`;
      const ref: ArtifactRef = {
        artifactId: actionRef, artifactType: "human-action", contentHash: contentHash({ runId, nodeId }),
        schemaVersion: "1.0", createdByNodeId: nodeId,
      };
      return reduceEvent(state, this.store.append(runId, {
        graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "HUMAN_ACTION_REQUIRED", nodeId, refs: [ref], meta: {},
      }));
    }
    if (outcome.kind === "FAILED") {
      return reduceEvent(state, this.store.append(runId, {
        graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "NODE_FAILED", nodeId,
        refs: [], errorCode: outcome.errorCode ?? "UNKNOWN_ERROR", meta: {},
      }));
    }
    if (outcome.kind === "RETRY") {
      return reduceEvent(state, this.store.append(runId, {
        graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "NODE_RETRY_SCHEDULED", nodeId,
        refs: [], errorCode: outcome.errorCode, meta: {},
      }));
    }
    state = reduceEvent(state, this.store.append(runId, {
      graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "NODE_SUCCEEDED", nodeId,
      refs: outcome.refs, meta: {},
    }));
    // reviewer verdicts drive the decision flow
    const result = outcome.result;
    if (result) {
      const verdictRef = result.outputRefs.find((r) => r.artifactType === "verdict");
      if (verdictRef) {
        const typed = result.decision;
        const verdict = typed?.verdict ?? verdictRef.artifactId.replace("verdict:", "").toUpperCase() as never;
        state = reduceEvent(state, this.store.append(runId, {
          graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "REVIEW_COMPLETED", nodeId,
          refs: result.outputRefs, meta: { verdict },
        }));
        if (verdict === "CHANGES_REQUIRED") {
          if (!this.feedbackRoutingEnabled) {
            return reduceEvent(state, this.store.append(runId, {
              graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "NODE_BLOCKED", nodeId,
              refs: [], errorCode: "REVIEW_BLOCKED", meta: { reason: "feedback routing disabled" },
            }));
          }
          const codes = (typed?.reasonCodes ?? []).filter((c) => c.length > 0) as FeedbackReasonCode[];
          const routed = routeFeedback("CHANGES_REQUIRED", codes.length ? codes : ["METHOD"]);
          // HUMAN_GATE target (PERMISSION/POLICY codes): a REAL pending
          // human action — never a data re-run
          if (routed.target === "HUMAN_GATE") {
            const actionRef = `ha_${runId}@${nodeId}@permission@${spec.graphVersion}@${state.revisionCycles ?? 0}`;
            const ref: ArtifactRef = {
              artifactId: actionRef, artifactType: "human-action",
              contentHash: contentHash({ runId, nodeId, reason: "CHANGES_REQUIRED", codes }),
              schemaVersion: "1.0", createdByNodeId: nodeId,
            };
            state = reduceEvent(state, this.store.append(runId, {
              graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "HUMAN_ACTION_REQUIRED", nodeId, refs: [ref],
              meta: { reason: "PERMISSION", reviewId: typed?.reviewDecisionRef?.artifactId ?? "", gateDecisionId: "", policySnapshotHash: "" },
            }));
            return state;
          }
          // REQUIREMENT target: no requirement-planning node exists in this
          // graph — pretending to re-plan would be a lie, so the graph
          // fails CLOSED (an honest stop, not a blind re-run)
          if (routed.target === "REQUIREMENT") {
            state = reduceEvent(state, this.store.append(runId, {
              graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "NODE_FAILED", nodeId,
              refs: [], errorCode: "REQUIREMENT_REPLAN_UNSUPPORTED", meta: { reasonCodes: codes.join("|") },
            }));
            return state;
          }
          state = reduceEvent(state, this.store.append(runId, {
            graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "ROUTE_SELECTED", nodeId,
            refs: [], meta: { target: routed.target ?? "none", consumesRevision: String(routed.consumesRevisionCycle) },
          }));
          // FEEDBACK LOOP: the routed target + its topological successors
          // are reset (reducer), then the next wave re-executes them under
          // a bumped graph version. The REVISION_REQUESTED carries the
          // typed RevisionArtifact: previous proposal ref + the REAL finding
          // refs (hash-bound) + reason codes + target + revision number —
          // the revision is NEVER a blind re-run of the same request
          const resetNodes = this.resetSetFor(spec, routed.target ?? "DATA_ANALYSIS");
          const findingRefs = result?.decision?.findingRefs ?? [];
          const previousProposal = result?.decision?.reviewDecisionRef;
          state = reduceEvent(state, this.store.append(runId, {
            graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "REVISION_REQUESTED", nodeId,
            refs: [
              ...(previousProposal ? [previousProposal] : []),
              ...findingRefs,
            ],
            meta: {
              target: routed.target ?? "DATA_ANALYSIS",
              reasonCodes: codes.join("|"),
              requiredChanges: codes.join("|"),
              resetNodes: resetNodes.join(","),
              revisionNumber: String((state.revisionCycles ?? 0) + 1),
            },
          }));
        } else if (verdict === "ABSTAIN") {
          const abstainCodes = (typed?.reasonCodes ?? []) as FeedbackReasonCode[];
          const routed = routeFeedback("ABSTAIN", abstainCodes.length > 0 ? abstainCodes : ["MISSING_REQUIRED_EVIDENCE"]);
          state = reduceEvent(state, this.store.append(runId, {
            graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "ROUTE_SELECTED", nodeId,
            refs: [], meta: { target: routed.target ?? "HUMAN_GATE" },
          }));
          // ABSTAIN with human evidence need -> a REAL pending human action.
          // The action carries the EXACT review/gate/policy binding the
          // operator resolution artifact must reference (P0-4: the operator
          // chooses the action explicitly; nothing is inferred later)
          if (routed.target === "HUMAN_GATE") {
            const humanCtx = result?.decision?.humanActionContext;
            // the action id is BOUND to the exact review/gate/graph version/
            // revision cycle — two ABSTAIN reviews on the same run can never
            // collide on one action
            const actionRef = `ha_${runId}@${nodeId}@${humanCtx?.reviewId ?? "?"}@${humanCtx?.gateDecisionId ?? "?"}@${spec.graphVersion}@${state.revisionCycles ?? 0}`;
            const ref: ArtifactRef = {
              artifactId: actionRef, artifactType: "human-action",
              contentHash: contentHash({
                runId, nodeId, reason: "ABSTAIN",
                reviewId: humanCtx?.reviewId ?? "",
                gateDecisionId: humanCtx?.gateDecisionId ?? "",
                graphVersion: spec.graphVersion,
                revisionCycles: state.revisionCycles ?? 0,
              }),
              schemaVersion: "1.0", createdByNodeId: nodeId,
            };
            state = reduceEvent(state, this.store.append(runId, {
              graphId: spec.graphId, graphVersion: spec.graphVersion, eventType: "HUMAN_ACTION_REQUIRED", nodeId, refs: [ref],
              meta: {
                reason: "ABSTAIN",
                reviewId: humanCtx?.reviewId ?? "",
                gateDecisionId: humanCtx?.gateDecisionId ?? "",
                policySnapshotHash: humanCtx?.policySnapshotHash ?? "",
              },
            }));
          }
        }
      }
    }
    return state;
  }

  /** Feedback-loop reset set: the routed node family + every node that
   *  consumes its outputs (topological successors across all edge kinds). */
  private resetSetFor(spec: GraphSpec, target: string): string[] {
    const seeds: string[] = [];
    if (target === "PREFLIGHT") {
      seeds.push("sys.preflight-governance");
    } else if (target === "REPORT_SKILL") {
      // report quality findings re-run the REPORT chain only (never the
      // data analysis)
      const report = spec.nodes.find((n) => n.capabilityId === "skill.analysis.report");
      if (report) seeds.push(report.nodeId);
    } else if (target === "REQUIREMENT") {
      // no requirement node exists: nothing to reset (the executor fails
      // closed before reaching here)
      return [];
    } else {
      const analysis = spec.nodes.find((n) => n.capabilityId === "graph.analysis.run");
      if (analysis) seeds.push(analysis.nodeId);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push(id);
      for (const e of spec.edges) {
        if (e.fromNodeId === id) visit(e.toNodeId);
      }
    };
    for (const seed of seeds) visit(seed);
    return out;
  }

  /** Revision findings: the hash-bound review-finding refs recorded on the
   *  LATEST REVISION_REQUESTED event flow into the routed target's input
   *  refs (never a blind re-run; no ARTIFACT edge needed). */
  private revisionFindingsFor(runId: string, nodeId: string): ArtifactRef[] {
    const events = this.store.allEvents(runId);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.eventType !== "REVISION_REQUESTED") continue;
      // findings only ride into the analysis target (report revisions get
      // their own routing)
      if (ev.meta["target"] !== "DATA_ANALYSIS") return [];
      return ev.refs.filter((r) => r.artifactType === "review-finding");
    }
    return [];
  }

  private inputRefsFor(spec: GraphSpec, state: GraphRunState, nodeId: string): ArtifactRef[] {
    const refs: ArtifactRef[] = [];
    for (const e of spec.edges) {
      if (e.toNodeId === nodeId && e.edgeType === "ARTIFACT") {
        const src = state.nodeRuns[e.fromNodeId];
        if (!src) continue;
        const type = e.artifactType ?? "dataset";
        // ONLY the refs matching the edge's declared type flow to the target
        for (const r of src.outputRefs) {
          if (r.artifactType === type && r.createdByNodeId === e.fromNodeId) {
            if (!refs.some((existing) => existing.artifactId === r.artifactId)) refs.push(r);
          }
        }
      }
    }
    return refs;
  }

  /** Recovery: integrity scan FIRST (refuse on damage), bind the graph,
   *  re-verify human resolutions, then continue. */
  private async resume(
    spec: GraphSpec,
    runId: string,
    featureSnapshotHash: string,
  ): Promise<ExecutorRunResult> {
    if (!this.recoveryEnabled) {
      throw new GraphError("SCHEMA_INVALID", `recovery disabled: run ${runId} already exists`, { retryable: false });
    }
    const issues = this.store.scan(runId);
    if (issues.length > 0) {
      throw new GraphError("INVALID_GRAPH", `refusing recovery: event chain damaged (${issues.slice(0, 3).join("; ")})`, { retryable: false });
    }
    const events = this.store.allEvents(runId);
    const genesis = events.find((e) => e.eventType === "GRAPH_CREATED");
    if (genesis) {
      const bound = genesis.refs.find((r) => r.artifactType === "graph-spec");
      const meta = (genesis as unknown as { meta?: Record<string, string> }).meta ?? {};
      if (!bound || bound.contentHash !== spec.contentHash) {
        throw new GraphError("INVALID_GRAPH", `GRAPH_RUN_BINDING_MISMATCH: run ${runId} was created for a different graph`, { retryable: false });
      }
      if (meta.featureSnapshotHash && meta.featureSnapshotHash !== featureSnapshotHash) {
        throw new GraphError("INVALID_GRAPH", `GRAPH_RUN_BINDING_MISMATCH: run ${runId} feature snapshot differs`, { retryable: false });
      }
    }
    // REVISION RECOVERY: the latest persisted spec is authoritative — a run
    // that bumped its graph version before a crash resumes under the LATEST
    // spec (with its gate op-keys and topology), never the genesis one
    const versionEvents = events
      .filter((e) => e.eventType === "GRAPH_VERSION_CREATED")
      .sort((a, b) => b.sequence - a.sequence);
    const latestVersion = versionEvents[0];
    if (latestVersion) {
      const v = Number(latestVersion.meta["version"] ?? "0");
      const persisted = this.store.readSpec(runId, v);
      if (persisted && typeof persisted === "object") {
        spec = persisted as GraphSpec;
      } else {
        throw new GraphError("INVALID_GRAPH", `GRAPH_RUN_BINDING_MISMATCH: latest spec v${v} for run ${runId} is not persisted`, { retryable: false });
      }
    }
    const genesisVersion = genesis?.graphVersion ?? spec.graphVersion;
    // the genesis event itself establishes v1 (no GRAPH_VERSION_CREATED
    // needed for the first version)
    let lastVersion = genesisVersion;
    for (const ev of events) {
      if (ev.graphId !== spec.graphId) {
        throw new GraphError("INVALID_GRAPH", `GRAPH_RUN_BINDING_MISMATCH: event ${ev.sequence} belongs to ${ev.graphId}@${ev.graphVersion} but resume spec is ${spec.graphId}@${spec.graphVersion}`, { retryable: false });
      }
      // feedback revisions bump the graph version MONOTONICALLY; a version
      // below the previous one is a foreign/mixed run, and an UNANNOUNCED
      // jump (without a GRAPH_VERSION_CREATED event) is refused
      if (ev.graphVersion < lastVersion) {
        throw new GraphError("INVALID_GRAPH", `GRAPH_RUN_BINDING_MISMATCH: event ${ev.sequence} version ${ev.graphVersion} regressed below ${lastVersion}`, { retryable: false });
      }
      if (ev.graphVersion > lastVersion && ev.eventType !== "GRAPH_VERSION_CREATED") {
        throw new GraphError("INVALID_GRAPH", `GRAPH_RUN_BINDING_MISMATCH: event ${ev.sequence} jumps version ${ev.graphVersion} without GRAPH_VERSION_CREATED`, { retryable: false });
      }
      lastVersion = Math.max(lastVersion, ev.graphVersion);
    }
    const initial = newRunState({
      runId, graphId: spec.graphId, graphVersion: spec.graphVersion,
      graphContentHash: spec.contentHash, featureSnapshotHash,
      nodeIds: spec.nodes.map((n) => n.nodeId),
    });
    let state = replayRunState(initial, events);
    if (state.status === "COMPLETED" || state.status === "FAILED" || state.status === "CANCELLED") {
      return { runId, state, terminal: true };
    }
    // permission-controlled human review: an APPROVED resolution on an
    // ABSTAIN action produces a human-review-decision ref on the reviewer
    // node (the promotion DECISION condition accepts it)
    for (const action of state.pendingHumanActions) {
      if (action.resolved === true && action.resolution === "APPROVED") {
        const required = events.find((e) => e.eventType === "HUMAN_ACTION_REQUIRED"
          && e.refs.some((r) => r.artifactId === action.actionRef));
        if (required && required.meta["reason"] === "ABSTAIN") {
          // the human-review-decision ref binds the REAL resolution artifact
          // hash from the HUMAN_ACTION_RECORDED event (never a synthetic
          // hash) — promotion verifies ref.hash === recorded resolution hash
          const recorded = events.find((e) => e.eventType === "HUMAN_ACTION_RECORDED"
            && e.refs.some((r) => r.artifactId === action.actionRef));
          const resolutionHash = recorded?.refs.find((r) => r.artifactId === action.actionRef)?.contentHash;
          if (!resolutionHash) {
            throw new GraphError("INVALID_GRAPH", `human review resolution hash missing for ${action.actionRef}`, { retryable: false });
          }
          const decisionRef: ArtifactRef = {
            artifactId: `human-review:${action.actionRef}`,
            artifactType: "human-review-decision",
            contentHash: resolutionHash,
            schemaVersion: "1.0",
            createdByNodeId: required.nodeId ?? "",
          };
          state = reduceEvent(state, this.store.append(runId, {
            graphId: spec.graphId, graphVersion: spec.graphVersion,
            eventType: "NODE_SUCCEEDED", nodeId: required.nodeId ?? "", refs: [decisionRef], meta: {},
          }));
        }
      }
    }
    // pending human gates: re-verify external resolution artifacts (if any
    // were recorded as events, replay already applied them)
    const out = await this.advance(spec, state, runId, featureSnapshotHash, true);
    return { runId, state: out.state, terminal: out.terminal };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new GraphError("TIMEOUT", `adapter exceeded ${ms}ms`, { retryable: true })), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolvePromise(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** External operator entry: submit an immutable human resolution artifact. */
export function recordHumanResolution(
  store: GraphEventStore,
  input: HumanResolutionInput & { graphId: string; graphVersion: number },
): void {
  if (!input.principal.authenticated || (input.principal.source !== "OPERATOR_CLI" && input.principal.source !== "USER_UI")) {
    throw new GraphError("PERMISSION_DENIED", "human resolution requires an authenticated OPERATOR_CLI/USER_UI principal", { retryable: false });
  }
  if (input.resolution !== "APPROVED" && input.resolution !== "REJECTED") {
    throw new GraphError("SCHEMA_INVALID", "resolution must be APPROVED or REJECTED", { retryable: false });
  }
  const ACTIONS = ["ACCEPT_RISK_FOR_REPORT", "REQUEST_NEW_REVIEW", "ALLOW_EXPLORATORY_ONLY", "APPROVE_EXECUTION"] as const;
  if (!ACTIONS.includes(input.action)) {
    throw new GraphError("SCHEMA_INVALID", `unknown human resolution action ${String(input.action)}`, { retryable: false });
  }
  if (input.resolution === "REJECTED" && input.action !== "REQUEST_NEW_REVIEW" && input.action !== "ALLOW_EXPLORATORY_ONLY") {
    throw new GraphError("SCHEMA_INVALID", "a REJECTED resolution must be REQUEST_NEW_REVIEW or ALLOW_EXPLORATORY_ONLY", { retryable: false });
  }
  if (!Array.isArray(input.allowedActions) || input.allowedActions.some((a) => typeof a !== "string")) {
    throw new GraphError("SCHEMA_INVALID", "allowedActions must be a string array", { retryable: false });
  }
  const parts = input.actionRef.split("@");
  const runId = input.actionRef.slice(3, input.actionRef.indexOf("@")); // strip "ha_"
  const nodeId = parts[1] ?? "";
  // validate: the pending action must EXIST, be for a human gate, and the
  // run must not be terminal
  const events = store.allEvents(runId);
  const required = events.find((e) => e.eventType === "HUMAN_ACTION_REQUIRED"
    && e.nodeId === nodeId
    && e.refs.some((r) => r.artifactId === input.actionRef));
  if (!required) {
    throw new GraphError("ARTIFACT_MISSING", `no pending human action ${input.actionRef}`, { retryable: false });
  }
  // single-resolution rule: the SAME action can never be resolved twice
  if (events.some((e) => e.eventType === "HUMAN_ACTION_RECORDED"
    && e.refs.some((r) => r.artifactId === input.actionRef))) {
    throw new GraphError("SCHEMA_INVALID", `human action ${input.actionRef} already resolved`, { retryable: false });
  }
  // STRICT binding (P0-5): a PUBLISH authorization (ACCEPT_RISK_FOR_REPORT)
  // requires the operator-submitted review/gate/policy to be non-empty and
  // EXACTLY equal to the pending action's recorded binding — empty strings
  // can never skip the comparison. Generic execution approvals
  // (APPROVE_EXECUTION / ALLOW_EXPLORATORY_ONLY / REQUEST_NEW_REVIEW) are
  // not publish authorizations and carry no review binding.
  if (input.action === "ACCEPT_RISK_FOR_REPORT") {
    const expectedReview = required.meta["reviewId"] ?? "";
    const expectedGate = required.meta["gateDecisionId"] ?? "";
    const expectedPolicy = required.meta["policySnapshotHash"] ?? "";
    if (!expectedReview || !expectedGate || !expectedPolicy) {
      throw new GraphError("SCHEMA_INVALID", `pending action ${input.actionRef} lacks the review/gate/policy binding`, { retryable: false });
    }
    if (input.originalReviewId !== expectedReview) {
      throw new GraphError("SCHEMA_INVALID", `resolution reviewId ${input.originalReviewId || "(empty)"} != pending ${expectedReview}`, { retryable: false });
    }
    if (input.gateDecisionId !== expectedGate) {
      throw new GraphError("SCHEMA_INVALID", `resolution gateDecisionId ${input.gateDecisionId || "(empty)"} != pending ${expectedGate}`, { retryable: false });
    }
    if (input.policySnapshotHash !== expectedPolicy) {
      throw new GraphError("SCHEMA_INVALID", `resolution policySnapshotHash does not match the pending action`, { retryable: false });
    }
    // the action id's embedded binding must match too (collision guard)
    if (parts.length >= 5) {
      const boundReview = parts[2] ?? "";
      const boundGate = parts[3] ?? "";
      if (boundReview !== "?" && boundReview !== expectedReview) {
        throw new GraphError("SCHEMA_INVALID", `actionRef review binding ${boundReview} != pending ${expectedReview}`, { retryable: false });
      }
      if (boundGate !== "?" && boundGate !== expectedGate) {
        throw new GraphError("SCHEMA_INVALID", `actionRef gate binding ${boundGate} != pending ${expectedGate}`, { retryable: false });
      }
    }
  }
  const last = events[events.length - 1];
  if (last && (last.eventType === "GRAPH_COMPLETED" || last.eventType === "GRAPH_FAILED" || last.eventType === "GRAPH_CANCELLED")) {
    throw new GraphError("TERMINAL_RUN_IMMUTABLE", `run ${runId} is terminal; no resolutions allowed`, { retryable: false });
  }
  // structured reason only (no free-text into event meta). The resolution
  // artifact is immutable + hash-bound and carries the FULL authorization
  // semantics: action + allowedActions + the exact review/gate/policy it
  // refers to. Promotion must NOT infer any of these.
  const reasonCode = input.resolution === "REJECTED"
    ? "HUMAN_APPROVAL_REQUIRED"
    : input.action === "ACCEPT_RISK_FOR_REPORT" ? "HUMAN_ACCEPT_RISK" : "HUMAN_APPROVED";
  const resolutionBody = {
    actionRef: input.actionRef, resolution: input.resolution,
    action: input.action, allowedActions: input.allowedActions,
    originalReviewId: input.originalReviewId,
    gateDecisionId: input.gateDecisionId,
    policySnapshotHash: input.policySnapshotHash,
    actorId: input.actorId, principalSource: input.principal.source,
    reasonCode, timestamp: input.timestamp,
  };
  const resolutionRef: ArtifactRef = {
    artifactId: input.actionRef,
    artifactType: "human-action-resolution",
    contentHash: contentHash(resolutionBody),
    schemaVersion: "1.0",
    createdByNodeId: "operator-cli",
  };
  store.append(runId, {
    graphId: input.graphId, graphVersion: input.graphVersion, eventType: "HUMAN_ACTION_RECORDED",
    nodeId, refs: [resolutionRef],
    errorCode: input.resolution === "REJECTED" ? "HUMAN_APPROVAL_REQUIRED" : undefined,
    meta: {
      resolution: input.resolution,
      action: input.action,
      allowedActions: input.allowedActions.join(","),
      originalReviewId: input.originalReviewId,
      gateDecisionId: input.gateDecisionId,
      policySnapshotHash: input.policySnapshotHash,
      actorId: input.actorId,
      reasonCode,
    },
  });
}

/** Route a reviewer verdict through the feedback router (executor hook). */
export function applyVerdictRouting(verdict: string, reasonCodes: FeedbackReasonCode[]): ReturnType<typeof routeFeedback> {
  return routeFeedback(verdict as never, reasonCodes);
}
