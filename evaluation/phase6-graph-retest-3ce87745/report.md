# Analytica 图结构全量复测报告

结论：`NEEDS_AGENT_AND_GRAPH_FIXES`

Analytica 的图执行框架具备确定性状态归约、事件存储、治理预检、反馈/恢复和人工授权测试，但当前真实模型的正式分析任务无法端到端完成。Pipeline、Multimodal、Reviewer 的确定性能力保持稳定；Requirement 约束提取、Data Analysis、工具工作流和图内 Artifact 交接仍是主要阻塞项。

## 评测绑定

- Commit：`3ce87745f9b1546a10ab7fd015dc543eec8bc7ba`
- 模型：`openai/gpt-5.6-luna`，reasoning `max`
- Node：`/Users/zhanhuilin/.hermes/node/bin/node`，`v22.22.2`
- Python：`/opt/anaconda3/bin/python`，`3.13.5`
- Feature snapshot：`574bc8dd0cc5e162`
- 设计冻结 Hash：`9fb3762703b5c4c6b2fb3dfffe3bbd8773e0c5be81d748c3df7131a947483583`
- 数据：14 个冻结公开数据集，来源、License、SHA-256、Schema、行数见 `pipeline/dataset-source-manifest.json`
- 图回归测试：34/34 PASS；产品代码未修改

## 28 项指标

前 27 项在任何模型调用前冻结；第 28 项 token 用量是用户在执行期间新增的只读遥测，不改变 Golden 或成功条件。括号内为相对上一轮的百分点变化。

| 类别 | 指标 | 本轮结果 | 对比上一轮 |
|---|---|---:|---:|
| 全局 | Task Success Rate | 31/48 = **64.58%** | +2.08 pp |
| 全局 | Consistency@3 | 8/12 = **66.67%** | +8.33 pp |
| 全局 | Hallucination Rate | 0/48 = **0%** | -2.08 pp，改善 |
| 全局 | Correct Abstention Rate | 12/12 = **100%** | 0 pp |
| 全局 | Robustness Drop | **8.33 pp** | 0 pp |
| 全局 | Worst-Slice Accuracy | Data Analysis：**0%** | 0 pp |
| 工具 | Single-Tool Task Success Rate | 6/12 = **50.00%** | -16.67 pp |
| 工具 | Argument Accuracy | 108/512 = **21.09%** | -13.85 pp |
| 工具 | Tool Set F1 | **73.68%** | -6.96 pp |
| 工具 | Multi-Tool Task Success Rate | 4/12 = **33.33%** | -8.33 pp |
| 工具 | Workflow Task Success Rate | 0/12 = **0%** | -33.33 pp |
| 工具 | Orchestration Accuracy | 13/30 = **43.33%** | -40.00 pp |
| Requirement | Route Accuracy | 11/12 = **91.67%** | 0 pp |
| Requirement | Constraint Recall | 1/39 = **2.56%** | 0 pp |
| Multimodal | pass@1 | 4/4 = **100%** | 0 pp |
| Multimodal | pass@3 | 4/4 = **100%** | 0 pp |
| Multimodal | Structured Extraction F1 | **100%** | 0 pp |
| Data Analysis | Analysis Task Success Rate | 1/8 = **12.50%** | 0 pp |
| Data Analysis | Numerical Correctness | 2/26 = **7.69%** | -11.54 pp |
| Pipeline | Pipeline Run Success Rate | 14/14 = **100%** | 0 pp |
| Pipeline | Data Correctness Rate | 70/70 = **100%** | 0 pp |
| Pipeline | Data Quality Defect Detection F1 | **100%** | 0 pp |
| Pipeline | Idempotent Rerun Success Rate | 14/14 = **100%** | 0 pp |
| Reviewer | High-Severity Defect Recall | 6/6 = **100%** | 0 pp |
| Reviewer | False Positive Rate | 0/4 = **0%** | 0 pp |
| 安全 | Hard-Gate Violation Count / Rate | 0/20 = **0%** | 0 pp |
| 时延 | 成功完整任务平均时间 | **4.336 s**，2/5 场景成功 | 新指标 |
| Token | 成功任务父级可观测平均用量 | **2,243.7 tokens**，41 个成功任务 | 新增遥测 |

## 时延与 token

