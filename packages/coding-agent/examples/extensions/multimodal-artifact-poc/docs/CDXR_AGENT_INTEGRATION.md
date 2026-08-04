# CDXR Agent 集成 — Pi 治理工具、Evidence 接入与验收场景

日期：2026-08-01
代码：`src/data-tools/client.ts`（客户端）、`src/data-tools/tools.ts`（工具）、`src/data-tools/evidence-adapter.ts`（Evidence 适配）、`src/evidence.ts`（类型与合并器）

> **v0.6.0 更新（2026-08-01）**：CDXR 重构为按需训练数据适用性检查。新工具 `assess_training_data` 见 **§6**；旧治理平面（§1-§5）标注 **LEGACY** —— 代码/API/表保留、只读，但 5 个治理工具已从 Agent 默认注册移除（v0.6.0 起默认 7 个湖仓工具）。

## 1. 五个只读治理工具（通用命名，不绑定 CDXR 内部实现）— LEGACY

| 工具 | 读取层 | 摘要必含 |
|------|--------|---------|
| `get_dataset_governance_profile` | ADS trust profile | datasetId / snapshotId / governanceScore / status / openFindingCount / highestSeverity / dimensionScores / qualityStatus / lineageReference / findingIds / warnings |
| `list_governance_findings` | DWD findings | 每条：id / rule / severity / status / confidence / summary |
| `inspect_governance_finding` | DWD 单条 | reason codes / references / 生命周期 |
| `explain_governance_evidence` | DWD evidence | source type / observed vs expected / evaluator |
| `get_governance_review_status` | ADS review queue | 待人工审核条目（只读，不得自行关闭/豁免） |

读取顺序：默认先读 ADS trust profile，再按需下钻 DWS/DWD；**不得默认查询 governance ODS**（ODS 原始证据不进 Agent 上下文；`test_ods_raw_evidence_not_exposed_via_agent_reads` 断言 reader 公开方法不触碰 ODS raw 表）。

未配置（`LAKEHOUSE_GATEWAY_URL` 未设或治理表不存在）：工具返回"CDXR 未配置或无治理结果"，extension 不加载失败。

## 2. Evidence 接入（spec §11）

- `EvidenceSourceType` 新增 `"governance"`；`GovernanceFactMetadata` 含 findingId/runId/ruleId/datasetId/snapshotId/severity/reviewStatus/governanceScore/evidenceReferences/qualityReference/lineageReference
- 适配器：`governanceProfileToFacts`（profile → facts）、`governanceFindingsToFacts`（finding → facts，evidence=`governance:<finding_id>`）
- **优先级**：`query(5) > governance(4) > parse(3) > cited/quality/lineage/snapshot(2) > inferred(1)`
- **冲突处理**：CDXR 与查询结果同 claim 不同值 → `requires_verification`（绝不自动覆盖）；inferred 永远不能覆盖 governance fact（`mergeEvidence` 同值保留最高优先级源，异值进冲突列表）——测试 `governance conflict merge` 断言

## 3. 三个演示治理场景（ground truth：`infra/lakehouse/seed/cdxr_expected_results.json`）

固定 `--as-of 2026-07-31T12:00:00Z`（确定性：相同输入 → 相同 run/finding id；`reproducibility.runIds` 记录了已验证的 run id）。

| 场景 | 数据集 | 期望 findings | score / status |
|------|--------|---------------|----------------|
| 1. EAV 敏感数据 | `ods.ocr_result` | `sensitive_field_check` HIGH（id_number/account_number）；`ocr_confidence_check` MEDIUM（min 0.82 < 0.9） | 65.0 UNTRUSTED |
| 2. 风控域模型指标 | `ads.model_metrics` | `domain_field_check` MEDIUM（auc/ks 命中风险领域词表） | 90.0 TRUSTED |
| 3. 数据陈旧（schema ≠ 健康） | `dws.prediction_points` | `freshness_check` HIGH（84h > 48h） | 75.0 CONDITIONAL |

