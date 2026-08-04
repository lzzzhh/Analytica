# Lakehouse Streaming Pipeline

事件 replay 流处理：JSONL 事件源 → schema 校验 → event-time 提取 → watermark → event_id 去重 → 合法事件写 `ods.streaming_events`，非法/超迟进 dead-letter → 逐事件 checkpoint。

## 目录

```
pipelines/streaming/
├── engine.py            normalize / classify（watermark+dedup）/ 微批 append / state / dead-letter
└── run_streaming.py     流处理入口（replay + checkpoint 恢复）
```

## 实现语义（deterministic local event replay）

- 事件**逐个**从源读取（`read_events` 生成器，按 offset 恢复）；
- 每事件独立：校验 → 分类 → 落盘 → checkpoint；
- event-time 用事件自带 `event_time`，processing_time 用处理时刻；
- watermark = 已见最大 event_time（单调推进）；
- 去重 = seen_event_ids（持久化于 checkpoint）；
- checkpoint 逐事件写入，重启从 lastOffset 恢复。

## 分类与计数

| 类别 | 条件 | 去向 |
|------|------|------|
| accepted | 合法、非重复、非超迟 | ods.streaming_events |
| duplicate | event_id 已 seen | 丢弃（不写事实） |
| late | 比 max 旧 >12h 但在 5 天窗口内 | 接受（计数 late） |
| tooLate | 比 watermark 旧 >5 天 | dead-letter.jsonl |
| invalid | 缺 event_id / 坏 event_time / 坏 event_type / 非法 JSON | dead-letter.jsonl |

## 恢复保证

- checkpoint 存：watermark / seenEventIds / counters / lastOffset；
- 重启时**从 ODS 事实表合并已提交 event_id 进 seen**（表是事实真相）——即使 checkpoint 回退也不会重复写入已提交事件（E2E 验证）;
- `--reset` 清 checkpoint + dead-letter + 事实表（幂等干净重跑）。

## 运行

```bash
python3 -m pipelines.run --mode streaming --profile small [--replay events.jsonl] [--reset]
```

输出：stream counters（accepted/duplicate/late/tooLate/invalid）+ checkpoint 信息。

## 与真实 Flink 的差异（如实记录）

- 本机无 PyFlink；这是 deterministic local event replay（application-level event-time/watermark policy + local file checkpoint）；distributed=false；
- 无 Kafka（JSONL replay source）；
- checkpoint 为本地 JSON 文件（非云存储）；
- exactlyOnceVerified=false；idempotent replay 仅在已测本地条件下成立；生产级恢复未验证。

## 微批提交（micro-batch）

- 默认 `microBatchSize=25`（可 `--micro-batch-size N` 调整）；
- 事件先校验/watermark 分类/去重，缓冲到微批大小后**一次 Iceberg append**；
- append 成功后才推进 checkpoint；append 失败 → 异常退出，checkpoint 不动（重启重放同批）；
- manifest 记录 microBatchSize / commitsCreated / snapshotsCreated / dataFilesCreated。
