# Pi 前端结果通道审计（Data Analysis Subagent 前置审计）

日期：2026-08-02
范围：确认 Pi 扩展 API 是否支持"UI 可读、模型上下文不可见"的数值结果通道。
方法：读取真实代码路径（`packages/coding-agent/src/core/extensions/types.ts`、`packages/agent/src/harness/messages.ts`、`node_modules/@earendil-works/pi-agent-core/src/agent-loop.ts`、`packages/ai/src/api/anthropic-messages.ts`），以代码为准，不凭名称猜测。

## 1. tool.execute 返回值中哪部分进入模型上下文

`AgentToolResult<T>`（`pi-agent-core/src/types.ts:355`）：

```ts
export interface AgentToolResult<T> {
  /** Text or image content returned to the model. */
  content: (TextContent | ImageContent)[];
  /** Arbitrary structured details for logs or UI rendering. */
  details: T;
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}
```

- **`content`**：唯一进入模型上下文的部分。`agent-loop.ts:773-787` 的 `createToolResultMessage` 把 `content` 写入 `ToolResultMessage`。
- **`details`**：类型注释明确为 *"Arbitrary structured details for logs or UI rendering"*。跟踪其流向：
  - `agent-loop.ts:736-737`：`afterToolCall` 钩子可改写 content/details，不改变语义；
  - `createToolResultMessage` 把 details 放进 `ToolResultMessage.details`（会话历史用）；
  - **provider 转换层不使用 details**：`packages/ai/src/api/anthropic-messages.ts:1098-1113` 只取 `msg.content` 构造 `tool_result` block；openai 系 API 同样只序列化 content。`packages/ai/src/types.ts:416-420` 的 ToolResultMessage.details 标注 `TDetails`，未出现在任何 provider payload 构造路径。
- **结论**：**details 不会发送给模型**。完整数值 JSON 放 details 是安全的。

## 2. 前端（TUI）如何读取工具结果

- **`ToolDefinition.renderResult`**（`core/extensions/types.ts:491-497`）：签名
  `(result: AgentToolResult<TDetails>, options, theme, context) => Component`。
  调用方：`packages/coding-agent/src/modes/interactive/components/tool-execution.ts:91-98` `getResultRenderer()` —— TUI 渲染工具结果行时**真实调用**扩展提供的 renderResult，参数含**完整 result（含 details）**。
- **`ToolDefinition.renderCall`**：同组件 81-88 行，渲染工具调用行（可显示参数）。
- **`renderShell: "default" | "self"`**（types.ts:464）：`self` 时工具自绘整个结果框架。
- **结论**：扩展可在 renderResult 中读取 details 里的 AnalysisResultArtifact，用 TUI Component 直接绘制数字/表格/图表。

## 3. 是否支持 renderCall / renderResult / 自定义 Tool UI / 结构化事件 / Artifact 卡片

| 能力 | 支持 | 依据 |
|------|------|------|
| renderCall | ✅ | ToolDefinition.renderCall，tool-execution.ts:81-88 |
| renderResult | ✅ | ToolDefinition.renderResult，tool-execution.ts:91-98 |
| 自定义 Tool UI（自绘框架） | ✅ | renderShell:"self" |
| 结构化事件 | ✅ | tool_execution_start/update/end 事件（types.ts:761-785） |
| Artifact 卡片 | ✅ | 自定义 Component 可渲染任意文本/边框（不依赖内置卡片） |
| registerEntryRenderer + appendEntry（不进 LLM 上下文） | ✅ | types.ts:1289-1290 注释 "Custom entries do not participate in LLM context" |
| registerMessageRenderer（CustomMessage） | ✅ | types.ts:1284；注意 CustomMessage 会作为 user 消息进入模型上下文（messages.ts:133-140）——不可用于承载数值 |

## 4. 结论与实现路径

**结论：Pi 原生 Tool UI renderer（路径 A）可用，且 details 通道天然满足"UI 可读、模型不可见"。**

采用路径 **A（原生 Tool UI renderer）**：

- `run_data_analysis` 的 execute 返回：
  - `content`：仅状态摘要（artifactId、runId、status、displayedDirectly=true、reviewStatus=NOT_REVIEWED）——**不含任何数值**；
  - `details`：完整 `AnalysisResultArtifact`（metric values、table rows、chart series）——**只给 renderResult**；
- `renderResult`（`renderShell: "self"`）：从 details 读取固定 Schema 的 sections（METRIC_CARDS / TABLE / LINE_CHART / BAR_CHART / SCATTER / HISTOGRAM），用 TUI Component 渲染。

## 5. Canary 可验证性

唯一数字 `918273.645`：
- 写入 `analysis-result.json` 与 `details` → renderResult 可读；
- 绝不写入 `content` → 模型不可见；
- 测试断言：content 文本、main transcript、prompt capture 中均无该数字。

## 6. 已知边界

- TUI 组件仅在 interactive 模式渲染；print/rpc 模式无 UI（details 仍不进模型，行为一致）。
- `appendEntry`/`registerEntryRenderer` 是**纯 UI 通道**（不落模型消息），可用作图表降级展示，但主通道仍走 renderResult。
- CustomMessage（含 details）会进入模型上下文（作为 user 消息），**禁止**用于承载数值。
