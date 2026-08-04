# domains/risk — 风控领域包（可选）

信贷风控业务语义的挂载点。**通用湖仓平台层禁止出现以下名称**（除非位于本目录）：`loan`、`borrower`、`credit_score`、`overdue`、`bad_rate`、`vintage`、`auc`、`ks`、`psi`。

## 原平台对应模块（LeakBench-RiskCloud @ e386f920，未迁移、未删除）

| 本目录建议位置 | 原平台模块 | 内容 |
|---------------|-----------|------|
| `metrics/` | `riskcloud/serving/{cloud_api,model_training}.py` | AUC / KS / Lift / F1 / Brier / PSI、风险概率、决策 |
| `datasets/` | `riskcloud/adapters/home_credit/` | 借贷实体（贷款/借款人/订单）、字段映射、特征目录 |
| （治理） | `riskcloud/governance/cdxr/` | 标签泄漏治理（LeakBench 学术核心，确定性引擎） |
| （事件类型） | `riskcloud/contracts/event.py` 的 EventType/EntityType | 领域事件类型集合（`loan_application` 等）——通用层已剥离为开放字符串，领域侧可按需注册校验 |

## 决策记录

- 本轮**不迁移**风控模块（规格：风控业务语义保留为**可选**领域模块，不得污染通用数据层）
- 原项目代码零删除；需要风控能力时按 `metrics/`、`datasets/` 结构增量搬入本目录
- 领域事件类型示例（供参考，通用 `app/contracts/event.py` 接受任意 snake_case）：

```python
# domains/risk/events.py（未来实现）
RISK_EVENT_TYPES = {
    "loan_application", "bureau_snapshot", "prev_application",
    "installment_payment", "credit_card_balance", "pos_cash_balance",
    "prediction_request", "prediction_result", "label_feedback",
}
```

## 通用查询 Gateway 命名不受影响

Gateway 与工具命名保持通用（`sales_daily` 等）。原平台若只有风控数据，也可用风控表做演示——但 Gateway 层不出现风控语义。
