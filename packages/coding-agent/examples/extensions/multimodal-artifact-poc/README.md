# multimodal-artifact-poc v0.9.0

Pi 本地多模态扩展：图片 OCR（PaddleOCR）、视觉理解（PaddleOCR-VL）、文档解析（markitdown）、文档子代理分析（独立 RPC agent）、两级 Agent 编排（质量门）、**湖仓数据源（可选扩展）**、**业务需求理解与任务规划插件（可选扩展）**。

## 架构

```
用户输入 → 纯文本 LLM (Qwen3-8B, llama.cpp router)
          │ 自主决策调用工具
          ▼
   ┌──────────────┬──────────────┬─────────────────┬──────────────────┐
   ▼              ▼              ▼                 ▼
parse_image    parse_visual   parse_document   analyze_document
   │              │              │                 │
PaddleOCR     PaddleOCR-VL   markitdown      markitdown → 落盘缓存
 (OCR, 8s冷启)  (0.9B VL)      (文档→MD)       → 独立 RPC 子 agent
   │              │              │                 │  (独立上下文)
   └──────────────┴──────┬───────┴────────┬────────┘
                         ▼                 ▼
                 结构化 JSON       子 agent 摘要
                         └───────┬────────┘
                                 ▼
                    Qwen3-8B 基于结果回答
```

核心约束：**原始图片/文档从不进入文本模型上下文**，只有结构化 JSON 或摘要进入。

## 工具

| 工具 | 引擎 | 输入 | 输出 |
|------|------|------|------|
| `parse_image` | PaddleOCR 3.x | PNG/JPG/BMP/TIFF/WEBP | 文字块+坐标+置信度 |
| `parse_visual` | PaddleOCR-VL-1.6 | 图表/照片/复杂图 | facts / unverifiedClaims |
| `parse_document` | markitdown | PDF/DOCX/PPTX/XLSX/HTML/CSV/MD/TXT | Markdown 全文 |
| `analyze_document` | markitdown + 子 agent | 文档 + 问题 | 子 agent 摘要 |

降级命令：`/image`、`/visual`、`/document`（模型不自主调用时直接执行）。

## 视觉模型（PaddleOCR-VL）

- 892MB GGUF + 841MB mmproj，**llama.cpp router 原生加载**（无需 MLX-VLM）
- ⚠️ mmproj 必须放**子目录**且以 `.gguf` 结尾（llama.cpp `preset.cpp` 的扫描规则），否则不附加
- ⚠️ OCR 专用模型：只接受极简指令（`"Extract data."`），复杂指令输出垃圾
- 输出 `Label | Value` 确定性行（竖排/横排两种格式），TypeScript 解析为 facts
- 无法解析的行降级为 `unverifiedClaims`（明确标注不可当事实）

## 子 agent（analyze_document）

- 文档 → markitdown → **落盘 `~/.pi/artifacts/<hash>/`**（mtime 缓存，二次提问不重解析）
- spawn 独立 Pi RPC 进程（复用 Pi `RpcClient`）→ 独立上下文回答问题
- 只把摘要返回主 agent（主上下文 -89% token）
- 模型默认同主 agent（Qwen3-8B），可用 `SUBAGENT_MODEL_ID` 切换（将来换更强模型/API 零成本）
- 对比实验：见 `EXPERIMENT-subagent.md`

## 事实分级

```
facts            → 精确可读值（信任）
unverifiedClaims → 不确定内容（明确标注，不得当事实）
OCR textBlocks[].confidence → 每个文字块的置信度
```

## 湖仓数据源（可选扩展，v0.4.0）

数据层 = 云上湖仓（Iceberg ODS/DWD/DWS/ADS），从"多源信贷风控数据平台"剥离的**通用数据层**，以独立 **Query Gateway**（FastAPI，只读）向 Pi Agent 暴露。数据平台继续使用 Python/SQL/PySpark/PyFlink；Agent 侧只实现 TypeScript 客户端 + 工具 schema + Evidence 适配。

