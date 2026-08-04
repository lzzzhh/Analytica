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

## 子 agent 一览（2026-08-02，状态基于生效快照）

> 状态口径：**生效快照**（`build/feature-manifest.json` buildEnabled + `config/features/runtime-profiles/default.json` runtime profile），而非 registry 字段本身。当前 build manifest 90 项中 85 项 enabled，5 个 NOT_BUILT 全部为 `ablate.*` 不安全消融项；default runtime profile 全开。

### 表 A：pi 子 agent（注册为 pi 工具，由 pi 调用 LLM 的子代理）

| # | 子 agent | 工具 | feature | 状态 |
|---|----------|------|---------|------|
| 1 | 文档分析子代理 | `analyze_document` | `round1.document_subagent` | ON |
| 2 | 双层文档代理（flash+pro） | `analyze_document_v2` | `round1.document_orchestrator_v2` | ON |
| 3 | L2 专家升级（编排内部，非独立工具） | — | `round1.l2_expert` | ON |
| 4 | 数据分析子 agent | `run_data_analysis` | `round4.analysis_subagent` | ON |
| 5 | 需求规划 advisor | `prepare_business_task` | `round4.planning_advisor` | ON |

默认注册工具共 16 个，其中子 agent 入口 4 个（`analyze_document` / `analyze_document_v2` / `run_data_analysis` / `prepare_business_task`），L2 专家为文档编排内部升级机制。

### 表 B：数据治理控制面（Python 侧独立控制平面，非 pi 工具）

存在于 `pipelines/governance/`，由事件驱动、经 `python3 -m pipelines.governance` CLI 操作，**不注册为 pi 工具、不是 pi 会话里的工具调用**：

| 组件 | 职责 |
|------|------|
| `AgentWorker`（agent_worker.py） | 事件触发（异常/阶段完成/审批事件白名单），读 PipelineContextPackage 上下文包产出 findings/建议；不驻留、不写状态、不直接改作业/数仓。**LLM 未接线**：`caller` 参数注入，默认 stub 返回失败（`no caller injected`），仅测试/E2E 用 fake caller |
| `RuntimeGovernance`（runtime_governance.py） | Spark/Flink/Iceberg 运行时适配器（fixtures only，`verified=false`，不虚构生产能力） |
| `DeadlineWatchdog`（contracts/coordinator/repository） | 持久化 lease，heartbeat 与 progress 分离，只产 anomaly，从不修改/重启/终止流水线 |
| `PlacementGovernance`（placement.py） | 层/命名空间一致性 + 结构化 grain 声明，operator 审批后才可写受控 harness 目标 |
| `CdxrPromotionGate`（cdxr_gate.py） | DWS→ADS/Feature Store 晋升门，BLOCK/INSUFFICIENT 需 ACCEPT_WITH_WAIVER + comment |
| `Remediation`（approval.py） | 建议需 OPERATOR_CLI 审批（`APPROVE_REMEDIATION`），永不自动执行 |
| 审批 CLI（cli.py） | 独立审批路径，Agent 无审批写权 |

pi 侧唯一的治理入口是 `governance_dashboard` 工具（`src/governance/tool.ts`，`round2.pipeline_status_dashboard` 门控）——**只读状态面板**（details + renderResult UI 通道），不是 agent。治理控制面（`round2.pipeline_governance` 及其 17 个子 feature）在当前 default profile 下同样生效，只是不体现为 pi 工具注册。

### Pipeline Governance Agent —— 第 6 个 agent 机制

除上述 5 个 pi 子 agent 外，系统还有一个 **Pipeline Governance Agent**（`round2.pipeline_agent_worker`，`pipelines/governance/agent_worker.py` 的 `AgentWorker`）。它不是 pi 子 agent，但确实是 agent：

| 维度 | pi 子 agent（5 个） | Pipeline Governance Agent |
|------|--------------------|---------------------------|
| 注册方式 | `pi.registerTool()`，出现在 pi 工具列表 | 无工具注册，纯 Python 类 |
| 触发方式 | 用户/主 agent 调用工具 | **事件驱动**：仅异常/阶段完成/审批事件（白名单），不驻留、不轮询 |
| 输入 | 用户参数 | PipelineContextPackage（快照 + ≤50 条事件引用） |
| 输出 | 工具结果 | 结构化 JSON（findings / remediation proposal），1 次 repair，不转发原文 |
| LLM | pi 内置 | `caller` 参数注入，**当前无生产接线**（默认 stub 返回失败；仅测试/E2E 用 fake caller） |

