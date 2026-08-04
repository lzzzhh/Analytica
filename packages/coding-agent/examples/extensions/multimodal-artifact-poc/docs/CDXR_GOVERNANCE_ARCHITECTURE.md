# CDXR Governance Architecture — 治理平面（Governance Plane）

日期：2026-08-01
来源：LeakBench-RiskCloud `e386f920`（`riskcloud/governance/cdxr/`，只读）
抽取审计：见 `CDXR_EXTRACTION_AUDIT.md`（18 项确认）；工作区基线：见 `CDXR_INTEGRATION_BASELINE.md`

## 1. 定位：CDXR 不是湖仓的一层，而是横跨各层的治理平面

```
Catalog / Quality / Lineage / Snapshot
                 │
                 ▼
        CDXR Governance Engine（确定性，无 LLM）
                 │
   ┌─────────────┼─────────────┐
   ▼             ▼             ▼
原始证据       标准化发现      聚合治理指标
ODS            DWD            DWS
                               │
                               ▼
                     ADS 数据可信档案
                               │
                               ▼
                         Pi Data Agent
```

- 治理产物按阶段落入 `governance_ods/dwd/dws/ads` 命名空间（与业务层 ODS/DWD/DWS/ADS 平行）
- 规则/策略注册表在 `governance_meta`
- Query Gateway 只读；治理写入只经独立 CLI（`python -m app.governance.cdxr.run`）

## 2. 通用内核 vs 领域包（禁词边界）

| 位置 | 内容 | 禁词 |
|------|------|------|
| `services/lakehouse-gateway/app/governance/cdxr/` | 引擎机制、规则注册表、策略、evidence/finding/生命周期、聚合、store、CLI、reader | 禁止 `loan borrower credit_score overdue bad_rate vintage auc ks psi`（测试断言字面检查） |
| `domains/risk/governance/cdxr/` | risk_indicator 词表（default/delinquent/overdue/bad）、敏感字段（id_number/account_number/...）、领域字段（auc/ks/psi/...）、sklearn paired-training 实现 | 可自由使用风险词 |

词表通过 `Vocabulary` 注入 `RuleContext`；未注入时规则退化为领域中立行为（`test_domain_rule_isolation` 验证）。

## 3. 引擎（从原 120 行 verbatim 移植，行为保持）

- `assess_validity`：business_stage/time_role/feature_eligibility → reason codes
- `assess_detectability`：semantic_role/business_stage/name_pattern/**risk_indicator（注入）** → score=min(1, signals×0.3)
- `evaluate_feature` 决策链：不可用→BLOCK；detectability>0.5→NEEDS_REVIEW；列 confidence<0.7→NEEDS_REVIEW；否则 ALLOW
- confidence：0.95（有 reason codes）/ 0.7（无）
- 12 个 REASON_CODES 原样保留；paired training 走注入式接口（领域实现缺失时 NOT_EVALUATED）

## 4. 规则与策略

8 条默认规则（`standard` policy；`with_lineage` 加血缘检查）：

| rule_id | 触发 | severity |
|---------|------|----------|
| empty_dataset_check | schema 存在但 0 行 | CRITICAL |
| freshness_check | 最新记录超过 staleness（默认 48h） | HIGH |
| sensitive_field_check | 字段名/EAV 标签命中敏感词表 | HIGH |
| domain_field_check | 字段名命中领域词表 | MEDIUM |
| quality_reference_check | 既有质量结果 WARN/FAIL（引用不复制） | MEDIUM/HIGH |
| lineage_reference_check | 无上游血缘（默认关闭） | LOW |
| schema_confidence_check | 字段 confidence<0.7（LOW_SCHEMA_CONFIDENCE） | MEDIUM |
| leakage_check | CDXR 引擎逐字段评估（泄漏语义） | 依 reason code |
| ocr_confidence_check | ODS 解析表最低 confidence<0.9（OCR_LOW_CONFIDENCE） | MEDIUM |

## 5. 确定性边界（LLM 永不裁决）

确定性代码负责：rule pass/fail、threshold、severity、evidence 关联、snapshot 绑定、finding 状态迁移、confidence 规则部分、review 状态、审计日志、聚合分数。

LLM/Agent 只能：解释 finding、总结影响、推荐排查步骤、转自然语言、帮助定位证据。
LLM 不得：自动关闭 finding、修改规则、批准 waiver、覆盖确定性证据、把 inferred 升级为 confirmed（证据合并器按优先级裁决并输出 `requires_verification` 冲突）。

## 6. 治理写入与读取路径

- 写入：`python3 -m app.governance.cdxr.run --dataset-id <id> --snapshot latest [--time-column <col>] [--as-of <ISO>]`（确定性：相同输入 → 相同 run/finding id；`--as-of` 固定用于演示/回归）
- 读取：Gateway 6 个只读 API（`/v1/governance/cdxr/...`），见 `CDXR_DATA_MODEL.md`
- 第一版**不暴露**任何写路径（创建/修改规则、关闭 finding、批准 waiver、写 review action 均禁止，测试断言路由只读）

## 7. 兼容性

未配置 CDXR（无治理表/catalog 不可用）时：Gateway 正常启动、普通查询正常、治理 API 返回空/404、治理工具返回"CDXR 未配置或无治理结果"，extension 不加载失败。
