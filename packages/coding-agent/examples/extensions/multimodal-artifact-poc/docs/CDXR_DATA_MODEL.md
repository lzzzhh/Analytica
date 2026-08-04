# CDXR 数据模型 — 17 张治理表与 6 个只读 API

日期：2026-08-01
位置：`services/lakehouse-gateway/app/governance/cdxr/store.py`（表定义）、`app/governance/reader.py`（只读访问）

## 1. 命名空间与写入模型

- 命名空间：`governance_meta` / `governance_ods` / `governance_dwd` / `governance_dws` / `governance_ads`（与业务层平行，不混入）
- 写入模型：**全表 append**（每次 run 是版本化记录集，带 run/snapshot/updated_at 键）；"最新状态"在读取侧解析（`governance_ads.dataset_trust_profile` 按 dataset 取最新 generated_at；findings 按 (dataset, rule, field) 去重取最新；review queue 按 finding 去重）。全表 overwrite 会互相覆盖多数据集记录，已弃用。
- 物化：仅独立治理 CLI；Query Gateway 永不写表。

## 2. 表清单（17）

### governance_meta（规则/策略注册表，每次 run 刷新）
| 表 | 关键字段 |
|----|---------|
| `cdxr_rule_registry` | rule_id, rule_name, dimension, description, default_severity, params, registered_at |
| `cdxr_policy_registry` | policy_name, rule_ids, params, registered_at |

### governance_ods（原始证据，append）
| 表 | 关键字段 |
|----|---------|
| `cdxr_run_raw` | run_id, dataset_id, snapshot_id, run_type, raw_payload, event_at |
| `cdxr_evidence_raw` | evidence_id, run_id, dataset_id, source_type, source_reference, raw_payload, event_at |
| `cdxr_review_event_raw` | review_id, finding_id, action, event_payload, event_at（第一版无写入方） |

### governance_dwd（标准化发现，append）
| 表 | 关键字段 |
|----|---------|
| `cdxr_run` | run_id, dataset_id, dataset_layer, snapshot_id, status, started/finished_at, rules_executed, findings_created/reopened, error |
| `cdxr_finding` | finding_id, run_id, rule_id, dataset_id, field_name, risk_type, risk_status, severity, confidence, reason_codes, evidence_refs, snapshot_id, data_version, quality_reference, lineage_reference, status, first/last_detected_at, created_at, recommendation, summary |
| `cdxr_evidence` | evidence_id, finding_id, source_type, source_reference, source_snapshot, observed_value, expected_value, confidence, evaluator_version, created_at |
| `cdxr_rule_result` | run_id, dataset_id, rule_id, passed, result_count, detail, evaluated_at |
| `cdxr_review_action` | review_id, finding_id, action, previous_status, new_status, reviewer, reason, created_at（第一版无写入方） |

### governance_dws（聚合指标，append + 读侧最新）
| 表 | 关键字段 |
|----|---------|
| `cdxr_dataset_score_daily` | dataset_id, score_date, governance_score, status, open_finding_count, highest_severity, generated_at |
| `cdxr_dimension_summary` | dataset_id, snapshot_id, dimension, score, open_finding_count, updated_at |
| `cdxr_issue_trend` | dataset_id, date_day, rule_id, open_count, new_count, resolved_count, updated_at |
| `cdxr_rule_coverage` | dataset_id, rule_id, executed, findings_count, last_run_at |

### governance_ads（可信档案 / 审核队列 / 告警）
| 表 | 关键字段 |
|----|---------|
| `dataset_trust_profile` | dataset_id, snapshot_id, governance_score, status, open_finding_count, highest_severity, dimension_scores, quality_status, quality_reference, lineage_reference, finding_ids, generated_at |
| `governance_review_queue` | finding_id, dataset_id, severity, confidence, summary, queued_at, assignee |
| `governance_alert` | alert_id, dataset_id, finding_id, severity, message, alert_at（第一版无写入方） |

## 3. finding 最小字段约束（规格 §5）

每个 finding 必带：finding_id / run_id / rule_id / dataset_id / field_name（可空）/ snapshot_id 或 data_version / severity / confidence / status / evidence_reference / quality_reference（可空）/ lineage_reference（可空）/ first_detected_at / last_detected_at / created_at。

每个 evidence 必带：evidence_id / finding_id / source_type / source_reference / source_snapshot / observed_value / expected_value（可空）/ confidence / evaluator_version / created_at。

## 4. 治理分数与 trust profile

- `score = max(0, 100 − Σ open_finding 的 severity 权重)`；权重 CRITICAL=40 / HIGH=25 / MEDIUM=10 / LOW=5 / INFO=0
- status：≥90 TRUSTED；≥70 CONDITIONAL；<70 UNTRUSTED
- dimension_scores：按规则维度（schema/freshness/sensitive/domain/quality/lineage/leakage）同法聚合
- quality/lineage 为**引用**（`quality://<ds>?snapshot=...`、`lineage://<ds>`），不复制第二套质量/血缘模块

## 5. 只读治理 API（6 个，全部 GET）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/governance/cdxr/datasets/{dataset_id}/profile` | ADS trust profile（含 dimensionScores/quality/lineage/findingIds） |
| GET | `/v1/governance/cdxr/findings` | 参数 dataset_id/severity/status/rule_id/limit/dedup（默认按 key 去重取最新） |
| GET | `/v1/governance/cdxr/findings/{finding_id}` | finding 详情（reason codes/references/生命周期） |
| GET | `/v1/governance/cdxr/findings/{finding_id}/evidence` | 关联的确定性证据列表 |
| GET | `/v1/governance/cdxr/runs/{run_id}` | run 详情 + rule results |
| GET | `/v1/governance/cdxr/review-queue` | 待人工审核队列（按 finding 去重） |

未配置 CDXR：catalog 不可用或无治理表时 API 返回空/404，Gateway 其余功能不受影响。