**准确现状：系统有 6 个 agent 机制 = 5 个 pi 子 agent（全生效）+ 1 个 Pipeline Governance Agent（骨架与安全边界完成，LLM 大脑未接线）**。`governance_dashboard` 只是只读状态面板，不算 agent。AgentWorker 的调用方当前无生产实现——这是设计好的注入点，不是遗漏。

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

外部 review（提交 `2b88b4720b835d1d793242d7d190f10905f7cf73`）6 项发现全部核实并修复：

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

## Round-5：CDXR 重构为按需训练数据适用性检查（2026-08-01）

CDXR 从"数仓常驻治理流程"重构为"按需训练数据适用性检查工具"：

### 架构

- 独立引擎 `services/cdxr-engine/cdxr/`：`contracts.py`（协议/状态聚合）、`ports.py`（抽象 `TrainingDatasetPort`）、`engine.py`（编排 + TRACEABILITY）、`rules/{leakage,temporal,sensitive,quality,sampling}.py`（10 条规则）、`config.py`（显式阈值）
- **核心零依赖**：不 import FastAPI / Gateway API / DatasetRegistry / PyIceberg / governance store/reader，只依赖 `TrainingDatasetPort`（get_schema/get_profile/get_time_profile/get_value_distribution/get_sensitive_classification/get_field_roles/get_lineage）
- 网关侧 `app/integrations/cdxr_lakehouse_adapter.py`：只读 Catalog、可指定 snapshot、max_scan_rows（metadata 预估算）与 max_execution_ms 限制、敏感字段分布返回 None、无原始行
- `POST /v1/cdxr/training-assessments`：仅按需；启动/普通查询不触发；不写 governance_*；pydantic `extra="forbid"` 拒绝 SQL/任意表达式；审计只记元数据
- 状态确定性汇总：CRITICAL/泄漏 → BLOCK > 信息缺失/规则失败 → INSUFFICIENT_EVIDENCE > HIGH → REVIEW > ALLOW；规则异常绝不判 ALLOW
- TS：`assessTrainingData()` + 类型；`assess_training_data` 工具仅 `ENABLE_CDXR_TRAINING_TOOL=true` 注册（默认关）；旧 5 个 governance 工具移出默认注册（代码/API/表保留为 LEGACY）

### 新增测试

- 引擎（services/cdxr-engine）：35（含 13 项要求场景：ALLOW/BLOCK/REVIEW/INSUFFICIENT_EVIDENCE、无原始行、历史 snapshot、规则失败、状态优先级）
- 网关 API（test_cdxr_training.py）：11（含 404/400/422 输入校验、execute_query 不触发 CDXR、评估不写 governance、审计无原始值）
- TypeScript：+8（cdxr-training.test.mts 6 + flag-on 2）→ **33/33**；governance.test.mts / data-tools.test.mts 断言更新为"legacy 工具不注册、默认 7 个湖仓工具"

### 最终验证

| 项目 | 结果 |
|------|------|
| Python 测试（gateway pytest） | 126/126 |
| Python 测试（cdxr-engine pytest） | 35/35 |
| TypeScript 测试（node --test） | 33/33 |
| tsgo（PoC 范围） | 0 错误（既有 41 个 experiments 错误未处理） |
| e2e-lakehouse | OK |
| e2e-governance（legacy 平面） | OK（findings 保持 OPEN） |
| e2e-cdxr-training（3 场景） | OK |
| verify-seed | OK |

## Round-6：统一 Feature Flag 与 Ablation Framework（2026-08-01）

### 目标

- 编译期（build profile）+ 运行期（runtime config）两级开关；单一 registry 为唯一事实来源（35 个 feature：round1×11、round2×7、round3×10、legacy×2、ablate×5）
- TS 与 Python 双端同构：同一配置产出同一 `effectiveFeatureHash`（默认 `587beea2c6bb93db`，实测双端一致）
- 禁用即消失：关闭的 tool 不注册、API 返回 404 FEATURE_DISABLED、CLI 退出码 2——绝无"已注册但返回未配置"的桩
- 不安全 ablation 双闸：`BUILD_UNSAFE_EVALUATION_ABLATIONS=true`（构建）+ `EVALUATION_MODE=true` + `APP_ENV != production`（运行）；production 遇到 unsafe 配置直接拒绝启动

