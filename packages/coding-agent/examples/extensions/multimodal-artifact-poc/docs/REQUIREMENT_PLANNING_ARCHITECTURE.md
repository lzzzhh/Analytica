# Requirement Planning — 架构（功能第四轮 / 工程 Round-7）

业务模糊需求理解与任务规划插件：把「用户的一句话」转换为**可验证的业务需求卡片**与**确定性任务计划**，不做任何业务执行、不写数据、不静默补全。纯确定性核心 + 可选 LLM advisor（隔离上下文、严格 JSON、一次修复）。

## 1. 定位

- **输入**：模糊/明确的中文业务请求（可带对话上下文、澄清回答、任务反馈）。
- **输出**：`PrepareBusinessTaskResult`——需求卡片、澄清问题、计划门控决策、任务计划、执行波次、校验结果、重规划记录、决策日志。
- **边界**：核心（`src/requirement-planning/`）零业务工具依赖、零网络、零 Python；Pi 工具名只出现在 `adapters/pi-capabilities.ts` 一个文件中。
- **禁止**：任意代码/表达式输入（`FORBIDDEN_INPUT_PATTERNS` 前置拒绝）、静默补全业务目标（默认假设必须 `visibleToUser=true`）、能力缺失时伪造可执行计划（一律 `CANNOT_PLAN`）。

## 2. 分层

```
tool.ts (prepare_business_task, TypeBox schema)
  └─ index.ts (runRequirementPlanning 编排: ANALYZE / CONTINUE / REPLAN)
       ├─ requirement-analyzer.ts     请求 → 需求卡片 + 歧义 + 问题 + 假设
       │    └─ ambiguity.ts           规则化歧义检测（blocking / non-blocking）
       │    └─ assumptions.ts         默认假设（SYSTEM/DOMAIN/USER 来源）
       ├─ plan-gate.ts                DIRECT / LIGHTWEIGHT / FORMAL
       ├─ task-plan-builder.ts        按 gateMode 构建任务计划
       ├─ plan-validator.ts           硬校验 + 语义校验
       ├─ scheduler.ts                执行波次（ready / blocked / parallelGroups）
       ├─ replanner.ts                有界重规划（maxReplans，保留已完成任务）
       ├─ advisor.ts                  （可选）LLM advisor：严格 JSON + 1 次修复
       ├─ capability-registry.ts      14 个抽象能力
       ├─ domain-packs/               generic / risk 领域包
       ├─ feature-bindings.ts         round4.* feature → PlanningOptions 映射
       └─ adapters/
            ├─ pi-capabilities.ts     抽象能力 → Pi 工具名 + 可用性（唯一出现工具名处）
            └─ pi-planning-advisor.ts RpcClient 子代理调用（隔离上下文）
```

## 3. 核心不变量

1. **无静默补全**：所有默认值落入 `assumptions`（`source`、`impact`、`requiresConfirmation`、`visibleToUser=true`）。
2. **无伪造执行**：`CAPABILITY_UNAVAILABLE` / `GOAL_CHANGED` / 循环依赖 / 超限任务数 → `CANNOT_PLAN`。
3. **无越权决策**：核心只输出候选计划与建议，不执行、不批准假设、不改变用户最终目标（`GOAL_CHANGED` 硬校验）。
4. **有界重规划**：`maxReplans=1`（默认）；已完成任务 id 不重复调度（`DUPLICATE_TASK_ID` 硬校验）。
5. **确定性**：同一输入 + 同一 feature snapshot → 同一结果（无 LLM 时）；advisor 输出只作为候选，核心始终再验证。

## 4. 计划门控（plan-gate）

| 模式 | 触发 | 计划形态 |
|------|------|----------|
| DIRECT | 单目标显式查询，无阻塞歧义、无跨源、无分支 | 不生成 verbose plan（≤1 QUERY 任务或空），状态 `DIRECT_EXECUTION` |
| LIGHTWEIGHT | 2-3 步简单流程（分数 ≤1） | query → synthesize |
| FORMAL | 跨源/多目标/条件分支/训练检查（分数 ≥2） | discover → extract(文档) → query → compare → assess(训练) → analyze → synthesize |

跨源信号（`CROSS_SOURCE_HINTS`）：文档/报告/核对/验证/训练/泄漏/模型报告/图片/截图/pdf/excel/gateway/交叉验证/跨源/对一下/比对。时间对比（"对比上季度"）不算跨源。

## 5. 歧义与澄清（ambiguity.ts）