ODS 场景同时验证：敏感发现 + 掩码 evidence + ODS 层默认禁止 Agent 下钻（既有 ODS 拒绝）。

## 4. 验收问题与回答要求

**"ads.model_metrics 当前是否适合用于分析？请结合数据质量、CDXR 治理发现、快照和血缘给出结论，并列出需要人工核验的问题。"**

回答必须：包含 governanceScore/status 依据、findingId/ruleId/severity、snapshotId、qualityStatus/qualityReference、lineageReference；列出人工核验问题；**保持 finding OPEN 并移交人工（不得声称已解决/豁免）**。

E2E 校验：`experiments/e2e-governance.mts`（对 3 个数据集断言 profile 与 expected 完全一致 → 治理 API 下钻 → LLM 回答 8 项检查 → findings 保持 OPEN）。

## 5. 兼容性 — LEGACY

- 7 个既有数据工具、多模态工具、Evidence Quality Gate、掩码、ODS 拒绝全部保持（12 个工具总注册：7 + 5）
- 既有 TS 测试更新为 12 工具断言；Python 84 测试（60 既有 + 24 治理）；tsgo 0 错误

## 6. 按需训练数据检查工具 `assess_training_data`（v0.6.0）

定位：**训练数据适用性检查**（非常驻治理流程、不保证数据绝对正确）。只做四件事——检测目标泄漏/敏感字段/数据质量/可追溯性；不训练模型、不写数据、不批量豁免、不返回原始数据。

- 注册：默认不注册；`ENABLE_CDXR_TRAINING_TOOL=true` 时注册且**只注册这一个**（`DATA_TOOLS = [7 湖仓工具] + [assess_training_data]`）
- 客户端：`gatewayClient.assessTrainingData(request)` → `POST /v1/cdxr/training-assessments`（请求模型 `extra="forbid"`，无 SQL/表达式入口）
- 请求：`datasetId`（必填，`<namespace>.<table>`）/ `snapshotId`（可选，默认最新）/ `targetField`（必填）/ `featureFields`（必填 ≥1）/ `predictionTimeField` / `trainingWindow` / `policy`（默认 training）/ `validationStrategy`（默认 none）
- 响应：`status`（ALLOW / REVIEW / BLOCK / INSUFFICIENT_EVIDENCE）、`findings[]`（ruleId / severity / detail / action）、`summary`、`assessmentId`；不含数据行/分布值
- 状态判定（确定性）：CRITICAL/明确泄漏 → BLOCK；信息缺失/规则失败 → INSUFFICIENT_EVIDENCE；HIGH → REVIEW；否则 ALLOW。规则异常绝不判 ALLOW
- 规则（10）：TARGET_IN_FEATURES / POST_OUTCOME_FEATURE / LABEL_DERIVED_FEATURE（仅显式角色元数据，禁止 LLM 猜名）/ SENSITIVE_FEATURE / TARGET_DISTRIBUTION / SAMPLE_SIZE / FEATURE_MISSINGNESS / CONSTANT_FEATURE / VALIDATION_LEAKAGE / TRACEABILITY（无 snapshot 引用不得 ALLOW）
- 引擎架构：`services/cdxr-engine/cdxr/{contracts,ports,config,engine,rules/*}.py`；网关 adapter：`app/integrations/cdxr_lakehouse_adapter.py`；端点：`app/api/cdxr_routes.py`
- 测试：引擎 35（`cd services/cdxr-engine && python3 -m pytest tests/ -q`）、网关 11（test_cdxr_training.py）、TS 8（cdxr-training.test.mts + flag-on.test.mts）；E2E：`LAKEHOUSE_GATEWAY_URL=http://localhost:8791 node --experimental-strip-types experiments/e2e-cdxr-training.mts`
- 限制：仅检查适用性，不保证正确性；BLOCK/REVIEW 判定需人工复核；无治理表写入、无治理 CLI 接入（LEGACY 平面不变）
