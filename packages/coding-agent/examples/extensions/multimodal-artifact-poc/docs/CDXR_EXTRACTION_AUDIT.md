# CDXR Extraction Audit — 原 CDXR 模块审计与抽取方案

日期：2026-08-01
来源 commit：`e386f920e352997282cdbf1fcfe5573a07b42b6a`（LeakBench-RiskCloud，只读）

## 1. CDXR 准确含义与目标（以原代码与论文说明为唯一事实来源）

**CDXR = Cross-Data X-Ray**（`case_studies/home_credit/models/cdxr.py` docstring 明确定义）：
"CDXR Governance — Cross-Data X-Ray for feature leakage detection and model repair."

**四维评估**（docs/RISKCLOUD_CURRENT_STATE_AND_ROADMAP.md："CDXR 四维泄漏治理"）：

| 维度 | 原实现 | 语义 |
|------|--------|------|
| **C**onstruction validity | `engine.py::assess_validity` | 特征在预测时间是否可得（business_stage/time_role/feature_eligibility → reason codes） |
| **D**etectability | `engine.py::assess_detectability` | 泄漏信号是否可被统计检测（semantic_role/business_stage/name_pattern/risk_indicator → score） |
| e**X**ploitability | `tools/paired_training.py` | 泄漏是否可被模型利用（Full vs Strict 视图 AUC/KS Δ；Governed vs Random 修复对比） |
| **R**epair | `evaluate_feature` 的 repair 字段 | 修复策略（DROP_FEATURE / NONE），配对训练验证修复有效性 |

**核心机制**（engine.py，120 行，确定性、无 LLM——文件头明确 "Does NOT call LLM"）：
- 输入：`feature_id` + `column_role`（business_stage/semantic_role/time_role/feature_eligibility/confidence/table_id）+ `manifest` + 可选 `profile`/数据
- 输出：`CdxrFeatureAssessmentV1`（validity/detectability/exploitability/repair/**decision**/**confidence**/evidence_refs）
- 决策：`GovernanceDecision`（ALLOW / ALLOW_WITH_WARNING / BLOCK / NEEDS_REVIEW）——规则：不可用→BLOCK；detectability score>0.5→NEEDS_REVIEW；列 confidence<0.7→NEEDS_REVIEW；否则 ALLOW
- confidence：`0.95`（有 reason codes）或 `0.7`（无）
- evidence_refs：`["profile:<feature_id>", "manifest:<table_id>"]` 风格
- 12 个 reason codes（FUTURE_TIMESTAMP/POST_PREDICTION_RECORD/POST_OUTCOME_SOURCE/LABEL_DERIVED/TARGET_DUPLICATE/TARGET_PROXY/JOIN_PATH_TO_OUTCOME/SOURCE_STAGE_MISMATCH/UNRESOLVED_PREDICTION_BOUNDARY/UNRESOLVED_TARGET/LOW_SCHEMA_CONFIDENCE/OCR_LOW_CONFIDENCE）——**预测时间泄漏治理语义（LeakBench 学术核心），非信贷实体**

**GovernanceFindingV1**（agents/contracts/models.py:144）：finding_id/run_id/feature_id/risk_type/risk_status/confidence/confidence_components/reason_codes/evidence_refs/exploitability_probe/recommendation/**review_status**（PENDING 起始）——原项目已有 finding 雏形 + review 状态概念

## 2. 18 项确认

| # | 项 | 结论 |
|---|----|------|
| 1 | CDXR 含义 | Cross-Data X-Ray：特征泄漏检测与模型修复治理（四维 C/D/X/R） |
| 2 | 输入 contract | `column_role` dict（business_stage/semantic_role/time_role/feature_eligibility/confidence/table_id）+ manifest + profile + 可选 X/y/feature_names |
| 3 | 输出 contract | `CdxrFeatureAssessmentV1`（validity/detectability/exploitability/repair/decision/confidence/evidence_refs）；finding 雏形 `GovernanceFindingV1`（含 review_status） |
| 4 | 核心维度 | validity / detectability / exploitability / repair |
| 5 | 规则和阈值 | detectability score = min(1, signals×0.3)，>0.5 → REVIEW；列 confidence <0.7 → REVIEW；不可用 → BLOCK；12 reason codes 各带 severity + default_action |
| 6 | confidence 计算 | 确定性：0.95（有 reason）/ 0.7（无） |
| 7 | evidence 结构 | `evidence_refs: ["profile:<id>", "manifest:<table>"]` 字符串引用（无独立 evidence 实体） |
| 8 | attribution/lineage | evidence_refs 指向 profile/manifest；无正式 lineage 集成 |
| 9 | review/approval 状态 | `GovernanceFindingV1.review_status`（PENDING）；`SystemRiskStatus`（LOW/SUSPICIOUS/HIGH/EXPLOITABLE/INSUFFICIENT_EVIDENCE）；`SystemRecommendation` |
| 10 | 人工审核流程 | 概念存在（SupervisorReviewV1/REVIEW_ALLOW 等 agent 层状态机）；无独立 review action 表 |
| 11 | Agent/LLM 依赖 | **engine 无 LLM**（"Does NOT call LLM"）；governance_agent.py 用 LLM 解释/总结 engine 输出——LLM 只解释不裁决 |
| 12 | 风控实体依赖 | detectability 的 risk_indicator 词表含 default/delinquent/**overdue**/**bad**（禁词）；其余为通用泄漏语义 |
| 13 | 数据库/文件依赖 | 无数据库；paired_training 依赖 numpy/sklearn（可选，SKLEARN_AVAILABLE 守卫）；case_studies 版依赖 artifacts 文件 + yaml 配置 |
| 14 | 已有测试 | `tests/agents/test_governance.py`：TestCDXREngine 5 例（outcome blocked/normal allowed/low-confidence review/validity codes/detectability signals） |
| 15 | 确定性逻辑 | validity/detectability/decision/confidence/repair 策略（全确定性） |
| 16 | 模型推断 | 无（engine 确定性）；paired training 是统计计算（确定性 seed=42） |
| 17 | 可通用化 | 四维机制、reason-code 机制、decision 逻辑、confidence、evidence_refs 模式、paired-training 对比框架 |
| 18 | 仅限风控领域 | risk_indicator 词表（overdue/bad 等）、任何具体业务阈值/审核策略 |