- **blocking**（必须澄清，否则 `NEEDS_CLARIFICATION`）：subject、businessObjective、decisionToSupport、model（仅模型指标请求）、dataset、phenomenonVsDecision（模糊"有没有问题"类请求）。
- **non-blocking**（默认假设，用户可见）：timeRange（默认 recent_30_days）、comparisonBaseline（默认 previous_period）。
- **businessObjective 推断**：subject + metrics 均已提供时，降级为非阻塞假设（`evaluate … — inferred from stated subject and metrics`），仍 `requiresConfirmation=true`。
- **model 歧义**：仅当请求涉及模型质量指标（AUC/KS/PSI/评分/模型表现）时阻塞——纯业务查询不被模型字段卡住。
- 最多 `maxQuestions=3` 个问题/轮。

## 6. 能力注册表（capability-registry.ts）

14 个抽象能力：`image.ocr`、`image.visual`、`document.parse`、`document.analyze`、`lakehouse.catalog.search`、`lakehouse.dataset.inspect`、`lakehouse.query.validate`、`lakehouse.query.execute`、`data.quality`、`data.lineage`、`data.snapshot`、`training.assess`、`agent.reason`、`agent.synthesize`。任务类型 → 能力族映射 `TASK_TYPE_CAPABILITIES` 决定每个任务可用的能力；可用性来自 feature snapshot（`buildCapabilities`）。

## 7. 领域包（domain-packs）

- `generic`：系统级默认（timeRange/comparisonBaseline/subject/businessObjective 歧义模板），对一切请求生效，不带业务名词。
- `risk`：风险域（贷款/逾期/AUC/KS/PSI 等关键词触发），提供 model 歧义、风险指标（AUC/KS/PSI）建议、commonTimeRanges；`domains/risk/requirements/` 为演示领域的需求样例。
- `selectDomainPack(domainHint)` 语义匹配，domainHint 不强制；`domain_pack=false` 消融时只用 generic。

## 8. 输入安全

`FORBIDDEN_INPUT_PATTERNS` 拒绝 SQL 语句、JavaScript/Python 表达式、shell 命令等可执行内容；命中 → `CANNOT_PLAN`（`input rejected: contains executable content …`）。任何模式下都不可关闭（不属于任何 round4 子开关）。

## 9. Feature 门控

| feature | 作用 |
|---------|------|
| `round4.requirement_planning` | 总开关（父） |
| `round4.requirement_skill` | Pi 原生 Skill 注册（resources_discover → skillPaths） |
| `round4.planning_advisor` | 子代理 advisor（`REQUIREMENT_PLANNER_MODEL_ID`） |
| `round4.clarification` | 澄清问答；关 + 有阻塞歧义 → `CANNOT_PLAN` |
| `round4.plan_gate` | 门控；关 → 非 DIRECT 全 FORMAL |
| `round4.plan_validation` | 语义校验；硬校验（schema/循环/上限/能力）不可关 |
| `round4.parallel_scheduling` | 并行波次；关 → 每波单任务 |
| `round4.dynamic_replanning` | 重规划；关 → 不生成新版本 |
| `round4.domain_pack` | 领域包；关 → 仅 generic |
| `round4.ambiguity_detection` / `assumption_management` / `dependency_scheduler` / `task_plan_generation` | 子开关（默认跟随父） |

默认策略：build profile `full` / `evaluation-full` 构建 round4；`baseline` / `multimodal-only` / `lakehouse-only` 不构建。运行期默认全关（`runtimeDefault=false`），`all-enabled` profile 全开。详见 `docs/FEATURE_FLAGS.md`。

## 10. 测试与评测

- 单元测试：`tests/requirement-planning.test.mts`（31 项，spec §19 1-27）+ `tests/requirement-planning-features.test.mts`（11 项，spec §19 28-36 + hash parity）。
- E2E：`experiments/e2e-requirement-planning.mts`（场景 A-G，19 项检查）。
- 评测集：`experiments/requirement-planning/cases.jsonl`（20 案例：5 简单 / 5 模糊 / 5 跨源 / 3 缺能力 / 2 重规划）+ `evaluate.mts`。

```bash
node --experimental-strip-types --test tests/requirement-planning.test.mts
node --experimental-strip-types --test tests/requirement-planning-features.test.mts
node --experimental-strip-types experiments/e2e-requirement-planning.mts
node --experimental-strip-types experiments/requirement-planning/evaluate.mts
```
