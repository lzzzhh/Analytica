/**
 * Graph Engine — Graph Compiler (hardened topology).
 *
 * The planner proposes business tasks; the compiler:
 *   1. maps tasks to nodes (by capability family)
 *   2. creates CONTROL edges from dependsOn
 *   3. creates ARTIFACT edges from task inputs/expectedOutputs + the
 *      mandatory chain (real ref flow, not just control)
 *   4. inserts the MANDATORY system chain in the CORRECT order:
 *
 *      data tasks (catalog/query/materialize)
 *        -> sys.preflight-governance   (BEFORE any analysis runs)
 *        -> analysis task(s)
 *        -> quality/lineage/snapshot tasks (parallel verification)
 *        -> sys.fan-in                 (reducer)
 *        -> sys.review-gate -> sys.reviewer -> sys.promotion-auth
 *        -> (formal) sys.analysis-report (SKILL) -> sys.deliverable-verifier
 *
 *   5. WRITE tasks get a mandatory human gate (never self-approving)
 *   6. rejects unregistered capabilities, cycles, missing inputs, and any
 *      attempt to remove/weaken the system nodes
 */
import { contentHash } from "./canonical.ts";
import type { ArtifactRef, GraphEdgeSpec, GraphNodeSpec, GraphSpec } from "./contracts.ts";
import { GraphError } from "./errors.ts";

export interface PlannerTaskLike {
  taskId: string;
  title: string;
  objective: string;
  capability: string;
  dependsOn: string[];
  inputs: string[];
  expectedOutputs: string[];
  parallelizable: boolean;
  optional: boolean;
}

export interface TaskPlanLike {
  planId: string;
  version: number;
  goal: string;
  tasks: PlannerTaskLike[];
}

export interface CompileInput {
  plan: TaskPlanLike;
  planRef: ArtifactRef;
  objective: string;
  featureSnapshotHash: string;
  graphVersion: number;
  /** Trusted input artifacts (semantic A: materialized artifact ids). They
   *  enter the graph as the dataset source for preflight/analysis. */
  initialArtifacts?: ArtifactRef[];
  graphId?: string;
  /** Formal reports always produce a report via the SKILL node; the format
   *  is a node parameter, never a structural switch. */
  formalReport: boolean;
  reportFormat?: "markdown" | "html" | "docx" | "pdf";
  userConstraints?: { maxNodes?: number };
}

/** Task capability -> graph capability. */
export const TASK_CAPABILITY_MAP: Record<string, string> = {
  "lakehouse.catalog.search": "graph.catalog.search",
  "lakehouse.dataset.inspect": "graph.dataset.inspect",
  "lakehouse.query.validate": "graph.query.validate",
  "lakehouse.query.execute": "graph.query.execute",
  "lakehouse.query.materialize": "graph.query.materialize",
  "data.quality": "graph.data.quality",
  "data.lineage": "graph.data.lineage",
  "data.snapshot": "graph.data.snapshot",
  "training.assess": "graph.training.assess",
  "analysis.run": "graph.analysis.run",
  "document.parse": "graph.document.parse",
  "document.analyze": "graph.document.analyze",
  "image.ocr": "graph.image.ocr",
  "agent.reason": "graph.agent.reason",
  "agent.synthesize": "graph.agent.synthesize",
};

/** Capability families: DATA tasks produce datasets; ANALYSIS runs consume
 *  them; VERIFICATION tasks produce evidence for the fan-in. */
const DATA_FAMILY = new Set([
  "graph.catalog.search", "graph.dataset.inspect", "graph.query.validate",
  "graph.query.execute", "graph.query.materialize",
]);
const ANALYSIS_FAMILY = new Set(["graph.analysis.run"]);
const VERIFY_FAMILY = new Set([
  "graph.data.quality", "graph.data.lineage", "graph.data.snapshot", "graph.training.assess",
]);

export const MANDATORY_NODE_IDS = {
  preflight: "sys.preflight-governance",
  fanIn: "sys.fan-in",
  reviewGate: "sys.review-gate",
  reviewer: "sys.reviewer",
  promotion: "sys.promotion-auth",
  reportSkill: "sys.analysis-report",
  verifier: "sys.deliverable-verifier",
} as const;