## 3. 逐文件清单

| 原文件 | 原职责 | 依赖 | 分类 | 迁移方式 | 保留/重构/不迁移 | 风险 |
|--------|--------|------|------|---------|----------------|------|
| `governance/cdxr/engine.py`（120 行） | 四维评估 + 决策 + confidence | agents/contracts/models | 通用内核（机制）+ 领域词表（risk_indicator） | 机制迁 `app/governance/cdxr/`；词表下沉 domains/risk | **重构** | 禁词隔离；行为保持 |
| `governance/cdxr/tools/paired_training.py`（160 行） | exploitability 配对训练（Strict/Full/Governed/Random） | numpy/sklearn（可选） | 通用（统计对比框架） | 接口 + 可选实现迁通用层 | **重构**（sklearn 可选依赖） | 重依赖不引入硬性 |
| `agents/contracts/models.py` 中 CdxrFeatureAssessmentV1/GovernanceFindingV1/GovernanceDecision/SystemRiskStatus/SystemRecommendation/ConfidenceComponentsV1 | contract 模型 | pydantic | 通用 | 提取为 `app/governance/cdxr/contracts.py` | **重构**（同文件混合 agent 模型，只取 CDXR 部分） | 提取完整性 |
| `agents/governance_agent.py`（引用方） | 用 LLM 解释 engine 输出 | LLM | 不迁移（原项目 agent 体系） | — | **不迁移** | — |
| `case_studies/home_credit/models/cdxr*.py`（案例实现） | 完整泄漏检测工作流（MI/artifacts） | sklearn/yaml/artifacts | 领域案例 | 参考不迁移 | **不迁移** | — |
| `tests/agents/test_governance.py::TestCDXREngine` | 5 个引擎测试 | pytest | 通用 | 移植为通用内核单测 | **保留移植** | — |
| `dashboard/app.py` / `agents/api/app.py`（引用方） | 展示/控制面 | — | 不迁移 | — | **不迁移** | — |

## 4. 通用内核 vs 领域包（规格 §4 边界）

**通用内核**（`services/lakehouse-gateway/app/governance/cdxr/`）：
- contracts：CdxrFeatureAssessmentV1（有效性/可检测性/可利用性/修复/决策/confidence/evidence_refs）、GovernanceFindingV1、GovernanceDecision、SystemRiskStatus、SystemRecommendation、ConfidenceComponentsV1
- 机制：assess_validity / assess_detectability（信号评分，词表可注入）/ evaluate_feature 决策链 / confidence / paired-training 对比框架（接口 + sklearn 可选）
- 新增（规格 §4）：rule registry、policy registry、evidence 实体、finding 生命周期、review action、audit event、trust profile 聚合、governance score
- 禁词检查：`loan borrower credit_score overdue bad_rate vintage auc ks psi` 不在通用内核代码/字符串中

**领域包**（`domains/risk/governance/cdxr/`）：
- risk_indicator 词表（default/delinquent/overdue/bad → 注入 detectability）
- 风控字段敏感级别、模型监控规则、风控阈值、审核策略（后续填充）

## 5. 保留 / 重构 / 不迁移汇总

- **保留移植**：engine 机制（validity/detectability/decision/confidence）、CdxrFeatureAssessmentV1、GovernanceFindingV1 结构、test_governance.py 的 5 个引擎测试语义
- **重构**：reason codes 机制 → rule registry；evidence_refs → evidence 实体表；review_status → review action 生命周期；paired_training → 可选 sklearn 的通用接口
- **不迁移**：governance_agent.py（LLM 解释层）、case_studies cdxr 工作流、dashboard、agent control plane

## 6. 风险

1. **禁词隔离**：detectability 的 risk_indicator 含 overdue/bad——必须下沉 domains/risk（通用内核注入词表接口）
2. **行为保持**：decision 链与 confidence 数值（0.95/0.7）必须与原文一致（移植测试断言）
3. **sklearn 依赖**：paired_training 重依赖——通用内核用可选 import（SKLEARN_AVAILABLE 模式沿用），不硬性依赖
4. **contract 提取完整性**：CdxrFeatureAssessmentV1 等与 agent 状态机模型同文件——提取时不可漏字段
5. **治理表写入**：CDXR 扫描通过独立 CLI 写 governance_* 表，Query Gateway 只读——不破坏只读边界
