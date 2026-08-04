# Multimodal Artifact PoC — Agent Rules

When the user asks to analyze an image, and the current model does NOT have vision capabilities:

1. **Do NOT claim to have seen the image.** You are a text-only model and cannot view images.
2. **Call `parse_image` first.** Use the tool with the image path the user provided.
3. **Only reason from the structured JSON** returned by `parse_image`. Do not invent or guess.
4. **If OCR confidence is low (< 0.5)** or the content appears incomplete, clearly state the limitation to the user.
5. **Do NOT guess numbers, labels, or graphics** that are not present in the OCR output.
6. **If `parse_image` returns warnings**, inform the user about them.
7. **For table-like content**, present it in a structured format (rows/columns) based on the text blocks.
8. **For dashboard-like content**, summarize key metrics but note that chart visualizations (bars, lines, pies) cannot be interpreted.

## Fallback

If the model cannot autonomously call `parse_image`, use the `/image` command:

```
/image fixtures/sample.png
```

This directly executes OCR and injects the structured result into the conversation.

## Data Access & Computation

数据获取与数据计算必须分离：

1. 业务数据只能通过已注册的数据工具和 Lakehouse Gateway 获取；不得通过临时脚本绕过 Gateway 直接访问底层数仓。
2. 简单过滤、分组和 count/sum/avg/min/max 优先使用结构化 QueryPlan，不要求额外编写脚本。
3. 涉及多步计算、跨查询计算、统计分析、复杂派生指标、模型评估或绘图时，必须使用可复现脚本执行，不得由语言模型直接心算或仅凭文本推导。
4. 使用脚本时，必须先将完整脚本写入文件，再通过命令执行；禁止使用 `python -c`、`node -e` 或多行 heredoc 内联复杂脚本。
5. 脚本的输入应来自受控查询结果或 artifact；输出应记录 queryId、snapshotId、脚本路径或脚本哈希及计算结果。
## Mandatory Feature-Flag Policy

任何新增用户可见能力、Agent 工具、Skill、API、模型调用、子 Agent、
规则组、Evidence 来源、数据适配器或执行路径，都必须在实现前设计并注册：

1. 编译时开关；
2. 运行时开关；
3. 父功能和依赖关系；
4. 默认启用状态；
5. 开启测试；
6. 关闭测试；
7. 至少一个消融配置；
8. Feature Snapshot 记录。

禁止先实现功能、后补开关。

新增功能必须先修改 `config/features/registry.json`，取得唯一 feature ID，
再实施工具注册、API 挂载和内部执行逻辑。

关闭状态必须保证：

- 工具不注册；
- API 不挂载或不执行；
- 模型和重型依赖不加载；
- 内部组件不运行；
- 结果不进入 Evidence 或最终答案。

未具备完整 Feature Flag 接线和测试的功能，不得视为完成，不得提交。

**开始实现新功能前，先输出或填写 Feature Implementation Checklist**
（`docs/templates/FEATURE_IMPLEMENTATION_CHECKLIST.md`），并确保通过
`npm run check`（含 `scripts/check-feature-hygiene.mts` 机器检查）。

## Data Analysis Subagent Rules (Round 4)

1. 复杂分析由独立上下文的子 Agent 完成；子 Agent 不得直接访问数仓、数据库凭证、Gateway 内部路径或全局聊天历史。
2. 复杂计算必须真实执行：完整脚本写入 workspace 文件后由受控 runner 运行（`python3 <workspace>/analysis.py`）；禁止 `python -c`、`node -e`、heredoc 内联执行。
3. 简单聚合（单 count/sum/avg/min/max/group by）优先走 Query Gateway（task gate），不绕到 Python。
4. 数字、表格和图表只通过 Result Artifact + UI renderer（details 通道）展示；主 Agent 的 tool content / transcript 不得包含具体数值（硬边界，不可消融）。
5. `analysis_frontend_render` 关闭时 run_data_analysis 不注册，禁止降级为模型复述数字。
6. Result Artifact 的 reviewStatus 恒为 `NOT_REVIEWED`；本轮不做审核，第五轮独立审核 Agent 只读不可变 Artifact 与 Execution Manifest。
7. Findings 不等于审核通过；相关性/贡献/趋势不得表述为因果（causalClaim 恒 false）。
8. 脚本失败只允许有限重试（≤2 次，仅语法/导入/结果 schema/数值类错误）；权限/输入/沙箱违规不得重试绕过。

## Pipeline Governance Rules (Phase 1)

1. Governance Agent 只产出 SchemaSpec/PipelineSpec 草案与假设；不执行、不编译部署、不写审批存储。
2. 审批仅 OPERATOR_CLI：`python3 -m pipelines.governance approve`，绑定 reviewContentHash + osActor；Agent 无 Shell / approval CLI / 审批存储写权限。
3. PipelineDraftArtifact 恒为 executable=false；未经 APPROVE 不得密封（四哈希：schema/pipeline/draft/reviewPackage）。
4. 新版本 Spec 必须走 PipelineAmendment，旧版本不可变；旧审批不得复用。
5. 运行数据只在 .data/pipeline-governance/，禁止进入 Git。