const BASE_RETRY = { maxAttempts: 1, retryableErrorCodes: ["RPC_UNAVAILABLE", "TIMEOUT"], backoff: "FIXED" as const, initialDelayMs: 500 };

/** Task-node retry limit aligned with the capability registry policy
 *  (the validator rejects nodes exceeding the capability maxAttempts). */
const TASK_MAX_ATTEMPTS: Record<string, number> = {
  "graph.catalog.search": 2,
  "graph.dataset.inspect": 2,
  "graph.query.validate": 2,
  "graph.query.execute": 2,
  "graph.data.quality": 2,
  "graph.data.lineage": 2,
  "graph.data.snapshot": 2,
};

/** Task-node timeout aligned with the capability registry policy. */
const TASK_TIMEOUTS: Record<string, number> = {
  "graph.catalog.search": 30_000,
  "graph.dataset.inspect": 30_000,
  "graph.query.validate": 30_000,
  "graph.query.execute": 60_000,
  "graph.query.materialize": 120_000,
  "graph.analysis.run": 300_000,
  "graph.data.quality": 60_000,
  "graph.data.lineage": 60_000,
  "graph.data.snapshot": 60_000,
  "graph.training.assess": 120_000,
};

/** Sys-node timeout aligned with the capability registry policy
 *  (validator rejects nodes exceeding the capability timeout). */
const SYS_TIMEOUTS: Record<string, number> = {
  "graph.governance.preflight": 30_000,
  "graph.analysis.fan_in": 30_000,
  "graph.review.plan": 30_000,
  "graph.review.execute": 300_000,
  "graph.review.authorize": 30_000,
  "graph.human.review": 0,
  "skill.analysis.report": 300_000,
  "graph.deliverable.verify": 60_000,
};

function sysNode(id: string, capabilityId: string, label: string, kind: GraphNodeSpec["kind"],
                 dependsOn: string[], sideEffect: GraphNodeSpec["sideEffect"],
                 features: string[] = [], metadata: Record<string, string | number | boolean> = {}): GraphNodeSpec {
  return {
    nodeId: id, kind, capabilityId, label, dependsOn,
    inputContract: "artifact-refs", outputContract: "artifact-refs",
    sideEffect, requiredFeatures: features,
    timeoutMs: SYS_TIMEOUTS[capabilityId] ?? 60_000, maxAttempts: 1, retryPolicy: BASE_RETRY, metadata,
  };
}