```
用户问题 → search_catalog → inspect_dataset → validate_query
        → execute_query(validatedQueryId) → get_data_quality
        → explain_lineage → EvidenceFact(kind="query") → 回答
```

- 工具：`search_catalog` / `inspect_dataset` / `validate_query` / `execute_query` / `get_data_quality` / `explain_lineage` / `get_snapshot`（**无 run_sql**；CDXR 训练检查工具 `assess_training_data` 需 `ENABLE_CDXR_TRAINING_TOOL=true` 开启）
- 启动：`cd services/lakehouse-gateway && LAKEHOUSE_MODE=local python3 -m uvicorn app.main:app --port 8001`
- Agent 连接：`LAKEHOUSE_GATEWAY_URL=http://localhost:8001`（未配置时多模态工具完全不受影响）
- 文档：`docs/LAKEHOUSE_EXTRACTION_AUDIT.md`（原平台审计）、`docs/LAKEHOUSE_ARCHITECTURE.md`（平台架构）、`docs/DATA_AGENT_INTEGRATION.md`（Agent 接入）

## CDXR 训练数据检查（v0.6.0，2026-08-01）

CDXR 定位为**按需训练数据适用性检查工具**（非常驻治理流程）：`POST /v1/cdxr/training-assessments` 对指定数据集/snapshot 运行确定性引擎（无 LLM），返回 ALLOW / REVIEW / BLOCK / INSUFFICIENT_EVIDENCE 判定与规则发现。引擎独立于网关（`services/cdxr-engine/`，仅依赖抽象 `TrainingDatasetPort`），不写任何 governance 表、不返回原始数据行、只在显式调用时运行（启动扫描和普通查询均不触发）。

```bash
# 按需评估（网关内 POST）
curl -s -X POST http://localhost:8001/v1/cdxr/training-assessments \
  -H 'content-type: application/json' -d '{
    "datasetId": "dws.dws_sales_daily",
    "targetField": "orders",
    "featureFields": ["revenue", "region"],
    "predictionTimeField": "event_date"
  }'
```

- 状态判定（确定性汇总）：CRITICAL/明确泄漏 → BLOCK；HIGH 需业务判断 → REVIEW；信息缺失/规则失败 → INSUFFICIENT_EVIDENCE；其余 → ALLOW。规则异常绝不判 ALLOW。
- 10 条规则：TARGET_IN_FEATURES / POST_OUTCOME_FEATURE / LABEL_DERIVED_FEATURE（仅显式角色元数据，禁止 LLM 猜名）/ SENSITIVE_FEATURE / TARGET_DISTRIBUTION / SAMPLE_SIZE / FEATURE_MISSINGNESS / CONSTANT_FEATURE / VALIDATION_LEAKAGE / TRACEABILITY（无 snapshot 引用不得 ALLOW）；阈值全部显式配置（`AssessmentConfig`）。
- Agent 工具：`assess_training_data`（仅 `ENABLE_CDXR_TRAINING_TOOL=true` 时注册，默认关闭；明确声明不用于普通查询、不训练模型、不写数据、不批量豁免、不返回原始数据）。
- 旧 CDXR 治理平面（`get_dataset_governance_profile` 等 5 个只读工具、17 张治理表、治理 CLI）**保留为 legacy**：代码/API/表全部保留、只读，但不再注册到 Agent 默认工具集（v0.6.0 起默认 7 个湖仓工具）。文档标注 `LEGACY`。
- ⚠️ 本工具检查训练数据**适用性**（泄漏/敏感/质量/可追溯），**不保证数据绝对正确**；任何 BLOCK/REVIEW 判定都需人工复核。
- 文档：`docs/CDXR_GOVERNANCE_ARCHITECTURE.md`（架构）、`docs/CDXR_DATA_MODEL.md`（数据模型，LEGACY）、`docs/CDXR_AGENT_INTEGRATION.md`（Agent 接入，含新工具说明）
- 测试：Python 126（`cd services/lakehouse-gateway && python3 -m pytest tests/ -q`）+ 引擎 35（`cd services/cdxr-engine && python3 -m pytest tests/ -q`）、TS 33（`node --experimental-strip-types --test "tests/*.test.mts"`）、E2E：`LAKEHOUSE_GATEWAY_URL=http://localhost:8791 node --experimental-strip-types experiments/e2e-cdxr-training.mts`

