/**
 * Graph Engine 演示场景（自测用，无需模型，~15 秒）
 *
 * 场景：CSV 物化 -> 治理 Preflight -> 数据分析（fake subagent）
 *       -> 审查 Gate -> Reviewer（真实 orchestrator + 计算 Replay）
 *       -> 发布授权 -> 报告节点 fail-closed（POC 内预期终点）
 *
 * 运行：node --experimental-strip-types experiments/graph-demo.mts
 */
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGraphToolHost, runAnalysisGraph } from "../src/graph-engine/tool-runner.ts";
import { graphCapabilityMap } from "../src/graph-engine/capability-registry.ts";
import { preflightGovernanceAdapter, fanInAdapter, resolveEvidenceFromStore } from "../src/graph-engine/adapters/production.ts";
import { reviewGateAdapter, reviewerAdapter, promotionAdapter } from "../src/graph-engine/adapters/reviewer.ts";
import { analysisReportSkillAdapter, deliverableVerifierAdapter } from "../src/graph-engine/adapters/report.ts";
import { dataAnalysisAdapter } from "../src/graph-engine/adapters/data-analysis.ts";
import { ArtifactStore } from "../src/data-analysis/artifact-store.ts";
import { GraphEventStore } from "../src/graph-engine/event-store.ts";
import { featureHash } from "../src/features/hash.ts";
import { createHash } from "node:crypto";

const EF = [
  "round6.graph_engine", "round6.graph_executor", "round6.graph_scheduler",
  "round6.graph_event_store", "round6.graph_state_reducer", "round6.graph_validation",
  "round6.graph_review_integration", "round6.graph_skill_nodes", "round6.graph_artifact_edges",
  "round6.graph_human_gates", "round6.graph_observability", "round6.graph_frontend_render",
  "round6.graph_tool", "round2.catalog_tools", "round2.query_tools", "round4.data_analysis",
  "round5.reviewer", "round2.pipeline_governance",
];
const SNAP = {
  effectiveFeatureHash: featureHash({ features: Object.fromEntries(EF.map((id) => [id, true])) }),
  effectiveFeatures: EF,
  disabledFeatures: [] as string[],
};

// ---- 1) 注册输入数据集（materialize 的产物，带完整治理 meta） ----
const root = mkdtempSync(join(tmpdir(), "graph-demo-"));
const storeRoot = join(root, "reviewer-store");
const artifactStore = new ArtifactStore(join(root, "artifact-store"));
const eventStore = new GraphEventStore(storeRoot);

const CSV = "date,revenue\n2026-01-01,100\n2026-01-02,150\n2026-01-03,200";
const CSV_HASH = createHash("sha256").update(CSV).digest("hex");
const CSV_ID = "art_a1b2c3d4e5f60708";
artifactStore.register({
  artifactId: CSV_ID, contentType: "text/csv",
  contentHash: CSV_HASH, masked: true, createdAt: new Date().toISOString(),
  columns: ["date", "revenue"],
  queryId: "q_0000000000000001", snapshotId: "snap-e2e",
} as never, CSV);
console.log("1) 输入已注册:", CSV_ID, "(masked, snapshot snap-e2e, query q_...0001)");

// ---- 2) fake 分析 subagent（真实链路里这里是 pi 的 data-analysis subagent） ----
const fakeSubagent = async (prompt: string, _o: { timeoutMs: number }) => {
  const m = /objective[：:\s]*([^\n]+)/.exec(prompt);
  const objective = m?.[1]?.trim() ?? "sum revenue";
  return { ok: true, text: `PLAN_JSON:\n${JSON.stringify({
    objective, analysisType: "DESCRIPTIVE",
    inputArtifacts: [CSV_ID], selectedColumns: ["date", "revenue"],
    steps: ["sum"], expectedOutputs: ["metrics"], methods: {}, assumptions: [], limitations: [],
  })}\nSCRIPT_START\nimport json, os\nm = json.load(open("input/input-manifest.json"))\nrows = []\nfor f in os.listdir("input"):\n    if f.endswith(".csv") or f.endswith(".data"):\n        with open(os.path.join("input", f), "rb") as fh: rows = fh.read()\njson.dump({"schemaVersion": "1.0", "artifactId": "art_placeholder0001", "runId": m["runId"], "status": "COMPLETED", "title": "revenue", "sections": [{"type": "METRIC_CARDS", "metrics": [{"metricId": "total", "label": "Total Revenue", "value": 450, "valueType": "NUMBER"}]}], "reviewStatus": "NOT_REVIEWED", "validationRefs": [], "createdAt": "2026-01-01T00:00:00Z"}, open(m["resultFile"], "w"))\nSCRIPT_END` } as never;
};

