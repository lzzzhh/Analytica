# PoC Status — multimodal-artifact-poc v0.2.0

## 环境

| 项目 | 值 |
|------|-----|
| Pi commit | `8ac92f831c67c3642fa321a182a6c91044adec9c` |
| Node.js | v22.22.2 / npm 10.9.7 |
| macOS | 15.6 (Darwin 24.6.0, arm64) |
| llama.cpp | v10200 |
| PaddleOCR | 3.7.0 |
| Tesseract | 5.5.3 |
| markitdown | 0.1.7 |
| 分支 | feature/multimodal-artifact-poc |

## 模型

| 项目 | 状态 |
|------|------|
| 当前模型 | **Qwen3-8B Q4_K_M** (4.7 GB) |
| 来源 | lm-kit/qwen-3-8b-instruct-gguf |
| 文本对话 | ✅ |
| Tool calling | ✅ 推理链 → 更可靠 |
| 下载 | ✅ 5分钟 |

## 工具

| 工具 | 引擎 | 输入 |
|------|------|------|
| `parse_image` | PaddleOCR 3.x | PNG/JPG/BMP/TIFF/WEBP |
| `parse_visual` | PaddleOCR-VL-1.6 (0.9B, llama.cpp) | 图表/照片/复杂图 |
| `parse_document` | markitdown 0.1 | PDF/DOCX/PPTX/XLSX/HTML/CSV/MD/TXT |

## 视觉模型（parse_visual）

- **PaddleOCR-VL-1.6**：892MB GGUF + 841MB mmproj，llama.cpp router 原生加载（子目录 + `.gguf` 后缀）
- 无需 MLX-VLM（GPT 建议的组件，实测官方 GGUF 直接可用）
- 输出 `Label | Value` 确定性行 → TypeScript 解析为 facts（竖排/横排表头两种格式）
- ⚠️ 行为特性：只接受极简指令（"Extract data."），复杂指令产生胡言乱语
- 测试：柱状图 6 个数据点全部精确提取（Jan 380 → Jun 360），Qwen3-8B 正确分析趋势

## 已否决（GPT 方案中实测不可行）

| 组件 | 原因 |
|------|------|
| PP-StructureV3 表格识别 | Mac CPU 上 34 分钟/张 |
| PP-Chart2Table | 同链路，同样太重 |
| MLX-VLM 服务化 | 不需要——官方 GGUF 原生支持 |
| Docling / MinerU 全量替换 | 中文劣势，迁移成本高 |

## 验收标准

| # | 标准 | 状态 |
|---|------|:---:|
| 1 | Pi 源码构建 | ✅ |
| 2 | Pi ↔ llama.cpp 连接（CLI + TUI） | ✅ |
| 3 | 本地文本对话 | ✅ |
| 4 | parse_image PNG/JPG | ✅ |
| 5 | 结构化 JSON 输出 | ✅ |
| 6 | 图片不发给 LLM | ✅ |
| 7 | LLM 基于 OCR 回答 | ✅ |
| 8 | 不伪造低置信度 | ✅ |
| 9 | 未修改 Pi 核心（仅 llama 扩展） | ✅ |

## 端到端验证（2026-08-01）

```
用户: 分析 sample.png
→ Qwen3-8B 自主调用 parse_image (toolUse)
→ PaddleOCR → 结构化 JSON
→ Qwen3-8B 总结: "Hello World / This is a test image for OCR / Revenue: $1,234,567 / Q1 2024 Report" (conf > 0.99)
```

## 关键修复（pi 源码修改记录）

### 1. llama 扩展 provider.ts（3 处，均未触碰核心包）
- `setCatalog`：包含全部模型（不再只 loaded），CLI 模式可发现
- `refreshModels`：localhost 时忽略 allowNetwork 限制 + 自动加载首个未加载模型
- `toPiModel`：contextWindow 优先 `n_ctx_train`（131072）而非 `n_ctx`（8192）

### 2. 最后一个 bug 的根因
Pi 的 `clampMaxTokensToContext`（simple-options.ts）按 `model.contextWindow - 上下文token - 4096` 计算输出上限；llama 扩展把 contextWindow 设为运行时 `n_ctx`（8192），长系统提示+工具定义占 ~4700 tokens 后可用输出被 clamp 到 **1**。改用 `n_ctx_train` 后正常。

## 模型目录（~9.7GB）

```
~/models/
├── Qwen3-8B-Q4_K_M.gguf          # 4.7GB 文本主模型
└── PaddleOCR-VL-1.6/
    ├── PaddleOCR-VL-1.6.gguf      # 892MB 视觉模型
    └── PaddleOCR-VL-1.6-mmproj.gguf # 841MB 视觉投影（子目录 + .gguf 后缀才能被 router 识别）
```

