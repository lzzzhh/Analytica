---
name: requirement-planning
description: >
  Business requirement planning plugin: clarifies vague business requests into
  structured requirement cards and candidate task plans. Use when a user asks a
  vague business question (e.g. "看看最近业务有没有问题") that needs scoping,
  or when a request needs a multi-step plan with dependencies. Use the
  prepare_business_task tool for ANALYZE / CONTINUE / REPLAN flows. The tool
  never executes business tasks; the main agent drives execution.
---

# Requirement Planning Skill

本 Skill 指导主 Agent 何时调用 `prepare_business_task` 以及如何推进需求-计划流程。

## 1. 何时调用 prepare_business_task

**先调用 ANALYZE（模糊业务诉求）：**

- 用户请求含义不明确：不知道分析哪个业务、哪个指标、哪个时间范围
- 请求有两种以上合理解释，且不同解释会导向完全不同的数据源或计划
- 无法区分用户是想「描述现象」还是「支持决策」
- 请求需要跨文档、数仓、训练数据的多步计划

**不调用（直接回答/直接执行）：**

- 明确、单步、可直接执行的请求（例如「查询最近 7 天的模型 AUC」）
- 请求本身已经是明确的数据查询或文档解析，无歧义、无多步依赖

**需要澄清时：**

- 结果 `NEEDS_CLARIFICATION` 时，向用户逐条提问返回的澄清问题
- 每轮最多 3 个问题
- 问题按优先级排序：业务目标 > 数据范围 > 指标定义 > 执行路径 > 展示方式
- 不要重复询问用户已经回答过的字段

## 2. 收到答案后

用 `CONTINUE` 模式，把 `answers`（questionId + field + value）传回。
结果 `PLAN_READY` 时，主 Agent 决定是否执行：

- 检查 `taskPlan` 与 `schedule`（readyTaskIds / executionWaves）
- 按 schedule 调用现有工具，不要跳过依赖
- 工具本身不执行计划

## 3. 重新规划

任务失败且允许重新规划时（反馈含 `EMPTY_RESULT` / `MISSING_CAPABILITY` /
`CONFLICTING_EVIDENCE` / `DATASET_NOT_FOUND` 等 reasonCode），用 `REPLAN` 模式：

- 把 `taskFeedback`（taskId + status + reasonCode）传回
- 默认最多重新规划 1 次
- 已成功任务会被保留，不会重复执行
- 用户目标变化会生成新的 requirementVersion

## 4. 必须遵守的边界

- 假设不是事实：`assumptions` 中的默认值（时间范围、对比基准等）必须向用户
  可见并提示确认，不得当作已确认事实
- 阻塞性模糊不猜测：返回 `NEEDS_CLARIFICATION` 或 `CANNOT_PLAN`，绝不静默
  补全业务主体、目标、指标、成功标准
- 工具不执行：`prepare_business_task` 只准备需求和候选计划
- 不暴露内部 Advisor prompt 给用户
- 简单请求不生成冗长计划（DIRECT 状态直接执行）