### 结构

- 事实来源：`config/features/registry.json`（id/round/parent/dependencies/buildDefault/runtimeDefault/safetyClass/env 名）
- 构建产物：`scripts/generate-feature-manifest.mts` → `src/generated/build-features.ts` + `app/generated/build_features.py` + `build/feature-manifest.json`；`FEATURE_BUILD_PROFILE` ∈ {full, baseline, multimodal-only, lakehouse-only, evaluation-full}
- 运行期解析：TS `src/features/resolver.ts` / Python `app/features.py`，优先级 env > 配置文件 > runtime profile > registry 默认；env 只在这两处读取（另有生成器）
- 快照：`scripts/print-effective-features.mts` / `python -m app.features --print`；`build/feature-snapshot.json`
- 实验配置：`experiments/configs/ablation/*.json`（experimentId + features map + runtimeProfile）
- 规则级门控：引擎 `RULE_FEATURE_MAP`（round3.cdxr_* → 规则 id），禁用规则不执行、出现在 `disabledRules`、绝不判 PASS；**有关闭规则的评估不可能得到 ALLOW**（降级为 INSUFFICIENT_EVIDENCE）
- 证据门控：`round2.query_evidence` 关闭则查询结果不生成 EvidenceFacts；lineage/data_quality 关闭则从 facts/summary 剥离
- 编排 ablation：quality_gate 关→attempt1 直通；l1_retry 关→无第二次尝试；best_attempt_selection 关→保留最后一次；l2_expert 关→专家永不启动（升级仍记录）；evidence_merger 关→直接投影 packet

### 默认策略

- round1 全部 ON（保持原行为）；round2/round3/legacy 运行期默认 OFF（`ENABLE_LAKEHOUSE=true` 等显式开启）；unsafe 默认不构建
- 旧 env 别名保留并集中解析：`ENABLE_CDXR_TRAINING_TOOL` → round3.cdxr_training；`ENABLE_LEGACY_CDXR_GOVERNANCE` → 两个 legacy feature

### 新增测试

- TypeScript：tests/features.test.mts 26 项（框架核心、env 优先级、TS↔Python 哈希一致性、round1/2/3 接线、orchestrator ablation、安全双闸）→ 总计 **59/59**
- Python：test_features.py 12 项（解析器一致性、规则门控 API 行为、禁用 API 404）+ 引擎 1 项（禁用规则绝不 ALLOW）→ gateway **138/138**、engine **36/36**
- E2E：experiments/e2e-feature-profiles.mts 7 场景（24-30：baseline / multimodal-only / lakehouse-only / full-safe / no-l2-expert / no-lineage / no-cdxr-temporal）

### 最终验证

| 项目 | 结果 |
|------|------|
| Python 测试（gateway pytest） | 138/138 |
| Python 测试（cdxr-engine pytest） | 36/36 |
| TypeScript 测试（node --test） | 59/59 |
| tsgo（PoC 范围） | 0 错误 |
| e2e-lakehouse | OK |
| e2e-governance（legacy 平面） | OK（findings 保持 OPEN） |
| e2e-cdxr-training（3 场景） | OK |
| verify-seed | OK |
| e2e-feature-profiles（7 场景） | OK |

## Round-7：业务模糊需求理解与任务规划插件（Requirement Planning，2026-08-01，功能第四轮）

### 目标

- 把「一句话业务请求」转换为**可验证的业务需求卡片**与**确定性任务计划**：歧义检测（blocking/non-blocking）→ 澄清问答（≤3 问）→ 计划门控（DIRECT/LIGHTWEIGHT/FORMAL）→ 任务计划 + 硬校验 → 执行波次 → 有界重规划
- 核心纯确定性（零业务工具依赖、零网络、零 Python）；Pi 工具名只出现在 `adapters/pi-capabilities.ts`
- 不可妥协约束：不执行、不写数据、不静默补全（默认假设 `visibleToUser=true`）、能力缺失拒绝伪造（`CANNOT_PLAN`）、禁止任意代码输入（`FORBIDDEN_INPUT_PATTERNS`）

### 结构