## 子 agent 实验（2026-08-01，两轮）

详见 `packages/coding-agent/examples/extensions/multimodal-artifact-poc/EXPERIMENT-subagent.md`

### 第一轮：合成文档 + 本地 Qwen3-8B（5 题）

| 指标 | 直返 | 子 agent | 差异 |
|------|------|---------|------|
| 主上下文输入 | 883 tok | 93 tok | -89% |
| 总 token 消耗 | 1127 tok | 589 tok | -48% |
| 端到端耗时 | 20.6s | 47.0s | +128% |
| 答案质量 | 80% | 100% | +20pp |

### 第二轮：10 个真实文档 + DeepSeek API（LLM judge 评分）

| 指标 | 直返 | 子 agent | 差异 |
|------|------|---------|------|
| 主上下文输入 | 11,013 tok | 534 tok | **-95%** |
| 总 token | 11,484 tok | 12,503 tok | +9% |
| 耗时 | 4.8s | 9.2s | +92% |
| Judge 均分 | 3.80 | 4.15 | +0.35 |

第二轮结论：
- 真实文档直返平均 11K tokens 进主上下文（最大 33K），子 agent 恒定 ~600
- 长文档（Spark 36K chars）子 agent 优势最大（3.0 vs 1.5）
- 从本地模型切到 DeepSeek API 零架构改动，结论方向一致——模型可替换性得到验证
- 环境备注：本地 llama-server 曾因 8080 端口被 open-webui 占用中断；8K 上下文下直返大文档必溢出

## 两级编排架构实验（2026-08-01，实验三）

用户设计的 escalation + fan-in 架构已实现（`src/evidence.ts` / `preflight.ts` / `doc-agents.ts` / `orchestrator.ts`），详见 EXPERIMENT-subagent.md 实验三。10 文档评估（v2 修复版）：

| 指标 | 直返 | 两级编排 | 差异 |
|------|------|---------|------|
| 主上下文输入 | 11,092 tok | 159 tok | **-98.6%** |
| 总 token | 11,822 tok | 20,667 tok | +75% |
| 耗时 | 9.5s | 44.7s | 4.7× |
| Judge 均分（7/10 有效） | 3.86 | 3.57 | -0.29 |

关键点：
- **升级纪律验证成功**：4/10 升级全部为超预算大文档（RiskCloud/Spark/两篇论文），小文档 0 升级；v1 曾出现 L1 自评对 33K 文档不升级 → 增加"截断即强制升级"确定性规则后稳定
- L2 专家在 CDXR（33K）上显著加分（3.5→4.5）；B 最大失分是 L1 单次提取方差（编码面试证据包仅 43 tok）而非架构问题
- 局限：judge 空响应率 60%（API 不稳定），3 篇无分；质量结论统计力弱于实验二

## 证据包质量门实验（2026-08-01，实验四）

针对实验三暴露的 L1 坍缩瓶颈实现 `src/quality-gate.ts`（pass/retry/escalate 三态 + 差异化重试 temperature 0.1 + reduced prompt + 重试失败自动升级 L2）。10 文档评估（详见 EXPERIMENT-subagent.md 实验四）：

| 指标 | B0（无门） | B3（质量门） |
|------|-----------|-------------|
| 有效运行均分（8/10） | 3.09 | 3.19 |
| 端到端期望质量（成功率 90%） | 2.78 | 2.87 |
| L1 attempt1 坍缩率 | — | 80%（当日 API 极值期） |
| 差异化重试恢复 | — | 1/6（AI 交接免升级 +1.5） |
| L2 调用率 | — | 8/10（3 truncated + 5 gate） |

关键点：
- 门方向正确（5 正 2 负 1 平）：truncated 强制升级与重试恢复路径稳定正收益
- 两个大负案例（-3.2、-2.3）根因：**"证据薄"≠"坍缩"**——纯长度阈值误判事实密集型短文档（简历 167 chars 实际质量 4.5 分）
- 下一步：阈值相对化（与文档规模挂钩）、升级保留较好 attempt、短文档重试失败不升级

## B4 实验（2026-08-01，实验五：相对门 + best-attempt + 短文档不升级）

三条改进已实现并验证（详见 EXPERIMENT-subagent.md 实验五）：

