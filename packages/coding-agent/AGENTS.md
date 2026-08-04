# coding-agent (`@earendil-works/pi-coding-agent`)

编码代理 CLI 和核心会话管理包。提供交互式 TUI、print 模式和 RPC 模式三种运行方式。

## 入口与关键路径

| 路径 | 用途 |
|---|---|
| `src/cli.ts` | CLI 入口，参数解析和模式分发 |
| `src/main.ts` | 主逻辑入口，`main()` 函数 |
| `src/index.ts` | 公共 API 导出（SDK 用途） |
| `src/core/agent-session.ts` | `AgentSession` 类 — 会话生命周期核心 |
| `src/core/session-manager.ts` | `SessionManager` — 会话存储、树导航、分支 |
| `src/core/tools/` | 工具定义（bash, edit, find, grep, ls, read, write） |
| `src/core/extensions/` | 扩展系统 — `Extension`, `ExtensionAPI`, `ExtensionRunner` |
| `src/core/compaction/` | 上下文压缩 — `compact()`, `generateSummary()` |
| `src/core/sdk.ts` | `createAgentSession()` — 编程式 SDK 入口 |
| `src/modes/interactive/` | 交互式 TUI 模式和 UI 组件 |
| `src/modes/rpc/` | RPC 客户端模式（供 TUI 包使用） |
| `src/config.ts` | 配置路径、版本号、`CONFIG_DIR_NAME` |

## 架构概览

```
cli.ts → main.ts → modes/{interactive,rpc,print}
                     ↓
               core/agent-session.ts (会话生命周期)
                     ↓
         ┌───────────┼───────────┐
         ↓           ↓           ↓
    core/tools   core/extensions  core/compaction
    (编码工具)    (扩展系统)       (上下文压缩)
```

- **工具层** (`core/tools/`): 每个工具由 `create*ToolDefinition()` 工厂函数创建，实现 `*Operations` 接口。工具结果类型有对应的 `is*ToolResult()` 类型守卫。
- **扩展层** (`core/extensions/`): 扩展通过 `ExtensionFactory` 注册，获得 `ExtensionAPI` 访问会话、工具和事件。`ExtensionRunner` 管理扩展生命周期。
- **会话层** (`core/session-manager.ts`): `SessionManager` 处理会话 CRUD、树导航、分支和会话上下文构建。`SessionEntry` 是会话数据的联合类型。
- **压缩层** (`core/compaction/`): 当上下文窗口接近满时自动触发。`compact()` 生成摘要并截断旧消息。

## 测试约定

### 常规测试 (`test/`)

- 直接导入源码，使用 `vitest` 运行
- 测试文件命名: `<feature>.test.ts`
- 运行单个测试: `node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts`

### 集成测试套件 (`test/suite/`)

- **必须使用 `test/suite/harness.ts`** 和 faux provider
- **禁止使用真实 API key 或付费 token**
- 通过 `registerFauxProvider()` 注册模拟提供商
- 通过 `FauxResponseStep` 定义模拟响应步骤
- 使用 `streamSimple()` 创建简单流式响应

### 回归测试 (`test/suite/regressions/`)

- 命名格式: `<issue-number>-<short-slug>.test.ts`
- 每个回归测试必须关联 issue 编号
- 使用 harness + faux provider，不使用真实提供商

## 已知陷阱

1. **不要在测试中使用真实提供商** — `test/suite/` 中的测试必须使用 faux provider。真实提供商仅在 e2e 测试中使用（通过环境变量激活）。
2. **`models.generated.ts` 是生成文件** — 不要直接编辑。修改 `packages/ai/scripts/generate-models.ts` 后重新生成。
3. **扩展事件有严格的时序** — `BeforeAgentStartEvent` 在 agent 循环之前触发，`AgentEndEvent` 在之后。修改事件处理时注意顺序依赖。
4. **工具结果类型守卫必须匹配** — 添加新工具结果类型时，同时更新 `is*ToolResult()` 守卫和 `ToolCallEventResult` 联合类型。
5. **会话版本迁移** — 修改 `SessionEntry` 联合类型时，检查 `migrateSessionEntries()` 是否需要添加迁移逻辑。
