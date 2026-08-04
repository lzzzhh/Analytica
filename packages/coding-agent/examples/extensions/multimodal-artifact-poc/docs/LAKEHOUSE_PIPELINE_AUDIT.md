# Lakehouse Pipeline — 现状审计（2026-08-02）

范围：data-agent 仓库（multimodal-artifact-poc）。目的：明确"当前真实存在且可运行的能力"与"需要新增的能力"，为 Batch/Streaming Pipeline 实现提供依据。

## 1. 当前仓库是否已有可运行的 PySpark Batch Job

**没有。**

- 仓库无 `pipelines/` 目录；
- 全仓库搜索 `pyspark`/`spark` 仅命中 gateway 的存储 profile 测试（`services/lakehouse-gateway/app/storage/profile.py`、`tests/test_storage_catalog.py`），与批处理作业无关；
- 现有数据装载全部通过 `infra/lakehouse/seed/seed.py` 完成——它是**确定性直接装载工具**：`gen_*()` 生成 pyarrow Table → `append(catalog, "dwd.xxx", table)` 直接 append 到目标 Iceberg 表。**这不构成 Pipeline**（无分层加工、无清洗/去重/校验、无幂等重跑语义）。

## 2. 当前仓库是否已有可运行的 PyFlink Streaming Job

**没有。**

- 本机未安装 pyflink（`import pyflink` 失败）；
- 无任何 Flink 相关代码或配置。

## 3. 原 LeakBench-RiskCloud 中可通用迁移的批/流作业

**当前仓库无 LeakBench-RiskCloud 代码副本**（该平台在 lzzzhh/LeakBench-RiskCloud 独立仓库）。本仓库只保留了其**数据世界设计**的迁移：

- `infra/lakehouse/seed/generators.py` 的确定性数据世界（固定 seed、实体、日期范围、异常植入）可直接复用为 Pipeline 的**输入生成器**；
- `gen_streaming_events()` 已含 NORMAL / DUPLICATE（同 event_id 两次）/ LATE（event_time 早于窗口）三类事件——可作为流事件源设计基础，但当前是直接 append 到 `ods.streaming_events`，需改为"事件源文件 → 流处理 → 写入 ODS"。

**无现成 Spark/Flink 作业可迁移**。

## 4. 当前本地 PyIceberg SQL catalog 能否被 Spark/Flink 直接共享

**PyIceberg 侧可**：`load_catalog("lakehouse", type="sql", uri="sqlite:///<wh>/.lakehouse-catalog.db", warehouse=<wh>)` 是标准 pyiceberg SQL catalog（HadoopCatalog 风格，sqlite 存元数据，数据文件在 warehouse 目录）。

**Spark/Flink 侧当前不可直接共享**，原因：

- 本机 PySpark 3.5.3 **未加载 Iceberg runtime**（无 `spark.sql.catalog.*` 配置、无 Iceberg connector jar）；
- 本机 **无 PyFlink**；
- 即使加载 connector，pyiceberg 的 sqlite SQL catalog 与 Spark/Flink 的 Iceberg REST/Hive catalog 配置格式不同，需要独立 catalog 实例（可指向同一 warehouse 目录 + 各自元数据）。

结论：**本地共享同一 warehouse 数据文件可行（Iceberg 格式自描述），但元数据 catalog 需各自配置**；第一版建议 Pipeline 用 pyiceberg 直接读写测试 warehouse（与 Gateway 同一 catalog 协议），Spark/Flink 作为可选增强而非硬依赖。

## 5. 本机环境清单

| 组件 | 状态 | 版本 |
|------|------|------|
| Java | ✅ | OpenJDK 17.0.19 |
| PySpark | ✅ | 3.5.3（无 Iceberg connector 配置） |
| PyFlink | ❌ | 未安装 |
| Iceberg runtime connector（Spark/Flink） | ❌ | 无 |
| pyiceberg | ✅ | 0.11.1（SQL catalog，sqlite 元数据） |
| pandas / pyarrow | ✅ | 2.2.3 / 19.0.0 |
| 现有测试 warehouse | ✅ | `.data/warehouse`（SQL catalog，sqlite） |

