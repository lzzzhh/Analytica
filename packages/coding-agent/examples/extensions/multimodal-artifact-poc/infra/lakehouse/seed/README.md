# Lakehouse Seed — 确定性演示与回归数据集

独立的数据生成/加载工具（不改 Query Gateway 只读边界，不用生产数据/凭据）。

## 用法

```bash
# 重置数仓（删 .data/warehouse + 重新迁移原真实表）并加载种子
python3 infra/lakehouse/seed/seed.py --reset --seed 42 --days 60 --scale 1

# 仅追加（幂等：同一 seed 生成完全相同的数据）
python3 infra/lakehouse/seed/seed.py --seed 42 --days 60 --scale 1

# 换种子 / 天数 / 实体规模
python3 infra/lakehouse/seed/seed.py --seed 7 --days 90 --scale 2
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--reset` | off | 清空 warehouse 并重迁移原真实表（绝对路径） |
| `--seed` | 42 | 随机种子（固定 → 完全可复现） |
| `--days` | 60 | 数据时间跨度（连续天） |
| `--scale` | 1 | 实体数倍率（默认 10 实体） |

## 数据世界

60 天（2026-06-02 ~ 2026-07-31）× 10 实体 × 3 模型（lr_v1 / **lgb_v2（受损）** / xgb_v3）：

| 表 | 行数（默认） | 内容 |
|----|-------------|------|
| `dwd.loan_application_detail` | ~434 | 每日贷款申请（annual_income 在 07-02 起 40% 缺失） |
| `dws.feature_values` | 2268 | 4 特征 × 实体 × 天（feature_income 缺失 44%；feature_debt_ratio 分布漂移 → PSI） |
| `dws.prediction_points` | 570 | 每日预测点（07-28 停止 → 新鲜度异常；oot bad rate 32%→47%） |
| `ads.model_metrics` | 180 | 每日 AUC/KS/lift/F1（lgb_v2 在 07-04 起 AUC 0.89→0.71） |
| `ods.ocr_result` | 50 | EAV OCR（含 id_number/account_number 敏感值 → 掩码演示） |
| `ods.pdf_parse_result` | 10 | PDF 解析（含 credit_score 等风险字段） |
| `ods.streaming_events` | 35 | 正常 20 + 重复 5×2 + 迟到 5 |

## 植入的 5 类异常（ground truth 在 `expected_results.json`）

1. **PSI > 0.25**：lgb_v2 关联特征 `feature_debt_ratio` 分布漂移，派生 PSI = **0.338**（表无 psi 列 → 派生指标，10 等宽分箱，确定性计算）
2. **AUC 明显下降**：lgb_v2 AUC **0.891 → 0.707**（07-04 起），KS 0.782 → 0.548；lr_v1/xgb_v3 稳定
3. **特征缺失率显著升高**：`feature_income` 缺失率 **0% → 44%**（07-02 起）
4. **新鲜度异常**：`prediction_points` 最后数据 **07-28**（落后 3 天）
5. **预测分布漂移**：oot bad rate **32.3% → 47.5%**（07-04 起）

## 验证

```bash
# 5 个真实 Gateway 查询对照 ground truth（自动起 gateway）
node --experimental-strip-types experiments/verify-seed.mts

# Pi Agent 自动分析验收场景（工具链 + LLM 回答 + 一致性校验）
node --experimental-strip-types experiments/agent-analysis.mts
```

## Schema 阻塞项（不改表结构）

- `ads.model_metrics` 无 **psi** 列 → PSI 作为派生指标（分布计算），已记录于 expected_results
- `ods.ocr_result` / `ods.pdf_parse_result` 无 **parser_version / parse_status** 列 → 仅 confidence 可表达
- `dws.prediction_points` 无预测分数列 → 分布漂移用 oot label（bad rate）观测

## CDXR 治理演示（第三轮，ground truth 在 `cdxr_expected_results.json`）

三个可验证治理场景（固定 `--as-of` → 确定性 run/finding id）：

```bash
cd services/lakehouse-gateway
export LAKEHOUSE_WAREHOUSE_PATH="<poc>/.data/warehouse"

# 1) EAV 敏感数据：SENSITIVE_FIELD（id_number/account_number）+ OCR_LOW_CONFIDENCE（0.82<0.9）
python3 -m app.governance.cdxr.run --dataset-id ods.ocr_result --time-column processed_at --as-of 2026-07-31T12:00:00Z

# 2) 风控域模型指标：DOMAIN_FIELD（auc/ks 命中风险领域词表）
python3 -m app.governance.cdxr.run --dataset-id ads.model_metrics --time-column created_at --as-of 2026-07-31T12:00:00Z

# 3) 数据陈旧（schema ≠ 健康）：NO_FRESH_DATA（84h > 48h）
python3 -m app.governance.cdxr.run --dataset-id dws.prediction_points --time-column prediction_time --as-of 2026-07-31T12:00:00Z
```

期望：ocr_result 65.0/UNTRUSTED（2 findings）、model_metrics 90.0/TRUSTED（1 finding）、prediction_points 75.0/CONDITIONAL（1 finding）。验证：`node --experimental-strip-types experiments/e2e-governance.mts`（含验收问题 LLM 回答，8 项检查）。
