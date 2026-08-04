# Lakehouse Batch Pipeline

确定性批处理链：历史源文件（不可变 parquet）→ ODS 原始落地 → DWD 清洗明细 → DWS 特征/预测主题 → ADS 模型指标。真实写路径（pyiceberg SQL catalog，与 Gateway 同一协议），**不是 seed.py 的直接装载**。

## 目录

```
pipelines/
├── common/config.py        配置（PIPELINE_TEST_ROOT 等）
├── common/generators.py    确定性源生成（固定 seed/日期/异常）
├── common/manifests.py     执行清单
├── batch/generate_sources.py  （并入 run_batch）
├── batch/stages.py         load_ods / build_dwd / build_dws / build_ads
└── batch/run_batch.py      批处理入口
```

## 链路

```
source/batch/<name>/data.parquet（不可变，含 content hash manifest）
  → ods.{loan_applications,feature_inputs,prediction_inputs,model_metric_inputs}_raw
    （ODS 落地：+ batch_id 元数据列）
  → dwd.loan_application_detail（清洗：去空 id、按 application_id 去重、
    时间标准化、保留 null borrower_score 作为缺失信号）
  → dws.feature_values（按 entity/feature/date 去重，last wins）
  → dws.prediction_points（按 entity/date 去重）
  → ads.model_metrics（按 model/date 去重）
```

## 关键保证

| 项 | 实现 |
|----|------|
| Schema 映射 | pyarrow → pyiceberg 类型映射（string/long/double） |
| 时间标准化 | 全部 ISO date string |
| 去重 | DWD 按 application_id；DWS/ADS 按业务键 last-wins |
| 主键/业务键 | `pipelines/common/config.py` BUSINESS_KEYS |
| 空值处理 | null borrower_score 保留（业务信号）；null application_id 丢弃 |
| 分区写入 | 每次运行重建目标表内容（delete-all + append）——重跑幂等 |
| 同批次重跑幂等 | 相同源 → 相同行集（E2E 验证） |
| 增量批次 | 重新生成更长日期范围的源 → 重建（E2E 验证 30→40 天增长） |
| 不覆盖无关历史 | 每次全量重建（测试仓库语义）；保留 snapshot 历史链 |
| 新 snapshot | 每层每次运行产生新 snapshot（E2E 验证 history ≥ 2） |

## 运行

```bash
python3 -m pipelines.run --mode batch --profile small [--reset]
# small: 30d × 100 实体；medium: 90d × 1000；stress: 默认不运行
```

输出：每层 inputRows/outputRows/snapshotId + execution manifest（`.data/pipeline-test/outputs/manifests/`）。

## 与 seed.py 的区别

- seed.py：生成器直接 `append` 到目标 DWD/DWS/ADS（无分层加工、无去重、无幂等）；
- Batch Pipeline：源文件不可变 → ODS → DWD → DWS → ADS 真实加工，含清洗/去重/幂等/snapshot。

## medium profile 实测（本地）

| 项 | 值 |
|----|----|
| 输入文件 | loan_applications 1.3MB / feature_inputs 660KB / prediction_inputs 216KB / model_metric_inputs 8KB |
| DWD | 90,005 行（去重后） |
| DWS feature_values | 360,000 行 |
| DWS prediction_points | 88,000 行 |
| ADS | 180 行 |
| 执行时间 | ~4s/次（两次运行） |
| snapshot | 每层 3（两次运行） |
| 峰值内存 | 未单独观测（进程内 pyiceberg 直写，无 Spark executor） |