## 6. 当前 ods.streaming_events schema

由 `gen_streaming_events()` 生成（generators.py:317）：

| 字段 | 类型 | 说明 |
|------|------|------|
| event_id | string | 业务事件 id（重复事件共用） |
| event_type | string | application_submitted / feature_updated / prediction_requested |
| source_table | string | 来源表引用 |
| entity_id | string | 业务实体 |
| event_time | string | 事件时间（YYYY-MM-DD） |
| payload_json | string | 事件负载 JSON |

现状：seed 直接 append；无 processing_time、无 batch_id、无 source_offset、无 watermark 字段。

## 7. 现有 7 张业务表及合理加工关系

| 表 | 层 | 现有内容 | Pipeline 中的合理角色 |
|----|----|----------|----------------------|
| ods.streaming_events | ODS | 事件原始数据（含重复/迟到） | 流 Pipeline 目标（去重后写入） |
| ods.ocr_result / ods.pdf_parse_result | ODS | EAV 小负载（脱敏演示） | 保留不动（Gateway 演示用） |
| dwd.loan_application_detail | DWD | 60d × N 实体贷款申请明细 | 批 Pipeline DWD 目标（清洗明细） |
| dws.feature_values | DWS | 4 特征 × 实体 × 天（含异常） | 批 Pipeline DWS 目标（特征主题） |
| dws.prediction_points | DWS | 每日预测点（提前 3 天停止） | 批 Pipeline DWS 目标（预测主题） |
| ads.model_metrics | ADS | 每日 AUC/KS/lift/F1（lgb_v2 受损） | 批 Pipeline ADS 目标（模型指标） |

**建议的加工关系（Batch）**：

```
历史源文件（loan_applications / feature_inputs / prediction_inputs / model_metric_inputs）
  → ODS 原始落地（ods.*_raw 或直接 ods.*）
  → DWD.loan_application_detail（清洗、去重、时间标准化）
  → DWS.feature_values / DWS.prediction_points（特征/预测主题，按业务键聚合）
  → ADS.model_metrics（模型指标，由 DWS 计算 AUC/KS/PSI 等）
```

**Streaming**：

```
events.jsonl（含正常/重复/迟到/乱序/非法）
  → schema 校验 → event-time 提取 → watermark → event_id 去重
  → ods.streaming_events（合法事件）
  → dead-letter artifact（非法/超迟事件）
  → checkpoint
```

## 8. 明确区分

- **当前真实存在且可运行**：pyiceberg SQL catalog 读写、seed.py 确定性直接装载、Gateway 只读查询。
- **需要新增**：pipelines/ 批处理链、流处理链、事件源生成、分层加工（ODS→DWD→DWS→ADS）、幂等/重跑/checkpoint、dead-letter、execution manifest、ground truth fixture。
- **当前环境限制**：无 PyFlink（流处理第一版用 JSONL replay + 真实流语义的 Python 实现，或记录阻塞）、无 Spark Iceberg connector（批处理用 pyiceberg 直写，Spark 为可选）、无 OS 级沙箱。
- **不能实际验证的云端能力**：分布式集群、Kafka、对象存储（S3）、Flink checkpoint 到云存储、生产级恢复。

## 9. 设计约束（从审计得出）

1. 新增表以 `ods.*_raw` / pipeline staging 命名，不静默改既有 7 张表语义；
2. ODS→DWD→DWS→ADS 的加工由 Pipeline 完成，**seed.py 不再直接写目标 DWD/DWS/ADS**（保留其生成器作为输入源）；
3. Gateway 只读边界不变；
4. 测试 warehouse 用 `.data/pipeline-test/`，不污染 `.data/warehouse`；
5. 无 PyFlink：本交付为 deterministic local event replay（application-level event-time/watermark policy + local file checkpoint），distributed=false，与真实 Flink 的差异如实记录。
