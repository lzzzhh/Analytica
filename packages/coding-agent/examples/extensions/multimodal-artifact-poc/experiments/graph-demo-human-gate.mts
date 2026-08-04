/**
 * Graph Engine 人审发布场景演示（自测用，无需模型，~20 秒）
 *
 * 场景：审查 ABSTAIN（语义评审不可用，fail-closed）
 *       -> 图停在 WAITING_FOR_HUMAN（executor 永不自我批准）
 *       -> Operator 明确选择 ACCEPT_RISK_FOR_REPORT（带 review/gate/policy 绑定）
 *       -> 同 runId resume -> promotion 验证人审 -> PUBLISH_REPORT 授权
 *       -> 报告节点 fail-closed（POC 内预期终点）
 *
 * 运行：node --experimental-strip-types experiments/graph-demo-human-gate.mts
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
import { recordHumanResolution } from "../src/graph-engine/executor.ts";
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

const root = mkdtempSync(join(tmpdir(), "graph-demo-hg-"));
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
console.log("1) 输入已注册:", CSV_ID);

const fakeSubagent = async (prompt: string, _o: { timeoutMs: number }) => {
  const m = /objective[：:\s]*([^\n]+)/.exec(prompt);
  const objective = m?.[1]?.trim() ?? "sum revenue";
  return { ok: true, text: `PLAN_JSON:\n${JSON.stringify({
    objective, analysisType: "DESCRIPTIVE",
    inputArtifacts: [CSV_ID], selectedColumns: ["date", "revenue"],
    steps: ["sum"], expectedOutputs: ["metrics"], methods: {}, assumptions: [], limitations: [],
  })}\nSCRIPT_START\nimport json, os\nm = json.load(open("input/input-manifest.json"))\nrows = []\nfor f in os.listdir("input"):\n    if f.endswith(".csv") or f.endswith(".data"):\n        with open(os.path.join("input", f), "rb") as fh: rows = fh.read()\njson.dump({"schemaVersion": "1.0", "artifactId": "art_placeholder0001", "runId": m["runId"], "status": "COMPLETED", "title": "revenue", "sections": [{"type": "METRIC_CARDS", "metrics": [{"metricId": "total", "label": "Total Revenue", "value": 450, "valueType": "NUMBER"}]}], "reviewStatus": "NOT_REVIEWED", "validationRefs": [], "createdAt": "2026-01-01T00:00:00Z"}, open(m["resultFile"], "w"))\nSCRIPT_END` } as never;
};

const resolveEvidence = (id: string) => resolveEvidenceFromStore(id, artifactStore);
const readFindings = async () => [];
// 语义评审不可用 -> 必需语义检查 UNAVAILABLE -> ABSTAIN（fail-closed）
const failSemantic = async () => { throw new Error("semantic reviewer unavailable"); };

setGraphToolHost({
  adapters: new Map([
    [preflightGovernanceAdapter({ resolveArtifact: async (id) => artifactStore.resolveArtifact(id) as never }).capabilityId,
     preflightGovernanceAdapter({ resolveArtifact: async (id) => artifactStore.resolveArtifact(id) as never })],
    [fanInAdapter().capabilityId, fanInAdapter()],
    [dataAnalysisAdapter({ store: artifactStore, subagent: fakeSubagent, featureSnapshot: { effectiveFeatures: EF }, readFindings }).capabilityId,
     dataAnalysisAdapter({ store: artifactStore, subagent: fakeSubagent, featureSnapshot: { effectiveFeatures: EF }, readFindings })],
    [reviewGateAdapter({ storeRoot, resolveEvidence, artifactStore }).capabilityId,
     reviewGateAdapter({ storeRoot, resolveEvidence, artifactStore })],
    [reviewerAdapter({ storeRoot, resolveEvidence, artifactStore, semanticReviewer: failSemantic }).capabilityId,
     reviewerAdapter({ storeRoot, resolveEvidence, artifactStore, semanticReviewer: failSemantic })],
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

// ---- 1) 第一次运行：审查 ABSTAIN，图停在人审门 ----
const runId = "run_human_demo_001";
const first = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [CSV_ID], format: "markdown", runId });
console.log("2) 审查结果 ABSTAIN -> 图状态:", first.status, "(等待人审，executor 永不自我批准)");

// ---- 2) 读 pending action 的绑定（reviewId/gateDecisionId/policyHash） ----
const events = eventStore.allEvents(runId);
const required = events.find((e) => e.eventType === "HUMAN_ACTION_REQUIRED")!;
const actionRef = required.refs[0]!.artifactId;
console.log("3) Pending action:", actionRef);
console.log("   绑定: review=" + required.meta["reviewId"], "gate=" + required.meta["gateDecisionId"], "policy=" + required.meta["policySnapshotHash"].slice(0, 12) + "...");

// ---- 3) Operator 明确选择 ACCEPT_RISK_FOR_REPORT（绑定必须完全一致） ----
const runGraph = events[0]!;
recordHumanResolution(eventStore, {
  actionRef,
  resolution: "APPROVED",
  action: "ACCEPT_RISK_FOR_REPORT",
  allowedActions: ["PUBLISH_REPORT"],
  originalReviewId: required.meta["reviewId"] ?? "",
  gateDecisionId: required.meta["gateDecisionId"] ?? "",
  policySnapshotHash: required.meta["policySnapshotHash"] ?? "",
  actorId: "operator-zh",
  principal: { source: "OPERATOR_CLI", actorId: "operator-zh", authenticated: true },
  reason: "accept risk for the revenue report",
  timestamp: new Date().toISOString(),
  graphId: runGraph.graphId,
  graphVersion: runGraph.graphVersion,
});
console.log("4) Operator 提交 ACCEPT_RISK_FOR_REPORT (allowedActions=[PUBLISH_REPORT])");

// ---- 4) 同 runId resume：promotion 验证人审 -> 授权 -> 报告 fail-closed ----
const resumed = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [CSV_ID], format: "markdown", runId });
const eventsAfter = eventStore.allEvents(runId);
const auth = eventsAfter.filter((e) => e.refs.some((r) => r.artifactType === "authorization"));
console.log("5) Resume 后状态:", resumed.status, "| 失败节点:", resumed.failedNodes.join(", ") || "(none)");
console.log("6) 发布授权 ref 数量:", auth.length, "(ABSTAIN + 显式人审批准 -> PUBLISH_REPORT 授权通过)");
console.log("7) 授权后到达报告节点:", resumed.failedNodes.includes("sys.analysis-report"),
  "| REPORT_SKILL_UNAVAILABLE =", resumed.blockedCodes.includes("REPORT_SKILL_UNAVAILABLE"), "(预期终点)");

// ---- 5) 反例演示：错误绑定/重复解析都会被拒 ----
try {
  recordHumanResolution(eventStore, {
    actionRef,
    resolution: "APPROVED",
    action: "ACCEPT_RISK_FOR_REPORT",
    allowedActions: ["PUBLISH_REPORT"],
    originalReviewId: required.meta["reviewId"] ?? "",
    gateDecisionId: required.meta["gateDecisionId"] ?? "",
    policySnapshotHash: required.meta["policySnapshotHash"] ?? "",
    actorId: "operator-zh",
    principal: { source: "OPERATOR_CLI", actorId: "operator-zh", authenticated: true },
    reason: "again",
    timestamp: new Date().toISOString(),
    graphId: runGraph.graphId,
    graphVersion: runGraph.graphVersion,
  });
  console.log("8) [反例] 同一 action 二次解析: 未被拒绝 (!)");
} catch (e) {
  console.log("8) [反例] 同一 action 二次解析被拒绝:", (e as Error).message);
}
try {
  recordHumanResolution(eventStore, {
    actionRef,
    resolution: "APPROVED",
    action: "APPROVE_EXECUTION", // 通用批准，不是发布授权
    allowedActions: [],
    originalReviewId: "",
    gateDecisionId: "",
    policySnapshotHash: "",
    actorId: "operator-zh",
    principal: { source: "OPERATOR_CLI", actorId: "operator-zh", authenticated: true },
    reason: "generic",
    timestamp: new Date().toISOString(),
    graphId: runGraph.graphId,
    graphVersion: runGraph.graphVersion,
  });
  console.log("9) [反例] 通用 APPROVE 冒充发布授权: 未被拒绝 (!)");
} catch (e) {
  console.log("9) [反例] 通用 APPROVE 冒充发布授权被拒绝（绑定校验）: OK");
}