- 核心：`src/requirement-planning/`（contracts / ambiguity / assumptions / requirement-analyzer / plan-gate / task-plan-builder / plan-validator / scheduler / replanner / advisor / capability-registry / domain-packs / feature-bindings / index）
- 工具：`tool.ts`（prepare_business_task，TypeBox schema，只准备不执行）；Pi 原生 Skill 注册（`pi.on("resources_discover")` → skillPaths，`round4.requirement_skill`）
- Advisor：可选子代理（RpcClient，`round4.planning_advisor`），严格 JSON + 1 次修复，无 chain-of-thought
- 领域包：generic（系统默认）+ risk（贷款/逾期/AUC/KS/PSI）+ `domains/risk/requirements/` 演示需求样例
- 能力注册表：14 个抽象能力（image/document/lakehouse/data/training/agent），可用性来自 feature snapshot
- Feature flags：`round4.requirement_planning` 父 + 12 子开关（registry 35→48）；full/evaluation-full 构建，运行期默认关
- 消融：5 组（no-requirement-clarification / no-domain-pack / no-plan-gate / no-dynamic-replanning / no-parallel-scheduling）；硬校验（schema/循环/上限/能力/禁止代码条件）不可消融

### 新增测试

- TypeScript：tests/requirement-planning.test.mts 31 项（spec §19 1-27：歧义/门控/校验/调度/重规划/领域包）+ requirement-planning-features.test.mts 11 项（§19 28-36：advisor JSON、feature 接线、TS↔Python hash parity）→ 总计 **101/101**
- E2E：experiments/e2e-requirement-planning.mts 场景 A-G（19 项检查）
- 评测集：experiments/requirement-planning/cases.jsonl 20 案例（5 简单 / 5 模糊 / 5 跨源 / 3 缺能力 / 2 重规划）+ evaluate.mts → **20/20**

### 最终验证

| 项目 | 结果 |
|------|------|
| TypeScript 测试（node --test，全量） | 101/101 |
| e2e-requirement-planning（场景 A-G） | OK（19 检查） |
| requirement-planning 评测集 | 20/20 |
| TS/Python feature hash parity（round4 开） | 一致 |
| tsgo（PoC 范围） | 待全量验证 |

### 已知限制

- FORMAL 计划在 advisor 关闭时由 builder 确定性构造（无 LLM 候选任务），复杂跨源场景的路径选择偏保守
- REPLAN 新版本计划会重新包含未完成工作的等价任务（id 错开避免与已完成任务冲突），不增量 diff 任务内容
- 领域包目前仅 generic + risk；新增领域只需添加 domain-pack JSON

## Round-8：Data Analysis Subagent（2026-08-02，功能第四轮实际交付）

### 目标

- 复杂数据分析交给独立上下文子 Agent：生成 AnalysisPlan → 写 analysis.py → 受控执行（真实运行，禁止心算/猜测）
- 数字/表格/图表经 Pi 工具 UI renderer（details 通道）直接展示；主 Agent 只收状态摘要，数值不进模型上下文（硬边界，leakage=0）
- 简单聚合仍走 Query Gateway（任务门），不因新增子 Agent 绕开
- 第五轮独立审核 Agent 不在本轮；Result Artifact 预留 reviewStatus/validationRefs/reviewPackageRef/supersedesArtifactId

### 结构

- `src/data-analysis/`：contracts / task-gate / input-resolver / subagent(+prompt) / plan-validator / script-runner / result-validator / result-sanitizer / findings / artifact-store / workspace / feature-bindings / index / tool / ui/{renderer,formatter,contracts}
- `src/data-analysis/python/`：validate_script.py / validate_result.py / run_analysis.py
- 物化：`POST /v1/query/materialize`（validatedQueryId + parquet/arrow → artifact 元数据，无 rows）
- Workspace：`~/.pi/artifacts/data-analysis/<run-id>/{input,plan,code,output,logs}`
- Feature：`round4.data_analysis` 父 + 12 子（registry 48→61）；full/evaluation-full 构建，runtime 默认关；4 组消融（no-analysis-retry/charting/findings/task-gate）
- 前端通道：ToolDefinition.renderResult + details（`AgentToolResult.details` 为 UI-only，不进 provider payload）——审计见 docs/DATA_ANALYSIS_FRONTEND_CHANNEL_AUDIT.md

### 新增测试

