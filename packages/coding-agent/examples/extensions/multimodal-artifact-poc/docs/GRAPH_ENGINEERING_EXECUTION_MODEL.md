# Graph Engineering Execution Model

## 调度（scheduler.ts）

节点 READY 八条件：控制依赖 SUCCEEDED / artifact 输入存在且哈希有效 /
feature 生效 / capability 已注册 / 无上游失败 / 无未决 human gate /
预算未超 / concurrencyKey 不冲突。wave 并行（maxParallelNodes），
parallel 关闭时每 wave 单节点；同一 (graph, state) 的 ready 顺序确定
（nodeId 排序）。Scheduler 不执行业务逻辑。

## 执行（executor.ts）

- 校验 GraphSpec → 建 run state → GRAPH_CREATED/VALIDATED/STARTED
- wave 循环：调度 → adapter 分发（显式注册，禁止动态 import）→ 事件
- 重试：capability retryPolicy 决定上限；确定性错误（HASH_MISMATCH/
  SCHEMA_INVALID/FEATURE_DISABLED/SANDBOX_VIOLATION/PERMISSION_DENIED…）不可重试
- Human Gate：发出 HUMAN_ACTION_REQUIRED 后等待；resolver 批准后才继续；
  **executor 永不自我批准**
- 终止：terminal 全 SUCCEEDED → COMPLETED；任一 FAILED/BLOCKED → FAILED
  （失败绝不标成成功）
- 恢复：从 Event Store 重放重建状态；已 SUCCEEDED 节点不重复执行；
  终态 run 直接返回

## 数据边界

- AdapterResult 只含 ArtifactRef/DecisionRef/summary（无数值）
- 模型可见摘要 = runGraphSummary（runId/status/节点数/错误码）
- 数字只存在于 AnalysisResultArtifact，经 UI details 通道展示