## Requirement Planning（计划能力，未启用，v0.8.0）

业务模糊需求理解与任务规划：`prepare_business_task` 工具把模糊请求转成**需求卡片 + 澄清问题 + 确定性任务计划 + 执行波次**。核心纯确定性（零业务工具依赖、不执行、不写数据、不静默补全），可选子代理 advisor（严格 JSON、一次修复）。同时以 Pi 原生 Skill 注入提示（`resources_discover`）。

> 说明：Requirement Planning 是**未启用的计划能力**，不属于本轮（功能第四轮）实际交付范围。第四轮实际交付为 **Data Analysis Subagent**（见下节）。`round4.requirement_*` 开关默认关闭，与 Data Analysis 互不依赖。

- 状态：`NEEDS_CLARIFICATION` / `READY_TO_PLAN` / `DIRECT_EXECUTION` / `PLAN_READY` / `CANNOT_PLAN`（能力缺失/输入含可执行代码/硬校验失败 → 拒绝，不伪造）。
- 能力注册表 14 项（image/document/lakehouse/data/training/agent）；领域包 generic/risk；默认限制 maxQuestions=3 / maxTasks=12 / maxReplans=1 / maxToolCalls=20 / maxSubagents=4。
- 开关：`round4.requirement_*`（父 + 12 子），运行期默认关。
- 文档：`docs/REQUIREMENT_PLANNING_ARCHITECTURE.md`、`docs/REQUIREMENT_PLANNING_CONTRACTS.md`、`docs/REQUIREMENT_PLANNING_PLUGIN.md`

## Data Analysis Subagent（v0.9.0，2026-08-02，功能第四轮实际交付）

复杂数据分析由**独立上下文的子 Agent** 完成：子 Agent 生成 AnalysisPlan → 写 `analysis.py` → 受控 Script Runner 真实执行（`python3 <workspace>/analysis.py`）→ 数字/表格/图表经 Pi 工具 UI renderer（details 通道）**直接展示在前端**；主 Agent 只收到状态摘要，**不读取/不复述数值**。

```
复杂请求 → run_data_analysis
  → 输入校验（拒绝 SQL/代码/路径/凭证）→ 可信 Artifact 解析
  → task gate：简单聚合 → QUERY_GATEWAY（execute_query）
               复杂分析 → 子 Agent（隔离上下文）
                 → AnalysisPlan 校验 → 写脚本 → 受控执行(≤2次) → Result Artifact
                 → UI renderer 直接展示（details 通道）
                 → 主 Agent 只收 AnalysisAgentSummary（无数值）
```

- 物化：`POST /v1/query/materialize`（只收 validatedQueryId，返回 parquet/arrow artifact 元数据，无 rows）。
- 硬边界：数值不进主 Agent 上下文（`modelContextNumericLeakageRate = 0`）；`analysis_frontend_render=false` 时工具不注册，不降级为模型复述；`reviewStatus` 恒为 `NOT_REVIEWED`（第五轮审核 Agent 消费不可变 Artifact/Manifest）。
- 开关：`round4.data_analysis` 父 + 12 子（task_gate/materialization/subagent/plan_generation/workspace/script_execution/retry/artifacts/findings/charting/frontend_render/data_analysis_tool），运行期默认关，full/evaluation-full 构建。
- 测试：TS 40（26+13+3+7... 见下）、Python materialize 6、E2E 场景 A-G（18 检查）、评测 15 案例。
- 文档：`docs/DATA_ANALYSIS_SUBAGENT_ARCHITECTURE.md`、`docs/DATA_ANALYSIS_CONTRACTS.md`、`docs/DATA_ANALYSIS_FRONTEND_RESULT_CHANNEL.md`、`docs/DATA_ANALYSIS_SANDBOX.md`、`docs/DATA_ANALYSIS_FRONTEND_CHANNEL_AUDIT.md`