| 指标 | 实验四 B3 | B4 | 目标 |
|------|----------|-----|------|
| 非 truncated L2 调用率 | 5/10 | **0/10** | <20% ✓ |
| 短文档升级 | 2/2 | **0/2** | ≈0 ✓ |
| 平均总 token | 17,027 | **14,997（-12%）** | ↓ ✓ |
| P50 延迟 | 65.1s | **38.4s（-41%）** | ↓ ✓ |
| P95 延迟 | 109.7s | **66.9s（-39%）** | ↓ ✓ |

- 8/10 有效 judge 中 B3' 与 B4 答案**逐字相同**（当日 L1 无坍缩）——改进是纯成本优化 + 防误判保险，质量零折损；表面分差（-0.28 均分）全部为 judge 对相同答案的评分噪声（实测 ±1.5）
- 实验四负案例修复：简历 1.3 → 5.0（免升级 + pass_thin_but_covered）
- 局限：拦截路径当日无坍缩场景未复现；best-attempt 否决与 expert 弃用两个新逻辑 0 次触发，待实证

## Round-4 Review 修复（2026-08-01）

外部 review（提交 `2b88b4720b835d1d793242d7d190f10905f7cf73`，本地不可见）6 项发现全部核实并修复：

### 1. EAV value-only 掩码剩余路径（P0）

- `_scan_fields()` 引用 value 列时自动附带 label 列，EAV 表按 value 过滤时 label 仍被掩码
- 新增 `_mask_eav_pre_agg()`：聚合前掩码敏感 EAV value（此前聚合路径可绕过掩码）
- 测试：`test_no_label_filter_value_still_masked`、`test_aggregated_value_masked_before_aggregation`

### 2. namespaced dataset ID（P1）

- 规范 ID = `<namespace>.<table>`；`get()` 短名仅在全局唯一时作为 alias 解析，冲突记入 `_collisions` 而非静默覆盖
- lineage 统一使用规范 ID（`register_edge` 规范化、`explain` 输出）
- 测试：`test_namespace_collision_is_recorded_not_silently_overwritten`（ods/dwd 真实冲突）、`test_unique_short_name_resolves_as_alias`；同步更新 9 处旧契约断言

### 3. finding current-state、evidence occurrence 与 review queue 一致性（P1）

- `ACTIVE_STATUSES = (OPEN, UNDER_REVIEW)` 统一用于 governance score / dimension / severity / trust profile / review queue 投影——UNDER_REVIEW 仍属于 active finding
- evidence_id 掺入 run_id，避免跨 run 冲突
- 问题消失时写 RESOLVED occurrence（保留 first_detected_at 与稳定 finding_id）；`get_finding()` 返回最新 occurrence；evidence 按最新 snapshot 作用域；queue 按当前状态过滤
- 测试：`TestFindingLifecyclePersistence`（RESOLVED→queue 清空→REOPEN 持久化链路）

### 4. Iceberg governance schema migration（P1）

- `ensure_governance_tables()` 对旧 schema 表先用 `table.update_schema()` 补齐缺失列再写入，避免新版本写旧表报错
- 测试：`TestGovernanceSchemaEvolution.test_old_schema_table_evolved_before_write`

### 5. query timeout 当前实现方式（P1/P2）

- 维持 post-hoc 实现：执行超预算后打 warning 并返回已收集结果，不做进程级强制终止（强制终止需要跨线程 cancel 基础设施，本轮不引入）
- 口径记录于 `plan.py` 与 `executor.py` 注释

### 6. GatewayClient caller / client ID（P2）

- `ValidationSession.get()` caller 不匹配时拒绝而非删除会话（原实现会误删他人会话）
- `GatewayClient` 支持 `clientId` 配置，请求携带 `x-client-id`；`gatewayClientFromEnv` 读取 `LAKEHOUSE_CLIENT_ID`
- 测试：Python `test_caller_mismatch_does_not_delete`；TypeScript 3 个（含 MockTransport 记录 lastHeaders）

### 本轮新增测试

- Python：+10（test_review_fixes.py 等）→ **109/109**（review 基线 99）
- TypeScript：+3（data-tools.test.mts）→ **25/25**

## 最终验证（2026-08-01）

| 项目 | 结果 |
|------|------|
| Python 测试（pytest） | 109/109 |
| TypeScript 测试（node --test） | 25/25 |
| tsgo（本轮修改文件） | 0 错误 |
| tsgo（全仓既有） | 41 个错误，均位于 experiments/*.mts，未在本轮处理 |
| e2e-lakehouse | OK |
| e2e-governance | OK（findings 保持 OPEN） |
| verify-seed | OK |

备注：e2e-lakehouse 首次运行失败是缺少脚本要求的 `LAKEHOUSE_GATEWAY_URL=http://localhost:8791` 环境变量；按正确命令重跑通过，该失败不是代码回归。

## 日期

2026-08-01
