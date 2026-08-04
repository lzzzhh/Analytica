# Requirement Planning — 协议（PrepareBusinessTask 输入/输出）

`prepare_business_task` 工具（`src/requirement-planning/tool.ts`）的完整输入输出协议。核心类型定义见 `src/requirement-planning/contracts.ts`。

## 1. 输入（PrepareBusinessTaskRequest）

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `"ANALYZE" \| "CONTINUE" \| "REPLAN"` | 分析 / 带着澄清回答继续 / 带任务反馈重规划 |
| `request` | `string` | 用户原始业务请求 |
| `domainHint` | `string?` | 可选领域提示（不强制） |
| `conversationSummary` | `string?` | 对话上下文摘要 |
| `answers` | `ClarificationAnswer[]?` | 澄清回答（`questionId` + `field` + `value`） |
| `previousState` | `{ plan?: TaskPlan; requirement?: BusinessRequirementCard }?` | REPLAN 前置状态 |
| `taskFeedback` | `TaskFeedback[]?` | REPLAN 任务反馈（`taskId` + `status` ∈ SUCCEEDED/FAILED/EMPTY/BLOCKED/SKIPPED + `reasonCode?`） |
| `constraints` | `Constraints?` | `maxQuestions`(3)、`maxTasks`(12)、`maxToolCalls`(20)、`maxSubagents`(4)、`maxReplans`(1) |

## 2. 输出（PrepareBusinessTaskResult）

| 字段 | 说明 |
|------|------|
| `state` | `NEEDS_CLARIFICATION` / `READY_TO_PLAN` / `DIRECT_EXECUTION` / `PLAN_READY` / `CANNOT_PLAN` |
| `requirement` | `BusinessRequirementCard` |
| `clarificationQuestions` | 本轮需要用户回答的问题（≤3） |
| `planGate` | `{ mode, score, reasons }` |
| `taskPlan` | `TaskPlan`（DIRECT 时可能为空/≤1 任务） |
| `validation` | `PlanValidationResult`（`valid` + `issues[]` + `missingCapabilities`） |
| `schedule` | `PlanSchedule`（`executionWaves` / `readyTaskIds` / `blockedTaskIds` / `parallelGroups`） |
| `replan` | `ReplanRecord`（REPLAN 时） |
| `missingCapabilities` | 缺失能力 id 列表 |
| `decisionLog` | 决策日志（requestId / gate / 歧义数 / 任务数 / 时长等） |
| `warnings` | 非致命警告 |

## 3. 状态机

```
ANALYZE:
  输入校验失败(FORBIDDEN) → CANNOT_PLAN
  阻塞歧义 > 0:
    clarification 开 → NEEDS_CLARIFICATION（≤3 问题）
    clarification 关 → CANNOT_PLAN（拒绝猜测）
  阻塞歧义 = 0:
    gate=DIRECT     → DIRECT_EXECUTION（不生成 verbose plan）
    gate=LIGHT/FORMAL → 构建计划 → 硬校验:
      通过 → PLAN_READY（含 schedule）
      失败 → CANNOT_PLAN
      CAPABILITY_UNAVAILABLE → CANNOT_PLAN

CONTINUE: 合并 answers → 重新走 ANALYZE 流程（已答字段不再问）

REPLAN:  反馈已完成任务 → attemptReplan（有界）
          成功 → 新版本 plan + ReplanRecord → 校验 → PLAN_READY
          失败 → 保留原计划状态或 CANNOT_PLAN
```

## 4. BusinessRequirementCard

| 字段 | 说明 |
|------|------|
| `requestId` / `rawRequestSummary` | 请求标识（sha1 前缀）/ 单行摘要（≤120 字符） |
| `domain` | 选中领域包（general / risk） |
| `businessObjective` | 业务目标（显式提供才写入；推断场景写入 assumptions） |
| `decisionToSupport` | 支撑的决策 |
| `subject` / `scope` | 业务对象 / 范围 |
| `timeRange` | `{ relative?, source }`（USER / SYSTEM_DEFAULT / DOMAIN_DEFAULT / UNKNOWN） |
| `metrics` | `Metric[]`（`name` + `definition` + `source` + `confirmed`） |
| `dimensions` / `comparisonBaselines` | 维度 / 对比基线 |
| `successCriteria` / `outputRequirements` / `constraints` | 成功标准 / 输出要求 / 约束 |
| `assumptions` | `Assumption[]`（全部用户可见、需确认） |
| `ambiguities` | `Ambiguity[]`（`blocking` 标记） |
| `confidence` | 0.1-0.95（阻塞歧义扣分、确认指标加分） |
| `status` | `CLARIFYING` / `READY` / `REJECTED` |

## 5. TaskPlan / Task

`TaskPlan`: `planId`、`version`、`requestId`、`goal`、`requirementVersion`、`tasks[]`、`budget`（maxTasks/maxToolCalls/maxSubagents/maxReplans）、`replanPolicy`。

`Task`: `taskId`、`title`、`objective`、`taskType`（QUERY/SYNTHESIZE/DISCOVER/EXTRACT/COMPARE/ASSESS/ANALYZE）、`capability`、`dependsOn[]`、`inputs[]`、`expectedOutputs[]`、`preconditions[]`、`successCriteria[]`、`failurePolicy`（`action` ∈ STOP/ASK_USER/CONTINUE + `maxRetries`）、`evidenceRequired`、`parallelizable`、`optional`、`activationCondition`（`condition` ∈ ALWAYS/ON_TASK_SUCCESS）。

## 6. 校验错误码（plan-validator）

硬校验（不可消融）：`DUPLICATE_TASK_ID`（含 replan 已完成任务重复调度）、`UNKNOWN_DEPENDENCY`、`CYCLE_DETECTED`、`CAPABILITY_UNAVAILABLE`、`TASK_LIMIT_EXCEEDED`、`INVALID_FAILURE_POLICY`、`NO_FINAL_OUTPUT`、`GOAL_CHANGED`、`INVALID_CAPABILITY`、`FORBIDDEN_CODE_CONDITION`、`CONDITIONAL_WITHOUT_DEPS`。

语义校验（`plan_validation` 门控）：`GOAL_NOT_ALIGNED`、`OUTPUT_NOT_CONSUMABLE` 等非致命警告。

## 7. ReplanRecord

`previousPlanId`、`previousVersion`、`newPlanId`、`newVersion`（+1）、`reasonCode`（EMPTY_RESULT / MISSING_CAPABILITY / PRECONDITION_FAILED / CONFLICTING_EVIDENCE / EXECUTION_ERROR / PLAN_INVALIDATED）、`preservedTasks`（已完成任务 id，绝不重调度）、`removedTasks`、`addedTasks`、`changedTasks`、`generatedAt`。

## 8. Skill 注册（Pi 原生）

`round4.requirement_skill` 生效时，扩展通过 `pi.on("resources_discover", …)` 返回 `{ skillPaths: [<skill 目录>] }`；Pi 的 ResourceLoader 扫描含 `SKILL.md` 的目录并注入系统提示（skill 名取 frontmatter `name` 或目录名小写连字符，`description` 必填）。Skill 内容见 `src/requirement-planning/skill/SKILL.md`。