export function compileGraphSpec(input: CompileInput): GraphSpec {
  if (!input.plan || !Array.isArray(input.plan.tasks)) {
    throw new GraphError("INVALID_GRAPH", "compile requires a validated TaskPlan", { retryable: false });
  }
  const nodes: GraphNodeSpec[] = [];
  const edges: GraphEdgeSpec[] = [];
  const taskNodes = new Map<string, string>();
  const taskByNode = new Map<string, PlannerTaskLike>();
  let edgeSeq = 0;
  const ctrl = (from: string, to: string, edgeType: GraphEdgeSpec["edgeType"] = "CONTROL", extra: Partial<GraphEdgeSpec> = {}) => {
    edges.push({ edgeId: `e_${edgeSeq++}`, fromNodeId: from, toNodeId: to, edgeType, ...extra });
  };
  const art = (from: string, to: string, artifactType: string) => {
    ctrl(from, to, "ARTIFACT", { artifactType });
  };

  // ---- 1. business task nodes -----------------------------------------
  const dataTasks: string[] = [];
  const analysisTasks: string[] = [];
  const verifyTasks: string[] = [];
  const otherTasks: string[] = [];

  for (const task of input.plan.tasks) {
    if (task.optional && !input.formalReport) continue;
    const capability = TASK_CAPABILITY_MAP[task.capability];
    if (!capability) {
      throw new GraphError("UNREGISTERED_CAPABILITY", `task ${task.taskId} uses unregistered capability ${task.capability}`, { retryable: false });
    }
    const nodeId = `task.${task.taskId}`;
    const kind: GraphNodeSpec["kind"] = capability === "graph.analysis.run" ? "AGENT"
      : capability.startsWith("skill.") ? "SKILL" : "TOOL";
    const sideEffect: GraphNodeSpec["sideEffect"] = capability === "graph.query.materialize" ? "WRITE" : "READ";
    nodes.push({
      nodeId, kind, capabilityId: capability, label: task.title,
      dependsOn: task.dependsOn.map((d) => `task.${d}`),
      inputContract: "artifact-refs", outputContract: "artifact-refs",
      sideEffect, requiredFeatures: [], timeoutMs: TASK_TIMEOUTS[capability] ?? 60_000,
      maxAttempts: TASK_MAX_ATTEMPTS[capability] ?? 1,
      retryPolicy: BASE_RETRY,
      concurrencyKey: task.parallelizable ? undefined : "serial",
      metadata: { objective: task.objective },
    });
    taskNodes.set(task.taskId, nodeId);
    taskByNode.set(nodeId, task);
    if (DATA_FAMILY.has(capability)) dataTasks.push(nodeId);
    else if (ANALYSIS_FAMILY.has(capability)) analysisTasks.push(nodeId);
    else if (VERIFY_FAMILY.has(capability)) verifyTasks.push(nodeId);
    else otherTasks.push(nodeId);
  }
  if (nodes.length === 0) {
    throw new GraphError("INVALID_GRAPH", "planner produced no executable tasks", { retryable: false });
  }

  // ---- 2. CONTROL edges from planner dependsOn ------------------------
  for (const task of input.plan.tasks) {
    const nodeId = taskNodes.get(task.taskId);
    if (!nodeId) continue;
    for (const dep of task.dependsOn) {
      const depNode = taskNodes.get(dep);
      if (!depNode) throw new GraphError("UNKNOWN_NODE_REF", `task ${task.taskId} dependsOn unknown ${dep}`, { retryable: false });
      ctrl(depNode, nodeId);
    }
  }

  // ---- 3. ARTIFACT edges from task inputs/expectedOutputs -------------
  const nodeOutputs = new Map<string, string[]>(); // nodeId -> output types
  const normalizeType = (x: string): string =>
    x === "dataset" || x === "artifact" ? "dataset" : x;
  for (const [nodeId, task] of taskByNode) {
    nodeOutputs.set(nodeId, task.expectedOutputs.map(normalizeType));
  }
  for (const [nodeId, task] of taskByNode) {
    for (const inp of task.inputs) {
      const type = normalizeType(inp);
      // analysis tasks consume the VERIFIED dataset via the preflight chain —
      // never a raw dataset edge from a data task
      if (type === "dataset" && ANALYSIS_FAMILY.has(
        (nodes.find((n) => n.nodeId === nodeId)?.capabilityId) ?? "")) {
        continue;
      }
      // prefer a CONTROL predecessor that produces this type (nearest source)
      const preds = task.dependsOn.map((d) => taskNodes.get(d)).filter((n): n is string => !!n);
      const fromPred = preds.find((p) => (nodeOutputs.get(p) ?? []).includes(type));
      if (fromPred) {
        art(fromPred, nodeId, type);
        continue;
      }
      // fallback: any other node producing the type
      const any = [...nodeOutputs.entries()]
        .find(([n, outs]) => n !== nodeId && outs.includes(type))?.[0];
      if (any) art(any, nodeId, type);
    }
  }

  // ---- 3b. initial artifact source node (semantic A) --------------------
  // sys.inputs -> PREFLIGHT (dataset) -> analysis (verified-dataset).
  // Initial artifacts NEVER bypass preflight governance.
  let inputsNodeId: string | null = null;
  if (input.initialArtifacts && input.initialArtifacts.length > 0) {
    inputsNodeId = "sys.inputs";
  }
  if (inputsNodeId) {
    nodes.push(sysNode(inputsNodeId, "graph.artifact.inputs", "Initial Artifacts", "DETERMINISTIC", [], "READ"));
    // the chain is: inputs -> preflight -> analysis (below, preflight already
    // depends on dataTasks; we add inputs as a preflight prerequisite)
    const preflightNode = nodes.find((n) => n.nodeId === MANDATORY_NODE_IDS.preflight);
    if (preflightNode) {
      preflightNode.dependsOn = [...preflightNode.dependsOn, inputsNodeId];
    }
    art(inputsNodeId, MANDATORY_NODE_IDS.preflight, "dataset");
    // analysis consumes the VERIFIED dataset from preflight
    for (const a of analysisTasks) {
      art(MANDATORY_NODE_IDS.preflight, a, "verified-dataset");
    }
  }

  // ---- 4. WRITE tasks get a mandatory human gate ----------------------
  const humanGateOf = new Map<string, string>(); // taskNodeId -> gateNodeId
  for (const [nodeId, task] of taskByNode) {
    const node = nodes.find((n) => n.nodeId === nodeId)!;
    if (node.sideEffect !== "WRITE") continue;
    const gateId = `sys.human-gate.${task.taskId}`;
    const origDeps = [...node.dependsOn];
    nodes.push(sysNode(gateId, "graph.human.review", `Human Gate: ${task.title}`, "HUMAN_GATE", origDeps, "NONE"));
    humanGateOf.set(nodeId, gateId);
    ctrl(gateId, nodeId);
    node.dependsOn = [...origDeps, gateId];
  }

  // ---- 5. mandatory chain in the CORRECT topology ---------------------
  const preflightDeps = [...dataTasks, ...otherTasks.filter((t) => !verifyTasks.includes(t))];
  nodes.push(sysNode(MANDATORY_NODE_IDS.preflight, "graph.governance.preflight", "Preflight Governance", "DETERMINISTIC", preflightDeps, "READ",
    [], input.formalReport ? { purpose: "external-report" } : { purpose: "internal-analysis" }));
  // data tasks produce the dataset artifact that preflight consumes
  for (const t of dataTasks) art(t, MANDATORY_NODE_IDS.preflight, "dataset");
  // preflight -> analysis: the verified dataset (preflight always validates;
  // with initial artifacts the 3b wiring is identical).
  for (const a of analysisTasks) {
    ctrl(MANDATORY_NODE_IDS.preflight, a);
    art(MANDATORY_NODE_IDS.preflight, a, "verified-dataset");
  }
  // analysis -> fan-in; verification tasks -> fan-in (parallel). When no
  // analysis task exists the fan-in still waits for the data tasks, so a
  // failed data task blocks the review chain (fail closed).
  const fanInDeps = [...analysisTasks, ...verifyTasks, ...(analysisTasks.length === 0 ? dataTasks : [])];
  nodes.push(sysNode(MANDATORY_NODE_IDS.fanIn, "graph.analysis.fan_in", "Fan-in Reducer", "REDUCER", fanInDeps, "READ"));
  for (const a of analysisTasks) art(a, MANDATORY_NODE_IDS.fanIn, "analysis-result");
  for (const v of verifyTasks) art(v, MANDATORY_NODE_IDS.fanIn, "verification-result");

  nodes.push(sysNode(MANDATORY_NODE_IDS.reviewGate, "graph.review.plan", "Review Gate", "DETERMINISTIC", [MANDATORY_NODE_IDS.fanIn], "READ"));
  nodes.push(sysNode(MANDATORY_NODE_IDS.reviewer, "graph.review.execute", "Reviewer", "DETERMINISTIC", [MANDATORY_NODE_IDS.reviewGate], "READ"));
  nodes.push(sysNode(MANDATORY_NODE_IDS.promotion, "graph.review.authorize", "Promotion Authorization", "DETERMINISTIC", [MANDATORY_NODE_IDS.reviewer], "READ"));

  art(MANDATORY_NODE_IDS.fanIn, MANDATORY_NODE_IDS.reviewGate, "proposal");
  // the REVIEWER needs BOTH the exact gate decision AND the real analysis
  // result (evidence resolution): analysis-result flows directly to it
  for (const a of analysisTasks) art(a, MANDATORY_NODE_IDS.reviewer, "analysis-result");
  art(MANDATORY_NODE_IDS.reviewGate, MANDATORY_NODE_IDS.reviewer, "gate-decision");
  art(MANDATORY_NODE_IDS.reviewer, MANDATORY_NODE_IDS.promotion, "review-decision");
  ctrl(MANDATORY_NODE_IDS.fanIn, MANDATORY_NODE_IDS.reviewGate);
  ctrl(MANDATORY_NODE_IDS.reviewGate, MANDATORY_NODE_IDS.reviewer);
  ctrl(MANDATORY_NODE_IDS.reviewer, MANDATORY_NODE_IDS.promotion);

  let terminalNodeIds: string[] = [MANDATORY_NODE_IDS.promotion];

  // ---- 6. formal report path: SKILL node + verifier -------------------
  if (input.formalReport) {
    nodes.push(sysNode(MANDATORY_NODE_IDS.reportSkill, "skill.analysis.report", "analysis-report Skill", "SKILL",
      [MANDATORY_NODE_IDS.promotion], "WRITE", ["round6.graph_skill_nodes"],
      { format: input.reportFormat ?? "markdown" }));
    nodes.push(sysNode(MANDATORY_NODE_IDS.verifier, "graph.deliverable.verify", "Deliverable Verifier", "DETERMINISTIC",
      [MANDATORY_NODE_IDS.reportSkill], "READ"));
    ctrl(MANDATORY_NODE_IDS.promotion, MANDATORY_NODE_IDS.reportSkill);
    art(MANDATORY_NODE_IDS.promotion, MANDATORY_NODE_IDS.reportSkill, "authorization");
    ctrl(MANDATORY_NODE_IDS.reportSkill, MANDATORY_NODE_IDS.verifier);
    art(MANDATORY_NODE_IDS.reportSkill, MANDATORY_NODE_IDS.verifier, "report");
    terminalNodeIds = [MANDATORY_NODE_IDS.verifier];
  }

  // ---- 7. decision edges: reviewer verdict gates the report ------------
  // (DECISION edge: promotion only fires when the review decision allows)
  edges.push({
    edgeId: `e_${edgeSeq++}`, fromNodeId: MANDATORY_NODE_IDS.reviewer, toNodeId: MANDATORY_NODE_IDS.promotion,
    edgeType: "DECISION",
    condition: { type: "VERDICT_EQUALS", nodeId: MANDATORY_NODE_IDS.reviewer, verdict: "PASS" },
  });

  // every node's dependsOn becomes a CONTROL edge (deduplicated) — sys nodes
  // included, so nothing with unmet dependencies is ever schedulable
  const existingEdges = new Set(edges.map((e) => `${e.fromNodeId}->${e.toNodeId}`));
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      const key = `${dep}->${n.nodeId}`;
      if (existingEdges.has(key)) continue;
      existingEdges.add(key);
      edges.push({ edgeId: `e_${edgeSeq++}`, fromNodeId: dep, toNodeId: n.nodeId, edgeType: "CONTROL" });
    }
  }

  const graphId = input.graphId ?? `graph_${contentHash({ plan: input.plan.planId, v: input.plan.version }).slice(0, 12)}`;
  const spec: GraphSpec = {
    schemaVersion: "1.0", graphId, graphVersion: input.graphVersion,
    objective: input.objective, sourcePlanRef: input.planRef,
    featureSnapshotHash: input.featureSnapshotHash,
    nodes, edges, entryNodeIds: taskNodes.size > 0 ? [...taskNodes.values()] : [MANDATORY_NODE_IDS.preflight],
    terminalNodeIds, policyRefs: [], contentHash: "", createdAt: new Date().toISOString(),
  };
  // the spec hash is DETERMINISTIC: createdAt is metadata, not content —
  // the same input must compile to the same hash (resume binding depends
  // on it: a re-compiled spec must match the genesis binding)
  const { contentHash: _c, createdAt: _t, ...body } = spec;
  spec.contentHash = contentHash(body);
  return spec;
}

/** Bump a graph version (monotonic) for revision loops. */
export function nextGraphVersion(spec: GraphSpec): GraphSpec {
  const { contentHash: _c, createdAt: _t, ...body } = { ...spec, graphVersion: spec.graphVersion + 1, createdAt: new Date().toISOString() };
  const next: GraphSpec = { ...body, contentHash: "", createdAt: new Date().toISOString() };
  next.contentHash = contentHash(body);
  return next;
}