成功完整任务耗时只纳入满足全部 Oracle 的场景：Pipeline 6.226 s、Multimodal 2.445 s，均值/中位数 4.336 s，p95 6.226 s。失败耗时不混入该均值：图正式交付 41.036 s、工具工作流 29.361 s、Data Analysis KPI 180.807 s。由于只有 2/5 个代表场景成功，该均值可复算但不能代表当前完整产品链路的稳定服务时间。

85 个父级 Pi 可观测任务的平均用量为 5,243.6 tokens，中位数 2,674，p95 16,107；其中 41 个成功任务平均 2,243.7，中位数 2,145，p95 3,206。工具工作流切片均值 12,460.1，是主要 token 长尾。内部 Data Analysis/Reviewer 子代理没有向父轨迹暴露 usage，因此“完整系统端到端平均 token”状态为 `ABSTAIN`，不能把父级数字冒充全系统用量。

## 图结构真实 E2E

公开入口 `run_analysis_graph` 成功创建 9 节点图，治理预检通过，但 `task.analysis` 以 `SCHEMA_INVALID` 失败，Reviewer、报告、交付验证均未执行。真实模型生成的脚本搜索 `.csv` 等文件；宿主把 Artifact 固定复制为 `<artifactId>.data`，而 input manifest 未包含实际 `path/fileName`。证据：`graph-e2e/result.json`、`graph-e2e/raw-trace.jsonl`、图 workspace，以及 `data-analysis/index.ts:237-265` 和 `workspace.ts:103-113`。

即使修复上述交接，正式报告节点仍必然失败：`graph-engine/adapters/report.ts:20-30` 明确抛出 `REPORT_SKILL_UNAVAILABLE`。因此 34/34 图单测只能证明编排状态机和 fake adapter 合同；不能证明真实正式交付链路可用。测试 fake subagent 会主动枚举 `.data` 文件，正好绕过了真实模型暴露的契约缺口。

## 需要修复的问题

### P0

1. 明确 Data Analysis 输入文件契约：在 manifest 中传递宿主生成的绝对/受控相对路径与格式，模型脚本不得猜扩展名；增加真实 materialization 合同断言。
2. 为 `skill.analysis.report` 提供可执行实现并接入 ArtifactStore、Reviewer 授权和 deliverable verifier；当前正式图任务按设计不可能完成。
3. 修复 Data Analysis 子代理稳定性：8 个独立串行场景中 5 个在 `waitForIdle(180000)` 超时，1 个计划被判 objective 变更，仅 1 个完整成功。超时不是本轮并发造成。

### P1

1. Requirement 虽能正确路由 11/12，但只召回 1/39 个冻结约束；结构化 card 仍未承载用户限制。
2. 工具调用相较上一轮全面退化，尤其 Workflow 0/12、Orchestration 13/30；重复 search/analysis 调用同时降低参数准确率并造成 token 长尾。
3. Reviewer 确定性缺陷检测良好，但全局 Reviewer 切片仅 4/8；`GM-REV-02` 只调用 `review_data_analysis`，没有完成要求的 gate inspection/promotion 链。

### P2

1. 增加 public graph 的真实 Artifact 文件名/manifest/report 合同测试，避免 fake adapter 掩盖真实模型交接失败。
2. 图模块使用动态 import，与仓库 `AGENTS.md` 的 top-level import 规则不一致；这是工程规范问题，不计入业务失败。

## 状态说明

- 场景结果使用 `PASS / FAIL / ABSTAIN / NOT_RUN / INFRA_ERROR`。
- 缺失构建产物和初始 Fixture 注册问题均隔离为 `infra-attempt*`，修正环境后只重跑受影响场景，不计业务 FAIL。
- Data Analysis 串行超时在同一固定环境中与成功场景并存，归为被测模型集成/任务稳定性失败，不归为基础设施失败。
- Governance：14/14 未授权写入均被阻止，未确认绕过；`governanceBypassConfirmed=false`。

## 主要证据

- `coverage-matrix.json`：28 项指标、旧值和 delta
- `scores.json`：各套件合并结果
- `latency.json`：5 个完整任务场景的边界与耗时
- `token-usage.json`：85 个父级任务及分切片 token
- `graph-e2e/`：真实图调用原始轨迹、事件存储和 workspace
- `tool-calling/`、`global/`：84 条真实模型原始轨迹及确定性评分
- `pipeline/`：14 数据集 Manifest、Hash、Golden、Mutation、Snapshot 和运行结果
- `agents/`：Requirement、Multimodal、Data Analysis、Reviewer 的逐场景证据

