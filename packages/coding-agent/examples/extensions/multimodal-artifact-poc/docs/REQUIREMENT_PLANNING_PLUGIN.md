# Requirement Planning 插件 — 使用指南

## 1. 启用

```bash
# 构建期：full / evaluation-full profile 已包含 round4（registry buildDefault 控制）
FEATURE_BUILD_PROFILE=full node --experimental-strip-types scripts/generate-feature-manifest.mts

# 运行期：显式开启
export FEATURE_RUNTIME_PROFILE=all-enabled        # 或逐个 ENABLE_*
export ENABLE_REQUIREMENT_PLANNING=true
export ENABLE_REQUIREMENT_SKILL=true              # Pi 原生 Skill 注入
export ENABLE_TASK_PLAN_GENERATION=true
# 可选：ENABLE_PLANNING_ADVISOR=true + REQUIREMENT_PLANNER_MODEL_ID=<model>
```

`round4.*` 运行期默认全部关闭；`baseline` runtime profile 保持关闭。

## 2. 使用方式

主 agent 感知到模糊业务请求时调用 `prepare_business_task`：

1. **ANALYZE**：传入 `request`。返回 `NEEDS_CLARIFICATION` + ≤3 个问题 → 主 agent 向用户提问。
2. **CONTINUE**：把用户回答作为 `answers` 传入 → 返回 `PLAN_READY` + `taskPlan` + `schedule`。
3. 主 agent 按 `schedule.executionWaves` 依次驱动真实工具（execute_query / get_data_quality / …），不越权执行计划外的动作。
4. **REPLAN**（可选）：任务执行后把 `taskFeedback` 传回，获得新版本计划（已完成任务保留）。

```jsonc
// 示例：ANALYZE
{ "mode": "ANALYZE", "request": "看看最近业务有没有问题" }
// → NEEDS_CLARIFICATION, questions: [subject?, timeRange?, metrics?]

// 示例：CONTINUE
{
  "mode": "CONTINUE",
  "request": "看看最近业务有没有问题",
  "answers": [
    { "questionId": "q_subject_1", "field": "subject", "value": "个人贷款" },
    { "questionId": "q_timeRange_2", "field": "timeRange", "value": "recent_30_days" },
    { "questionId": "q_metrics_3", "field": "metrics", "value": ["通过率", "逾期率"] }
  ]
}
// → PLAN_READY, taskPlan(2 tasks), schedule.waves=[[query],[synthesize]]
```

## 3. 规则与限制

- 禁止输入原始 SQL / JS / Python 表达式（会被拒绝为 `CANNOT_PLAN`）。
- 核心不执行业务任务；执行由主 agent 依据 schedule 完成。
- 默认假设全部用户可见、需确认；不要替用户做决策。
- 能力缺失时返回 `CANNOT_PLAN` 与 `missingCapabilities`——不要伪造计划。
- 每轮最多 3 个问题；计划最多 12 个任务；重规划最多 1 次。

## 4. 评测与回归

```bash
# 单元（42 项）
node --experimental-strip-types --test tests/requirement-planning.test.mts
node --experimental-strip-types --test tests/requirement-planning-features.test.mts
# E2E（场景 A-G）
node --experimental-strip-types experiments/e2e-requirement-planning.mts
# 评测集（20 案例）
node --experimental-strip-types experiments/requirement-planning/evaluate.mts
```

## 5. 目录速览

```
src/requirement-planning/
  contracts.ts             协议类型（本插件唯一事实来源）
  index.ts                 编排入口 runRequirementPlanning
  tool.ts                  prepare_business_task（TypeBox schema）
  skill/SKILL.md           Pi 原生 Skill（round4.requirement_skill）
  capability-registry.ts   14 抽象能力 + TASK_TYPE_CAPABILITIES
  domain-packs/            generic / risk
  adapters/                pi-capabilities（工具名映射）、pi-planning-advisor（RPC 子代理）
  ambiguity.ts / assumptions.ts / requirement-analyzer.ts
  plan-gate.ts / task-plan-builder.ts / plan-validator.ts
  scheduler.ts / replanner.ts / advisor.ts / feature-bindings.ts
domains/risk/requirements/ 演示领域需求样例（pack.json + README）
```

详细设计见 `docs/REQUIREMENT_PLANNING_ARCHITECTURE.md`，协议见 `docs/REQUIREMENT_PLANNING_CONTRACTS.md`。