## Lakehouse Batch/Streaming Pipeline（v0.10.0，2026-08-02）

本地可复现的批处理与流处理 Pipeline（`pipelines/`），为湖仓补充可验证的测试数据——**不是 seed.py 的直接装载**：

- **Batch**：历史源文件（不可变 parquet，含 content hash）→ ODS → DWD → DWS → ADS，清洗/去重/时间标准化/幂等重跑/每层新 snapshot（`python3 -m pipelines.run --mode batch`）
- **Streaming**：JSONL 事件 replay（deterministic local event replay：application-level event-time/watermark、event_id 去重、local file checkpoint、dead-letter、微批提交），重复事件不产生重复事实（distributed=false）（`--mode streaming`）
- **Hybrid**：批基线 + 流追加 + 增量 fold，Gateway 只读查询验证（`--mode hybrid`）
- 独立测试仓库 `.data/pipeline-test/`（不碰 `.data/warehouse`）；写路径仅 CLI/E2E 显式触发，不注册 Agent 工具
- 10 个已知场景 ground truth：`infra/lakehouse/pipeline-fixtures/expected-results.json`
- 测试：pytest 10、E2E batch 10 / streaming 11 / hybrid 7、verify-pipeline-data 13
- 开关：`round2.pipeline` 父 + 10 子（`ENABLE_LAKEHOUSE_PIPELINE` / `ENABLE_BATCH_PIPELINE` / `ENABLE_STREAM_REPLAY_PIPELINE`），运行期默认关
- 文档：`docs/LAKEHOUSE_BATCH_PIPELINE.md`、`docs/LAKEHOUSE_STREAMING_PIPELINE.md`、`docs/LAKEHOUSE_HYBRID_PIPELINE.md`、`docs/LAKEHOUSE_PIPELINE_LOCAL_RUNBOOK.md`、`docs/LAKEHOUSE_PIPELINE_AUDIT.md`

## Feature Flag & Ablation Framework（v0.7.0，2026-08-01）
全部能力（round1 多模态 / round2 湖仓 / round3 CDXR / round4 Requirement Planning + Data Analysis / legacy / 实验性 ablation）由统一开关框架控制：编译期（build profile）+ 运行期（runtime）两级，单一 registry 为唯一事实来源，TS/Python 双端同构（同一配置产出同一 `effectiveFeatureHash`）。**默认策略：round1 全开（保持原行为）；round2/round3/round4/legacy 运行期默认关**，需显式 env（`ENABLE_LAKEHOUSE=true`、`ENABLE_CDXR_TRAINING=true`、`ENABLE_REQUIREMENT_PLANNING=true`、`ENABLE_DATA_ANALYSIS=true`、`ENABLE_LEGACY_CDXR_GOVERNANCE_TOOLS=true` 等）；`ENABLE_CDXR_TRAINING_TOOL` 作为兼容别名继续有效。