// ---- 3) 真实 host 接线（与 index.ts wireGraphToolHost 一致） ----
const resolveEvidence = (id: string) => resolveEvidenceFromStore(id, artifactStore);
const readFindings = async () => [];
setGraphToolHost({
  adapters: new Map([
    [preflightGovernanceAdapter({ resolveArtifact: async (id) => artifactStore.resolveArtifact(id) as never }).capabilityId,
     preflightGovernanceAdapter({ resolveArtifact: async (id) => artifactStore.resolveArtifact(id) as never })],
    [fanInAdapter().capabilityId, fanInAdapter()],
    [dataAnalysisAdapter({ store: artifactStore, subagent: fakeSubagent, featureSnapshot: { effectiveFeatures: EF }, readFindings }).capabilityId,
     dataAnalysisAdapter({ store: artifactStore, subagent: fakeSubagent, featureSnapshot: { effectiveFeatures: EF }, readFindings })],
    [reviewGateAdapter({ storeRoot, resolveEvidence, artifactStore }).capabilityId,
     reviewGateAdapter({ storeRoot, resolveEvidence, artifactStore })],
    [reviewerAdapter({ storeRoot, resolveEvidence, artifactStore }).capabilityId,
     reviewerAdapter({ storeRoot, resolveEvidence, artifactStore })],
    [promotionAdapter({ storeRoot, readEventChain: async (rid) => eventStore.allEvents(rid) }).capabilityId,
     promotionAdapter({ storeRoot, readEventChain: async (rid) => eventStore.allEvents(rid) })],
    [analysisReportSkillAdapter().capabilityId, analysisReportSkillAdapter()],
    [deliverableVerifierAdapter().capabilityId, deliverableVerifierAdapter()],
  ]),
  capabilities: graphCapabilityMap(),
  principal: { source: "SYSTEM", actorId: "demo", authenticated: true },
}, {
  storeRoot,
  featureSnapshotHash: SNAP.effectiveFeatureHash,
  effectiveFeatures: EF,
  disabledFeatures: [],
  eventStore,
  artifactResolver: async (id: string) => {
    const rec = await artifactStore.resolveArtifact(id);
    if (!rec) return null;
    const meta = rec.meta as { contentHash?: unknown };
    return { artifactId: id, artifactType: "dataset", contentHash: String(meta.contentHash ?? ""), schemaVersion: "1.0", createdByNodeId: "materialize" };
  },
});

// ---- 4) 运行图 ----
const runId = "run_demo_001";
const result = await runAnalysisGraph({
  objective: "sum revenue",
  dataRefs: [CSV_ID],
  format: "markdown",
  runId,
});
console.log("4) 图运行:", result.status, "| 失败节点:", result.failedNodes.join(", ") || "(none)");

// ---- 5) 产物盘点 ----
const events = eventStore.allEvents(runId);
console.log("5) 事件流:",
  events.map((e) => e.eventType + (e.nodeId ? ":" + e.nodeId : "")).join(" "));
const reviewIdx = existsSync(join(storeRoot, "graph-review-index"))
  ? readdirSync(join(storeRoot, "graph-review-index")).filter((x) => !x.endsWith(".sha256")) : [];
if (reviewIdx.length > 0) {
  const idx = JSON.parse(readFileSync(join(storeRoot, "graph-review-index", reviewIdx[0]!), "utf8"));
  console.log("6) 审查索引: verdict=" + idx.verdict, "gate=" + idx.gateDecisionId, "policyHash=" + idx.policySnapshotHash.slice(0, 12) + "...");
}
const results = readdirSync(join(artifactStore["baseDir"] as string, "results"));
console.log("7) 分析产物 (ArtifactStore):", results.length, "个 (result/plan/manifest/script/input-manifest 均含 COMMITTED 事务)");
const frozenInputs = existsSync(join(storeRoot, "inputs"))
  ? readdirSync(join(storeRoot, "inputs")) : [];
console.log("8) 冻结输入 (ReviewerStore):", frozenInputs.length ? frozenInputs.join(", ") : "(无)");
const gates = existsSync(join(storeRoot, "gate")) ? readdirSync(join(storeRoot, "gate")).filter((x) => x.endsWith(".json")) : [];
console.log("9) Gate 数量:", gates.length, "(确定性 ID，崩溃窗口也无法产生第二个)");
console.log("10) 预期终点 REPORT_SKILL_UNAVAILABLE =", result.blockedCodes.includes("REPORT_SKILL_UNAVAILABLE"),
  "(POC 内报告 Skill 无本地接口，fail-closed 为预期)");
