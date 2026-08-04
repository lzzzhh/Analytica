# Data Agent Integration — Pi Agent ↔ Lakehouse 数据源接入

日期：2026-08-01
分支：`feature/cloud-lakehouse-datasource`

## 1. 接入总览

多模态/多 Agent 能力（第一轮）保持不变；本轮新增**可选数据源扩展**。数据源未配置时多模态功能完全独立可用。

```
用户问题
  → search_catalog        （找到数据集）
  → inspect_dataset       （schema / 分区 / snapshot）
  → 生成结构化 QueryPlan
  → validate_query        （拿到 validatedQueryId）
  → execute_query         （只按 id 执行，禁止自由 SQL）
  → get_data_quality      （确定性质量）
  → explain_lineage       （血缘）
  → EvidenceFact(kind="query") → EvidencePacket
  → 主 Agent 回答
```

## 2. 七个受控工具

注册于扩展入口（`index.ts`），与既有多模态工具共存：

| 工具 | 入参 | 输出要点 |
|------|------|---------|
| `search_catalog` | `q?` `layer?` `limit?` | datasetId/layer/tableName/字段列表 |
| `inspect_dataset` | `datasetId` | 字段/类型/分区/最新 snapshot/更新时间 |
| `validate_query` | 结构化 `QueryPlan` | `validatedQueryId` 或 issues（字段/分区/ODS/limit） |
| `execute_query` | `validatedQueryId` | queryId/snapshot/dataVersion/qualityStatus/lineageReference + 行摘要 + `facts`（EvidenceFact[]） |
| `get_data_quality` | `datasetId` | PASS/WARN/FAIL checks + profile |
| `explain_lineage` | `datasetId` | upstream/downstream |
| `get_snapshot` | `datasetId` | 快照列表（id/时间戳） |

**无 `run_sql`**。`execute_query` 的 schema 只有 `validatedQueryId` 一个字段。

## 3. TypeScript 侧结构

```
src/data-tools/
├── client.ts            # GatewayClient：8 个端点封装；GatewayError/GatewayUnavailableError
├── schemas.ts           # （工具 schema 内联于 tools.ts，TypeBox）
├── evidence-adapter.ts  # queryResultToFacts / queryResultSummary / sourceTypeFor
└── tools.ts             # 7 个 ToolDefinition + DATA_TOOLS 数组
```

未配置 `LAKEHOUSE_GATEWAY_URL` 时工具仍注册，但返回明确的"数据源未配置"提示——不崩溃、不影响 parse_image / parse_visual / parse_document / analyze_document / analyze_document_v2。

## 4. Evidence 扩展（向后兼容）

`src/evidence.ts` 的 `EvidenceSourceType` 扩展：

```typescript
type EvidenceSourceType =
  | "parse" | "cited" | "inferred"   // 原有三种，不变
  | "query" | "quality" | "lineage" | "snapshot";  // 新增

interface EvidenceFact {
  ...
  kind: EvidenceSourceType;
  metadata?: {                          // 新增可选
    datasetId: string;
    snapshotId?: string | number;
    dataVersion?: string;
    dataTimestamp?: string;
    qualityStatus?: string;
    queryId?: string;
    lineageReference?: string;
  };
}
```

合并优先级（`factPriority`）：**query(5) > parse(3) > cited(2) > quality/lineage/snapshot(2) > inferred(1)**。

**冲突处理**：PDF/图片/湖仓查询对同一 claim 给出不同值 → 确定性 merger 产出 `conflicts`（`resolution: "requires_verification"`），candidates 携带 `sourceType` + `evidence` 双源信息；模型**不自动选边**。

## 5. 与第一轮组件的交互

| 组件 | 关系 |
|------|------|
| 多模态工具（parse_image 等） | 不变；数据工具是**并列注册**的可选扩展 |
| L1/L2 编排 + 质量门 | 不变；数据工具事实以 `kind="query"` 进 Evidence 体系，可被 merger 合并/冲突 |
| Evidence Merger | 冲突语义扩展（sourceType 字段），旧逻辑（parse>cited>inferred）原样保留 |
| 主 Agent 上下文 | 只接收工具 content 摘要（≤20 行）+ 小结果集；大结果落盘 artifact |

## 6. 首个 PoC 场景（端到端演示，`experiments/e2e-lakehouse.mts` 复现）

**"查询指定数据集最近 7 天的记录量和缺失率，并说明数据最新时间、质量状态和来源表"**

实测链路（本地模式）。正式 datasetId 为 `namespace.table`（如 `ads.ads_sales_daily`）；短名（如 `ads_sales_daily`）仅在全局唯一时作为 alias 被解析：

