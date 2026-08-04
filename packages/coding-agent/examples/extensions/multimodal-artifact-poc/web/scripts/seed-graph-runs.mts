/**
 * Analytica Web UI — dev seed: generate REAL graph runs through the real
 * GraphExecutor + GraphEventStore (real hash chain, real reducer
 * projection) using the POC's deterministic fake adapters.
 *
 * These runs are engine executions, not hardcoded mockups; the UI labels
 * them `source: dev-seed(fake-adapters)`. Production runs are produced by
 * the host-wired run_analysis_graph path.
 *
 * Run: node --experimental-strip-types scripts/seed-graph-runs.mts
 * (idempotent: existing seed runs are skipped, never overwritten)
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { okAdapter, failAdapter, flakyAdapter, verdictAdapter } from "../../src/graph-engine/adapters/fake.ts";
import { GRAPH_CAPABILITIES, graphCapabilityMap } from "../../src/graph-engine/capability-registry.ts";
import type { ArtifactRef } from "../../src/graph-engine/contracts.ts";
import { GraphEventStore } from "../../src/graph-engine/event-store.ts";
import { GraphExecutor } from "../../src/graph-engine/executor.ts";
import { compileGraphSpec } from "../../src/graph-engine/graph-compiler.ts";
import type { GraphNodeAdapter, AdapterResult, AdapterContext } from "../../src/graph-engine/adapters/types.ts";
import { contentHash } from "../../src/graph-engine/canonical.ts";

const here = dirname(fileURLToPath(import.meta.url));
const STORE_ROOT = join(here, "..", "dev-data", "graph-engine");

// every registry feature treated as effective (all-enabled dev profile)
const EFFECTIVE = new Set(Object.values(GRAPH_CAPABILITIES).map((c) => c.featureId));

function baseAdapters(): Map<string, GraphNodeAdapter> {
  const m = new Map<string, GraphNodeAdapter>();
  m.set("graph.governance.preflight", okAdapter("graph.governance.preflight", "verified-dataset"));
  m.set("graph.analysis.run", okAdapter("graph.analysis.run", "analysis-result"));
  m.set("graph.analysis.fan_in", okAdapter("graph.analysis.fan_in", "proposal"));
  m.set("graph.review.plan", okAdapter("graph.review.plan", "gate-decision"));
  m.set("graph.review.execute", verdictAdapter("graph.review.execute", "PASS"));
  m.set("graph.review.authorize", okAdapter("graph.review.authorize", "authorization"));
  m.set("skill.analysis.report", okAdapter("skill.analysis.report", "report"));
  m.set("graph.deliverable.verify", okAdapter("graph.deliverable.verify", "deliverable-check"));
  m.set("graph.query.execute", okAdapter("graph.query.execute", "dataset"));
  m.set("graph.catalog.search", okAdapter("graph.catalog.search", "catalog-result"));
  m.set("graph.dataset.inspect", okAdapter("graph.dataset.inspect", "inspect-result"));
  m.set("graph.data.quality", okAdapter("graph.data.quality", "quality-evidence"));
  m.set("graph.data.lineage", okAdapter("graph.data.lineage", "lineage-evidence"));
  m.set("graph.data.snapshot", okAdapter("graph.data.snapshot", "snapshot-evidence"));
  return m;
}

/** Reviewer that demands one revision, then passes (exercises the
 *  REVISION_REQUESTED feedback loop / Iterate cycle). */
function revisionThenPassAdapter(): GraphNodeAdapter {
  let calls = 0;
  return {
    capabilityId: "graph.review.execute",
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      calls++;
      const verdict = calls === 1 ? "CHANGES_REQUIRED" : "PASS";
      return {
        outputRefs: [
          { artifactId: `review_${contentHash(`${ctx.runId}:${ctx.node.nodeId}:${calls}`).slice(0, 12)}`, artifactType: "review-decision", contentHash: contentHash(`${verdict}:${calls}`), schemaVersion: "1.0", createdByNodeId: ctx.node.nodeId },
          { artifactId: `verdict:${verdict.toLowerCase()}`, artifactType: "verdict", contentHash: contentHash(verdict), schemaVersion: "1.0", createdByNodeId: ctx.node.nodeId },
        ],
        summary: `verdict ${verdict} (call ${calls})`,
      };
    },
  };
}

