# Graph Engineering Architecture

## 定位

Graph Engineering Runtime 是现有能力的**确定性编排层**，不是替代层：

```
用户请求 → 主 Agent（对话/澄清/解释/启动图）
  → Requirement Planning（确定性 TaskPlan）
  → Graph Compiler（TaskPlan → 不可变 GraphSpec，强制插入系统节点）
  → Graph Executor（确定性运行时：Scheduler → Adapter 分发 → 事件 → 状态）
  → 结果：Artifact / Decision / Report
```

**节点 ≠ Agent**：Graph Core 是确定性运行时，不做业务判断。Agent、Tool、
Deterministic Node、Skill、Reducer、Human Gate 都是统一节点，由 Adapter
桥接到现有实现（requirement-planning / lakehouse gateway / data-analysis /
reviewer / pipeline governance）。

## 强制系统节点（Planner 无法移除）

编译正式报告链路时强制插入：

1. `sys.preflight-governance`（artifact 存在/哈希/schema/snapshot/掩码/来源）
2. `sys.review-gate`（ReviewGate 决定模式——图不能选择/降低模式）
3. `sys.reviewer`（复用 ReviewerOrchestrator：replay/独立验证/语义/决策）
4. `sys.promotion-auth`（authorizeAction——PASS 才能 PUBLISH_REPORT）
5. `sys.analysis-report`（**SKILL 节点**，非 Report Agent）
6. `sys.deliverable-verifier`（引用/精度/因果/QA 证据检查）
7. WRITE 任务自动插入 `sys.human-gate.*`（HUMAN_GATE，永不自我批准）

## 反馈边

Reviewer 结果 → 确定性 Feedback Router（结构化 reason code → 目标节点族）：
REQUIREMENT/AMBIGUITY/GOAL → Requirement；INPUT/SCHEMA/QUALITY/SNAPSHOT → Preflight；
METHOD/SCRIPT/REPLAY/KPI → Data Analysis；REPORT_* → Report Skill；
PERMISSION/BUDGET/MISSING_EVIDENCE/POLICY → Human Gate。REJECT 不自动修订。

## 当前迁移范围（Phase 0-6 已完成部分）

- 已图化：核心链路（query → preflight → analysis → reviewer → promotion → report 结构）
- 未迁移：文档/多模态/Presentation/A/B Experiment/Pipeline 执行（明确非目标）
- 已知阻塞：analysis-report Skill 无本地 TS 接口（report 节点 fail-closed，不虚构）