```
search_catalog("sales_daily")        → dws.dws_sales_daily, ads.ads_sales_daily [ADS]
inspect_dataset("ads.ads_sales_daily") → 5 字段（event_date 分区、customer_id 敏感）
validate_query({sum(revenue) by region, between 07-25..07-31})
                                     → vq_...（OK）
execute_query(vq_...)                → queryId q_...、snapshot=4955557725747790000、
                                       dataVersion=v4955...、qualityStatus=PASS、
                                       lineageReference=lineage://...
get_data_quality(ads.ads_sales_daily) → PASS（4 rows, row_count PASS）
explain_lineage(ads.ads_sales_daily) → upstream: dws.dws_sales_daily
get_snapshot(ads.ads_sales_daily)    → 1 snapshot（最新时间戳）
```

验证点（规格 §11 全部覆盖）：
- ✅ 原始大结果不进入 Agent 上下文（content 仅 6 行摘要 + facts）
- ✅ 返回 queryId / snapshot / dataVersion / qualityStatus / lineageReference
- ✅ 原始 SQL 在 API 边界被拒绝（400）
- ✅ ODS 层默认拒绝（`ods_denied`）
- ✅ 敏感字段（customer_id）掩码为 `***`

## 7. 安全边界

- 只读端点全集；无写接口（无 INSERT/UPDATE/DELETE/DROP 面）
- `execute_query` 仅接受 `validatedQueryId`（10 分钟有效）
- validate_query 强制：ODS 拒绝 / 分区过滤 / limit≤1000 / 扫描量 / 执行时间 / 危险 SQL 关键词防御
- 敏感字段输出掩码；审计日志 JSONL（`LAKEHOUSE_AUDIT_LOG`）；滑动窗口限流
- 测试零生产凭据（本地 tmp warehouse 由 pyiceberg 构建）

## 8. 已知限制

1. 本地模式 catalog 为 pyiceberg SQL catalog（SQLite 元数据），与生产 Spark 侧 hadoop catalog 布局不同——数据文件格式（parquet + Iceberg metadata）兼容；切换生产时 catalog 读取层需指向 Glue
2. aws 模式代码路径存在但**未实测**（需要生产凭据，本轮禁止接触）
3. 血缘为轻量实现（命名链接 + 手动边），无完整谱系图谱
4. 流式（Kafka→Flink）与写路径（PySpark 作业）未纳入 Gateway 范围——沿用原平台
5. `quality/lineage` 的 sourceType facts 目前主要由 execute_query 产生；quality/lineage/snapshot 结果以文本摘要 + details 返回，需要时可扩展为独立 facts

## 9. 下一阶段建议

1. aws 模式实测（Glue catalog + S3 warehouse，凭据就绪后）
2. 真实生产数据集接入（原平台 `data/warehouse` 四层已有真实 Iceberg 表——只读接入已验证可行）
3. lineage 增强（以 snapshot 元数据驱动的跨层图谱）
4. 流式数据新鲜度指标（Kafka 延迟 → quality 检查）
5. `domains/risk/` 领域模块填充（风控指标公式/AUC/KS 等，与通用层解耦）

## 10. CDXR 治理工具（2026-08-01，第三轮）— LEGACY（v0.6.0 起不再注册）

新增 5 个只读治理工具（`src/data-tools/tools.ts`），注册总数 12：

| 工具 | 读取 | 摘要必含 |
|------|------|---------|
| `get_dataset_governance_profile` | ADS trust profile | datasetId/snapshotId/governanceScore/status/openFindingCount/highestSeverity/dimensionScores/qualityStatus/lineageReference/findingIds/warnings |
| `list_governance_findings` | DWD findings（dedup 取最新） | id/rule/severity/status/confidence/summary |
| `inspect_governance_finding` | DWD 单条 | reason codes/references/生命周期 |
| `explain_governance_evidence` | DWD evidence | source/observed vs expected/evaluator |
| `get_governance_review_status` | ADS review queue | 待人工审核条目 |

Evidence：`EvidenceSourceType` 新增 `governance`（优先级 4，介于 query 与 parse 之间）；`governanceProfileToFacts`/`governanceFindingsToFacts` 适配器；冲突 → `requires_verification`，inferred 不覆盖 governance fact。未配置 CDXR 时工具返回"CDXR 未配置或无治理结果"，extension 不加载失败。详见 `CDXR_AGENT_INTEGRATION.md`。

> **v0.6.0（2026-08-01）**：上表 5 个工具已从 Agent 默认注册移除（代码/API/表保留为 LEGACY）。CDXR 现为按需训练数据检查：`assess_training_data`（`ENABLE_CDXR_TRAINING_TOOL=true` 时注册），`POST /v1/cdxr/training-assessments`，确定性 10 规则 + 状态聚合（BLOCK/REVIEW/INSUFFICIENT_EVIDENCE/ALLOW），引擎独立于网关（`services/cdxr-engine/`）。详见 `CDXR_AGENT_INTEGRATION.md` §6。
