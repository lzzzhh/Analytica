# Graph Engineering Contracts

类型定义见 `src/graph-engine/contracts.ts`（事实来源），要点：

- **GraphSpec**：`schemaVersion/graphId/graphVersion/objective/sourcePlanRef/
  featureSnapshotHash/nodes/edges/entryNodeIds/terminalNodeIds/policyRefs/
  contentHash`。canonical 序列化（排序键）+ sha256；不可变 + 版本单调递增。
- **GraphNodeSpec**：`kind ∈ DETERMINISTIC|TOOL|AGENT|SKILL|REDUCER|HUMAN_GATE`；
  `sideEffect ∈ NONE|READ|WRITE`；`retryPolicy{maxAttempts,retryableErrorCodes,
  backoff,initialDelayMs}`；`metadata` 只允许标量（禁止路径/函数/代码）。
- **GraphEdgeSpec**：`edgeType ∈ CONTROL|ARTIFACT|FEEDBACK|DECISION`；
  `condition` 仅固定枚举（NODE_SUCCEEDED/NODE_FAILED/VERDICT_EQUALS/
  ERROR_CODE_IN/ARTIFACT_PRESENT/HUMAN_APPROVED）——**禁止可执行字符串**。
- **ArtifactRef**：`artifactId/artifactType/contentHash/schemaVersion/
  createdByNodeId`——数据边只传引用，原始业务数据永不进图。
- **NodeRunState / GraphRunState**：状态机 PENDING→READY→RUNNING→SUCCEEDED/
  FAILED/BLOCKED/WAITING_FOR_HUMAN/SKIPPED/CANCELLED；run 状态 CREATED/
  RUNNING/WAITING_FOR_HUMAN/COMPLETED/FAILED/CANCELLED。
- **GraphEvent**：append-only、单调 sequence、`previousEventHash` 链、
  `contentHash`；事件不得含原始数据/凭证/完整模型输出/业务数字。

## Canonical Hash

`canonical.ts`: 排序键递归序列化；`specContentHash` 排除自引用 contentHash。
同一对象 → 同一 hash；字段顺序无关。
