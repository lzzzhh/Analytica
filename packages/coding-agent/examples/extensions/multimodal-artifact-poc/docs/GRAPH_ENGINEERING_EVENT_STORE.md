# Graph Engineering Event Store

`event-store.ts`：append-only、每 run 单调 sequence、previous hash 链、
原子写（tmp + rename）、per-run 写锁（fail closed on concurrent append）、
内容哈希、完整性扫描（链断裂/序列错位/哈希不匹配 → 报错）。

布局（隔离，测试用临时目录）：
```
<root>/runs/<runId>/events/<sequence>.json
<root>/runs/<runId>/state.json（reducer 投影，可选）
```

恢复：`replayRunState` 重放全部事件 → 重建 GraphRunState；已成功节点
（NODE_SUCCEEDED + artifact refs 哈希有效）绝不重复执行；有副作用的节点
依赖幂等 key（runId + nodeId + capability）。

事件 20 类（GRAPH_CREATED…GRAPH_CANCELLED），字段：
eventId/runId/graphId/graphVersion/sequence/eventType/nodeId?/refs/
errorCode?/timestamp/previousEventHash/contentHash。禁止敏感字段
（rawData/rows/credentials/modelOutput）。
