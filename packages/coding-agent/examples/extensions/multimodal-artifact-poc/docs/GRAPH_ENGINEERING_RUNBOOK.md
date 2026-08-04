# Graph Engineering Runbook

## 运行

```bash
# 图引擎 feature 默认关闭；评估/开发用 all-enabled profile
FEATURE_RUNTIME_PROFILE=all-enabled analytica
```

公开入口（round6.graph_tool）：
- `run_analysis_graph(objective, dataRefs?, format?)` — 编译并执行分析图
- `inspect_graph_run(runId)` — 只读图状态

## 测试

```bash
# 图核心 + 执行器 + E2E + feature 门禁
node --experimental-strip-types --test tests/reviewer/phase17-graph-core.test.ts
node --experimental-strip-types --test tests/reviewer/phase18-graph-executor.test.ts
node --experimental-strip-types --test tests/reviewer/phase19-graph-e2e.test.ts
node --experimental-strip-types --test tests/reviewer/phase17-graph-features.test.ts
```

## 故障排查

- 节点 BLOCKED：查 errorCode（HASH_MISMATCH/ARTIFACT_MISSING/
  CAPABILITY_UNAVAILABLE…）→ 检查输入 artifact 哈希 / adapter 注册 / feature
- 图 FAILED：`inspect_graph_run` 看 failedNodes + blockedCodes
- 恢复：重跑同一 runId → 已成功节点跳过
- 事件链损坏：EventStore.scan 报错 → 数据损坏（fail closed，不静默修复）

## 限制

- analysis-report 无本地接口（见 MIGRATION）；report 节点 BLOCKED
- E2E 使用确定性 fake adapters；真实模型接线需 host 注入 subagent/
  semanticReviewer（tool-runner 的 setGraphToolHost 是接线点）