// trusted input dataset (semantic A: initialArtifacts enter as materialized refs)
const SEED_INPUT: ArtifactRef = {
  artifactId: `art_${contentHash("dev-seed-input").slice(0, 16)}`,
  artifactType: "dataset",
  contentHash: contentHash("dev-seed-input"),
  schemaVersion: "1.0",
  createdByNodeId: "sys.inputs",
};

function compile(objective: string, withQueryTask: boolean, reportFormat: "markdown" | "html") {
  const tasks = [
    ...(withQueryTask ? [{
      taskId: "query",
      title: "Fetch sales dataset",
      objective: "Execute the governed sales query",
      capability: "lakehouse.query.execute",
      dependsOn: [] as string[],
      inputs: ["dataset"],
      expectedOutputs: ["dataset"],
      parallelizable: false,
      optional: false,
    }] : []),
    {
      taskId: "analysis",
      title: objective,
      objective,
      capability: "analysis.run",
      dependsOn: withQueryTask ? ["query"] : ([] as string[]),
      inputs: ["dataset"],
      expectedOutputs: ["analysis-result"],
      parallelizable: false,
      optional: false,
    },
  ];
  return compileGraphSpec({
    plan: { planId: `plan_${contentHash(objective).slice(0, 12)}`, version: 1, goal: objective, tasks },
    planRef: {
      artifactId: `plan_${contentHash(objective).slice(0, 16)}`,
      artifactType: "task-plan",
      contentHash: contentHash({ objective, reportFormat }),
      schemaVersion: "1.0",
      createdByNodeId: "requirement-planning",
    } as ArtifactRef,
    objective,
    featureSnapshotHash: "dev-seed",
    graphVersion: 1,
    formalReport: true,
    reportFormat,
    initialArtifacts: [SEED_INPUT],
  });
}

async function seedRun(runId: string, build: () => { spec: ReturnType<typeof compile>; adapters: Map<string, GraphNodeAdapter> }): Promise<void> {
  const store = new GraphEventStore(STORE_ROOT);
  if (existsSync(join(STORE_ROOT, "runs", runId))) {
    console.log(`skip ${runId} (already seeded)`);
    return;
  }
  const { spec, adapters } = build();
  const executor = new GraphExecutor({
    store,
    adapters,
    capabilities: graphCapabilityMap(),
    effectiveFeatures: EFFECTIVE,
    maxRevisionCycles: 2,
  });
  const run = await executor.run(spec, { runId, initialArtifacts: [SEED_INPUT] });
  const issues = store.scan(runId);
  if (issues.length > 0) throw new Error(`integrity scan failed for ${runId}: ${issues.join("; ")}`);
  console.log(`seeded ${runId}: status=${run.state.status} nodes=${spec.nodes.length} revisions=${run.state.revisionCycles}`);
}

await seedRun("seed_success_markdown", () => ({
  spec: compile("分析全球智能手机市场趋势并生成正式报告", false, "markdown"),
  adapters: baseAdapters(),
}));

await seedRun("seed_query_analysis_html", () => ({
  spec: compile("查询销售数据并对比区域表现", true, "html"),
  adapters: baseAdapters(),
}));

await seedRun("seed_review_revision", () => {
  const adapters = baseAdapters();
  adapters.set("graph.review.execute", revisionThenPassAdapter());
  return { spec: compile("分析用户留存趋势（需一轮修订）", false, "markdown"), adapters };
});

await seedRun("seed_retry_transient", () => {
  const adapters = baseAdapters();
  adapters.set("graph.query.execute", flakyAdapter("graph.query.execute", 1));
  return { spec: compile("查询数据（首次瞬态失败后重试成功）", true, "markdown"), adapters };
});

await seedRun("seed_failed_analysis", () => {
  const adapters = baseAdapters();
  adapters.set("graph.analysis.run", failAdapter("graph.analysis.run", "HASH_MISMATCH"));
  return { spec: compile("分析任务（确定性失败示例）", false, "markdown"), adapters };
});

console.log(`store root: ${STORE_ROOT}`);
