# Data Analysis — 前端直达结果通道

## 通道（audit 结论）

Pi 扩展 API 提供原生 Tool UI renderer（`ToolDefinition.renderResult` + `renderShell:"self"`），且 `AgentToolResult.details` 明确为 *"Arbitrary structured details for logs or UI rendering"*——完整审计见 `docs/DATA_ANALYSIS_FRONTEND_CHANNEL_AUDIT.md`。

```
run_data_analysis.execute
  ├─ content  = AnalysisAgentSummary 文本（状态/引用/限制）→ 模型上下文
  └─ details  = AnalysisResultArtifact（完整数值）→ renderResult → TUI 直接渲染
```

- 模型只看到 `content`（provider 转换层只用 content，details 不进 payload）；
- TUI 的 ToolExecutionComponent 调用扩展 `renderResult(result)`，拿到完整 details 渲染数值；
- `analysis_frontend_render=false` 时工具**不注册**——禁止降级为"主 Agent 复述数字"。

## 固定 Schema 渲染

`src/data-analysis/ui/`：
- `contracts.ts`：artifactToViews（METRIC_CARDS/TABLE/图表 → 行文本）+ formatMetricValue（precision/unit 按 schema）
- `formatter.ts`：文本块拼接 + ASCII sparkline
- `renderer.ts`：renderResult 用 TUI Text 组件渲染；`analysisResultText()` 纯函数供测试

renderer 只认识固定 section 类型；不执行任何模型生成的模板/HTML/JS。

## Canary 验收

唯一数字 `918273.645`：
1. 写入脚本产物 `analysis-result.json` ✓
2. 进入 `details` → renderer 可读 ✓（`numericFrontendFidelity`）
3. 绝不进入 `content`/transcript/prompt/finding claim ✓（`modelContextNumericLeakageRate = 0`）

## 约束

- TUI 组件仅在 interactive 模式渲染；print/rpc 模式无 UI（details 仍不进模型，语义一致）。
- `appendEntry`/`registerEntryRenderer` 是纯 UI 通道（不进 LLM 上下文），可作图表降级；主通道仍为 renderResult。
- `sendMessage`/`registerMessageRenderer` 的 CustomMessage 会进入模型上下文（作为 user 消息）——**禁止**用于承载数值。