- 禁用语义：关闭的 tool **不注册**（Agent 清单里不存在，而非"返回未配置"）；关闭的 API 返回 404 FEATURE_DISABLED；关闭的引擎规则不执行、出现在 `disabledRules`、绝不判 PASS，**有关闭规则的评估不可能得到 ALLOW**（降级 INSUFFICIENT_EVIDENCE）。
- 构建档案：`FEATURE_BUILD_PROFILE` ∈ {full（默认）, baseline, multimodal-only, lakehouse-only, evaluation-full}；生成器 `scripts/generate-feature-manifest.mts`。
- 实验：`experiments/configs/ablation/*.json`（experimentId + features map）；运行结果附 Feature Snapshot（`scripts/print-effective-features.mts` / `python -m app.features --print`）。
- 不安全 ablation（`ablate.*`）双闸：`BUILD_UNSAFE_EVALUATION_ABLATIONS=true` + `EVALUATION_MODE=true` + `APP_ENV != production`，默认不构建。
- 文档：`docs/FEATURE_FLAGS.md`（完整规范：结构/命令/默认策略/新增 feature 的十条规则/CI 守则）

## 模型目录（~9.7GB）

```
~/models/
├── Qwen3-8B-Q4_K_M.gguf            # 4.7GB 文本主模型
└── PaddleOCR-VL-1.6/
    ├── PaddleOCR-VL-1.6.gguf       # 892MB 视觉模型
    └── PaddleOCR-VL-1.6-mmproj.gguf  # 841MB 视觉投影
```

## 独立测试

```bash
# OCR
echo '{"path":"fixtures/chinese_text.png","mode":"ocr"}' | python3 src/parser_server.py

# 视觉（需 llama-server 加载 PaddleOCR-VL）
npx tsx experiments/benchmark-subagent.mts  # 子 agent 对比实验复现

# 端到端（Pi）
LLAMA_BASE_URL=http://127.0.0.1:8080 pi \
  -e packages/coding-agent/examples/extensions/multimodal-artifact-poc \
  --provider llama.cpp --model Qwen3-8B-Q4_K_M \
  "请用 analyze_document 分析 report.pdf 并总结"
```

## 文档

- `EXPERIMENT-subagent.md` — 子 agent vs 直返对比实验（指标/数据/结论）
- `MULTIAGENT-SUMMARY.md` — 多 Agent 多模态第一轮综合总结
- `../../../../../POC_STATUS.md` — PoC 总状态、关键修复记录（max_tokens=1 bug 等）
- `docs/LAKEHOUSE_EXTRACTION_AUDIT.md` — 原数据平台审计（技术栈/通用 vs 风控模块/迁移顺序）
- `docs/LAKEHOUSE_ARCHITECTURE.md` — 湖仓平台架构（分层边界/查询协议/配置）
- `docs/DATA_AGENT_INTEGRATION.md` — Pi Agent 数据工具接入 + Evidence 扩展 + PoC 演示
- `docs/FEATURE_FLAGS.md` — Feature Flag & Ablation 框架完整规范
- `docs/REQUIREMENT_PLANNING_ARCHITECTURE.md` — Requirement Planning 架构（歧义/门控/调度/校验）
- `docs/DATA_ANALYSIS_SUBAGENT_ARCHITECTURE.md` — Data Analysis Subagent 架构（任务门/子 Agent/受控执行/前端直达）
- `docs/DATA_ANALYSIS_CONTRACTS.md` — run_data_analysis 输入/输出协议
- `docs/DATA_ANALYSIS_FRONTEND_RESULT_CHANNEL.md` — 前端直达结果通道（details renderer）
- `docs/DATA_ANALYSIS_SANDBOX.md` — 受控执行沙箱强度与限制
- `docs/DATA_ANALYSIS_FRONTEND_CHANNEL_AUDIT.md` — Pi 前端结果通道审计
- `docs/REQUIREMENT_PLANNING_CONTRACTS.md` — prepare_business_task 输入/输出协议
- `docs/REQUIREMENT_PLANNING_PLUGIN.md` — 插件启用与使用指南
- `CONTRIBUTING.md` — 开发守则（feature 注册/双端同步/测试要求）

## 限制

- PP-StructureV3 在 Mac CPU 上不可行（34 分钟/张），表格无自动结构化
- 长文档（>8K tokens）超 llama.cpp 运行时上下文，未测
- 复杂图表数值无交叉验证（unverifiedClaims 兜底）
