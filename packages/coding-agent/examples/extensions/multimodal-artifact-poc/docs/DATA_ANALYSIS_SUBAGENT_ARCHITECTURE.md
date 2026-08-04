# Data Analysis Subagent — 架构（功能第四轮）

数据分析子 Agent：把复杂分析请求路由到独立上下文的子 Agent，子 Agent 生成 AnalysisPlan 并写 Python 脚本，由受控 Script Runner 真实执行；数字、表格和图表通过 Pi 工具 UI renderer（details 通道）直接展示，主 Agent 只收到状态摘要。

## 1. 分层

```
tool.ts (run_data_analysis)
  └─ index.ts (runDataAnalysis 编排)
       ├─ input-resolver.ts      可信 Artifact 解析 + 输入校验（DATA_INPUT_REQUIRED）
       ├─ task-gate.ts           简单聚合 → QUERY_GATEWAY / 复杂 → DATA_ANALYSIS_SUBAGENT
       ├─ subagent-prompt.ts     隔离上下文提示词（只给受控信息）
       ├─ subagent.ts            Pi RPC 独立进程子代理（复用 RpcClient）
       ├─ plan-validator.ts      AnalysisPlan 确定性校验（执行前）
       ├─ script-runner.ts       受控执行（python3 <ws>/analysis.py，env 白名单等）
       ├─ result-validator.ts    Result Artifact 固定 Schema 校验 + 降采样/有界行
       ├─ result-sanitizer.ts    主 Agent 摘要（无数值）
       ├─ findings.ts            结构化 Finding（causalClaim 恒 false）
       ├─ artifact-store.ts      不可变 Artifact 注册表（可信 id）
       ├─ workspace.ts           ~/.pi/artifacts/data-analysis/<run-id>/
       ├─ feature-bindings.ts    round4.data_analysis_* → 行为开关
       └─ ui/                    renderer + formatter（前端直达通道）
services/lakehouse-gateway/app/api/routes.py: POST /v1/query/materialize
src/data-analysis/python/       validate_script.py / validate_result.py / run_analysis.py
```

## 2. 调用链

```
用户请求 → 主 Agent → run_data_analysis
  → 输入校验（拒绝 SQL/代码/路径/凭证）
  → 可信 Artifact 解析（无任意路径）
  → task gate:
      QUERY_GATEWAY         → 主 Agent 用 execute_query（简单聚合）
      DATA_ANALYSIS_SUBAGENT → 物化输入 → 子 Agent（独立上下文）
          → 写 AnalysisPlan（校验通过才继续）
          → 写 analysis.py
          → 受控执行（≤2 次尝试，仅可修复错误重试）
          → Result Artifact 校验 → 不可变落盘 + Execution Manifest
          → UI renderer 直接展示（details 通道）
          → 主 Agent 只收 AnalysisAgentSummary（无数值）
```

## 3. 数据边界（硬性）

- **数据获取与计算分离**：数据只能来自 Lakehouse Gateway / 可信 Artifact；子 Agent 不得访问数仓、凭据、底层路径。
- **复杂计算必须真实执行**：脚本落盘 → `python3 <workspace>/analysis.py` 运行；禁止 `-c`/`-e`/heredoc。
- **数值不进主 Agent 上下文**：完整数值只在 Result Artifact + UI renderer；主 Agent content 仅状态/引用/限制。此边界**不可消融**（`analysis_frontend_render` 关闭时工具不注册，绝不降级为模型复述）。
- **reviewStatus 恒为 NOT_REVIEWED**：第五轮独立审核 Agent 消费不可变 Artifact/Manifest。

## 4. 任务门（task-gate）

| 路由 | 触发 |
|------|------|
| QUERY_GATEWAY | 单一 count/sum/avg/min/max、单次过滤、单次 group by、无跨查询计算、无派生指标、无统计/图表 |
| DATA_ANALYSIS_SUBAGENT | 多查询计算、同比/环比/多基期、多步派生指标、趋势/异常、分布/分位数/标准差、相关/统计检验、多维拆解、图表数据准备 |
| DATA_INPUT_REQUIRED | 输入不足（缺 objective/dataRefs/维度/时间字段/指标列） |

## 5. 受控 Script Runner（当前 PoC 的真实边界）

- `python3 <workspace>/analysis.py`，cwd 固定 workspace；
- env 白名单（PATH/HOME/LANG/LC_/TZ/TERM），显式剔除 LAKEHOUSE/AWS/DB/API_KEY/TOKEN/SECRET；
- 超时（默认 120s）、脚本大小（200KB）、stdout/stderr（100KB）、结果文件（1MB）；
- 依赖探测（spawnSync python3 -c "import X"，仅 runner 内部）；缺依赖 → SCRIPT_IMPORT_ERROR；
- 静态预检 `validate_script.py`：禁 os/subprocess/socket/requests/eval/exec/pip/curl/绝对路径 open/连接串；
- 无网络（env 不含代理/凭据）、无 pip install、无 shell 管道；
- **PoC 限制（如实记录）**：子进程与主进程同用户，无 OS 级沙箱；网络隔离依赖 env 白名单（未验证防火墙）；文档 `docs/DATA_ANALYSIS_SANDBOX.md`。

## 6. 有限重试

- 最多 2 次尝试（`maxAttempts`，`analysis_retry` 关闭时强制 1 次）；
- 仅 SCRIPT_SYNTAX_ERROR / SCRIPT_IMPORT_ERROR / RESULT_SCHEMA_INVALID / NUMERIC_ERROR 可重试；
- FIELD_NOT_ALLOWED / INPUT_ARTIFACT_MISSING / SANDBOX_VIOLATION / 数据范围不足不可重试；
- 每次尝试写 attempt 版本脚本 + 记录尝试哈希。

## 7. Feature 门控

| feature | 作用 |
|---------|------|
| round4.data_analysis | 父开关 |
| round4.data_analysis_tool | run_data_analysis 注册（依赖 artifacts + frontend_render） |
| round4.analysis_task_gate | 任务门 |
| round4.analysis_input_materialization | POST /v1/query/materialize |
| round4.analysis_subagent | 子 Agent（依赖 workspace + script_execution） |
| round4.analysis_plan_generation | Plan 生成/校验 |
| round4.analysis_workspace | 运行目录 |
| round4.analysis_script_execution | 受控执行（依赖 workspace） |
| round4.analysis_retry | 重试 |
| round4.analysis_artifacts | 不可变产物 |
| round4.analysis_findings | Findings |
| round4.analysis_charting | ChartSection |
| round4.analysis_frontend_render | 前端直达（硬边界） |

默认：build full/evaluation-full 编译；runtime 全关（default/baseline/multimodal-only/lakehouse-only）；显式 `ENABLE_DATA_ANALYSIS=true`。

## 8. 测试

- 单元：`tests/data-analysis.test.mts`（26）、`data-analysis-ui.test.mts`（13）、`data-analysis-context-isolation.test.mts`（3）、`data-analysis-features.test.mts`（7）
- Python：`services/lakehouse-gateway/tests/test_data_analysis_materialize.py`（6）
- E2E：`experiments/e2e-data-analysis.mts`（场景 A-G，18 检查）
- 评测：`experiments/data-analysis/cases.jsonl`（15 案例）+ evaluate.mts