- TS：data-analysis.test.mts 26 + ui 13 + context-isolation 3 + features 7 = **40**（全量 148+40=188？实为 148 含既有；新 40）
- Python：test_data_analysis_materialize.py 6 → gateway **144**、engine 36
- E2E：e2e-data-analysis.mts 场景 A-G（18 检查）
- 评测：experiments/data-analysis/cases.jsonl 15 案例 → **15/15**，`modelContextNumericLeakageRate=0/15`

### 最终验证

| 项目 | 结果 |
|------|------|
| TypeScript 全量 | 148/148 |
| gateway pytest | 144/144 |
| engine pytest | 36/36 |
| e2e-data-analysis（A-G） | OK（18 检查） |
| 评测集 | 15/15，leakage 0/15 |
| tsgo（PoC 范围） | 0 新错误（既有 3 个非本轮） |
| Feature Hygiene | 12/12 |

## Round-9：Lakehouse Batch/Streaming Pipeline（2026-08-02）

### 目标

- 批处理经真实 Batch Pipeline 写 Iceberg（源文件 → ODS → DWD → DWS → ADS），不是 seed.py 直接 append
- 流事件经真实流语义（event-time/watermark/去重/checkpoint/dead-letter）写 ODS，重复事件不产生重复事实
- 流批汇合（hybrid）：批基线 + 流追加 + 增量 fold；Gateway 保持只读
- 10 个已知场景（AUC 下降/缺失率上升/分布漂移/新鲜度异常/标签分布变化/流重复/迟到/乱序/分区缺失/重跑）ground truth 化

### 结构

- `pipelines/`：common（config/catalog/manifests/generators）、batch（stages/run_batch）、streaming（engine/run_streaming）、hybrid（run_hybrid）、tests（10）
- CLI：`python3 -m pipelines.run --mode batch|streaming|hybrid --profile small|medium|stress [--reset] [--replay]`
- 独立测试仓库 `.data/pipeline-test/`；写路径不注册 Agent 工具、不经 Gateway
- Feature：`round2.pipeline` 父 + 10 子（registry 61→72）；full/evaluation-full/lakehouse-only 编译，runtime 默认关
- Ground truth：`infra/lakehouse/pipeline-fixtures/expected-results.json`（10 场景 + small 行数/counters）

### 验证

- pytest pipelines/tests 10/10；E2E batch 10、streaming 11（含 checkpoint 恢复）、hybrid 7（含 Gateway 查询）
- verify-pipeline-data 13/13（对照 ground truth）
- 硬指标：duplicateFactRows=0、batchIdempotency=PASS、streamReplayIdempotency=PASS、groundTruthAccuracy=100%

### 环境限制

- 无 PyFlink：流处理为 deterministic local event replay（distributed=false, exactlyOnceVerified=false）；无 Spark/Flink Iceberg connector 验证（批处理用 pyiceberg 直写）
- 无 Kafka（JSONL replay）；checkpoint 为 local file；deliverySemantics=at-least-once-with-dedup

## Round-10：Pipeline Governance Phase 1（2026-08-02）

### 目标

- Schema 发现（确定性）→ SchemaSpec/PipelineSpec 设计（Agent 建议）→ 确定性校验 → 非可执行草案编译（executable=false）→ OPERATOR_CLI 人工审批 → 版本化 Amendment
- 关键决策人工批准；Agent 无执行/审批写权限；未批准不可编译/密封

### 结构

- 合同：`contracts/pipeline-governance/*.schema.json`（10 个，唯一事实来源，Python/TS 同源）
- 源码：`pipelines/governance/`（contracts/repository/discovery/validation/compiler/flow/cli/__main__）
- 运行数据：`.data/pipeline-governance/`（追加式不可变 Repository + ledger，不进入 Git）
- Feature：`round2.pipeline_governance` 父 + 6 子（registry 72→79）；仅注册 Phase 1 已实现，未预注册后续 Phase

### 验证

- 单元 18/18（合同/仓库不可变/candidate key 证据/校验/编译/审批绑定/Amendment/Agent 无审批权）
- E2E 17/17（发现→设计→校验→编译→CLI 审批→四哈希冻结→变更循环→篡改拒绝）
- 全量回归：TS 148、gateway 145、engine 36、pipelines 29、hygiene 全过、hash 一致 `9eada30c2ebb83ac`

### 非目标（Phase 1）

Spark/Flink 运行治理、Event Store/Watchdog、小文件/倾斜、PlacementPlan、CDXR Gate、自动部署/运行、状态栏、Cron。

## 日期

2026-08-02
