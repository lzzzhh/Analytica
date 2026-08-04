# Lakehouse Pipeline — 本地运行手册

## 环境

- Python 3.13 + pyiceberg 0.11.1 + pyarrow 19 + pandas
- 无 PyFlink / 无 Spark Iceberg connector（审计见 `docs/LAKEHOUSE_PIPELINE_AUDIT.md`）

## 配置

| 变量 | 默认 | 说明 |
|------|------|------|
| PIPELINE_TEST_ROOT | `.data/pipeline-test` | 独立测试仓库（不碰 `.data/warehouse`） |
| PIPELINE_GOVERNANCE_ROOT | `.data/pipeline-governance` | 必须包含目标表绑定的 sealed approval 和已批准 placement |
| PIPELINE_MODE / PIPELINE_PROFILE / PIPELINE_RESET / PIPELINE_REPLAY | — | CLI 等价环境变量 |

## 命令

所有写命令均 fail closed：没有有效 `WriteGate` 授权时，在创建 warehouse、namespace 或 table 前退出。`--govern` 只增加运行时治理检查，不替代写授权。

```bash
# 批处理（30d × 100 实体）
python3 -m pipelines.run --mode batch --profile small --reset

# 流处理（事件 replay）
python3 -m pipelines.run --mode streaming --profile small --reset

# 流批汇合（批基线 + 流回放 + ledger）
python3 -m pipelines.run --mode hybrid --profile small --reset

# medium（90d × 1000，供 Data Analysis Subagent 使用）
python3 -m pipelines.run --mode hybrid --profile medium --reset
```

声明式外部数据入口使用 `contracts/arbitrary-source-pipeline.schema.json`。contract 固定本地绝对 source path、SHA-256、CSV/Parquet format、目标表、schema policy、primary key、event-time contract、quality rules 和 approvalId：

```bash
# 只执行解析、schema/quality 校验、目标解析和治理预检；不创建运行资产
python3 -m pipelines.run \
  --contract /absolute/path/source-contract.json \
  --warehouse /absolute/path/evaluation-warehouse \
  --governance-root /absolute/path/pipeline-governance \
  --dry-run

# 使用相同 contract 执行受治理写入
python3 -m pipelines.run \
  --contract /absolute/path/source-contract.json \
  --warehouse /absolute/path/evaluation-warehouse \
  --governance-root /absolute/path/pipeline-governance
```

## 输出

- 每层 inputRows / outputRows / snapshotId；
- 流 counters（accepted/duplicate/late/tooLate/invalid）；
- execution manifest：`.data/pipeline-test/outputs/manifests/execution-<runId>.json`；
- 外部数据 plan / quality / lineage / manifest：warehouse 同级 `pipeline-outputs/{plans,quality,lineage,manifests}/`；
- 流 checkpoint：`.data/pipeline-test/checkpoints/streaming-checkpoint.json`；
- dead-letter：`.data/pipeline-test/outputs/dead-letter.jsonl`。

## 验证

```bash
python3 -m pytest pipelines/tests/ -q                       # 单测 10
node --experimental-strip-types experiments/e2e-batch-pipeline.mts        # 10
node --experimental-strip-types experiments/e2e-streaming-pipeline.mts    # 11
node --experimental-strip-types experiments/e2e-hybrid-pipeline.mts       # 7
node --experimental-strip-types experiments/verify-pipeline-data.mts      # 13
```

## 边界

- 只写 `.data/pipeline-test/`；正式 `.data/warehouse` 不受影响；
- Gateway 只读（不提供 pipeline 写 API）；
- 无生产凭据 / 无 S3；
- Pipeline 写路径仅 CLI/E2E 显式触发，不注册为 Agent 工具。
