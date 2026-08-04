# ai (`@earendil-works/pi-ai`)

多提供商 LLM 统一接口层。提供模型定义、提供商适配、认证和类型系统。

## 入口与关键路径

| 路径 | 用途 |
|---|---|
| `src/index.ts` | 核心公共 API（仅导出核心、无副作用的模块） |
| `src/types.ts` | 核心类型定义 — `Model`, `ModelDefinition`, 消息类型 |
| `src/models.ts` | 模型注册和查询接口 |
| `src/models-store.ts` | 模型存储和持久化 |
| `src/models.generated.ts` | **生成文件** — 模型目录数据（见下方警告） |
| `src/api/` | 提供商 API 实现（每个提供商一个文件） |
| `src/providers/` | 提供商定义（`*.models.ts` 定义模型，`*.ts` 定义提供商工厂） |
| `src/auth/` | 认证系统 — 凭证存储、OAuth、认证上下文 |
| `src/compat/` | 旧版全局 API 兼容层（`faux` provider 也在此导出） |
| `src/utils/` | 工具函数 — 重试、验证、JSON 解析、事件流 |

## 架构概览

```
src/index.ts (核心 API — 无副作用)
     ↓
┌────┴────┐
↓         ↓
api/     providers/
(流式    (模型定义 +
 适配)    提供商工厂)
     ↓
auth/ (认证 + OAuth)
     ↓
compat/ (旧版兼容 + faux provider)
```

- **API 层** (`src/api/`): 每个提供商一个实现文件（如 `anthropic-messages.ts`）和一个 `.lazy.ts` 包装器用于延迟加载。API 函数接收提供商特定选项，返回流式事件。
- **提供商层** (`src/providers/`): 每个提供商有两个文件：`<name>.models.ts`（模型定义数组）和 `<name>.ts`（提供商工厂函数）。新增提供商需要同时创建这两个文件。
- **模型目录**: `src/models.generated.ts` 由 `scripts/generate-models.ts` 从 `scripts/model-data.ts` 生成。包含所有提供商的模型元数据。

## 关键约定

### 添加新提供商

1. 创建 `src/providers/<name>.models.ts` — 导出模型定义数组
2. 创建 `src/providers/<name>.ts` — 导出提供商工厂函数
3. 在 `scripts/model-data.ts` 中注册提供商数据
4. 运行 `node scripts/generate-models.ts` 重新生成模型目录
5. 在 `src/api/` 中创建 API 实现（如需要新的 API 协议）

### 添加新模型到现有提供商

1. 在对应的 `src/providers/<name>.models.ts` 中添加模型定义
2. 在 `scripts/model-data.ts` 中更新模型数据
3. 运行 `node scripts/generate-models.ts` 重新生成

## 已知陷阱

1. **绝对不要直接编辑 `src/models.generated.ts`** — 这是生成文件。修改 `scripts/generate-models.ts` 和 `scripts/model-data.ts`，然后重新生成。直接编辑会在下次生成时丢失。
2. **`src/index.ts` 仅导出核心模块** — 提供商工厂和 API 实现不在核心导出中。它们通过子路径导入访问（如 `@earendil-works/pi-ai/providers/anthropic`）。
3. **API 文件有 `.lazy.ts` 包装器** — 延迟加载用于避免在不需要时初始化提供商 SDK。新增 API 实现时同时创建 lazy 包装器。
4. **测试中的模型 ID 必须存在于类型系统中** — 测试使用 `ModelId<...>` 类型约束。添加测试用的新模型 ID 时，确保它已在 `models.generated.ts` 中注册。
5. **faux provider 在 `compat/` 中** — 测试用的模拟提供商通过 `@earendil-works/pi-ai/compat` 导入，不在核心导出中。`registerFauxProvider()` 和 `streamSimple()` 是测试的主要工具。
6. **提供商特定选项类型不互通** — `AnthropicOptions`、`OpenAICompletionsOptions` 等是独立类型。跨提供商的通用逻辑使用 `Model` 接口抽象，不要尝试统一选项类型。
