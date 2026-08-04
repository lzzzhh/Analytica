# Lakehouse Hybrid Pipeline（批基线 + 流回放）

```
历史源文件（Batch）
  → ODS → DWD/DWS/ADS 基线
最近事件（Stream replay）
  → ods.streaming_events（去重/watermark/dead-letter，微批提交）
Ledger
  → processed-event ledger（event_id → event_time/processing_time，provenance）
```

## 汇合契约

| 键 | 定义 |
|----|------|
| 业务主键 | DWD: application_id；DWS: entity/feature/date；ADS: model/date |
| event_id | 流事件唯一 id（去重键；仅存在于 ODS + ledger + checkpoint） |
| event_time | 事件业务时间（watermark 依据） |
| processing_time | 处理时刻（ODS 记录） |
| batch_id | 每次批运行唯一 |
| source_offset | JSONL 行号（checkpoint lastOffset） |
| watermark | 已见最大 event_time |
| 幂等键 | event_id（ODS 去重）；DWD/DWS/ADS 用各自业务主键重建 |

## 业务键完整性（重要）

- 流事件**绝不**以合成键折入 DWD/DWS/ADS——`evt_<event_id>` 方案已移除；
- 当前流 payload 不含 DWD 所需的真实业务主键（application_id），因此流事件**只落 ODS**（事实表）+ ledger（溯源），DWD schema 语义不被改动；
- DWD/DWS/ADS 仅由批来源派生（全量幂等重建）。

## Ledger

`pipelines/hybrid/run_hybrid.py::_write_ledger`：hybrid 完成后把 ODS 已接受事件写成 `outputs/ledger-<runId>.json`（event_id → event_time/processing_time/source）。Ledger 与 checkpoint、execution manifest 是事件溯源的唯一位置。

## 运行

```bash
python3 -m pipelines.run --mode hybrid --profile small [--reset]
```

## 验证

- `experiments/e2e-hybrid-pipeline.mts`：基线行数（DWD=3005 纯 batch）、重跑幂等、Gateway 只读查询（7 检查）；
- `experiments/verify-pipeline-data.mts`：对照 ground truth（13 检查）。

## 限制

- 流回放为 deterministic local event replay（distributed=false，exactlyOnceVerified=false）；
- 本 hybrid 不做 DWD 增量 fold（无合成键）；增量加工留待 Phase-1 Governance 的 SchemaSpec/PipelineSpec 设计。
