# Lakehouse Extraction Audit — 原数据平台审计

日期：2026-08-01
用途：data-agent 第二轮改造的前置审计——定位原"多源信贷风控数据平台"，划分通用云上湖仓层与风控领域层，为剥离迁移提供依据。

## 1. 原项目定位

| 项 | 值 |
|----|-----|
| 绝对路径 | `/Users/zhanhuilin/Documents/风控大数据/LeakBench-RiskCloud` |
| Git remote | `https://github.com/lzzzhh/LeakBench-RiskCloud.git` |
| 当前分支 | `main` |
| 最新 commit | `e386f920e352997282cdbf1fcfe5573a07b42b6a` |
| 工作区状态 | 干净（无未提交修改） |
| README 名称 | RiskCloud — Batch-stream unified credit risk data platform |
| 规模 | 19,923 行 Python；另有 Streamlit dashboard、Docker Compose 基础设施、真实 Iceberg warehouse 数据 |

候选排除：`/Users/zhanhuilin/Documents/风控大数据/LeakBench-Tab` 为学术 benchmark（特征污染基准）项目，仅含 riskcloud 相关文档子目录，且工作区有未提交修改——不匹配"数据平台"定位。

## 2. 实际技术栈（从代码确认，非 README 推断）

| 组件 | 证据 | 状态 |
|------|------|------|
| Spark 3.5.3 | `requirements.txt` `pyspark==3.5.3`；`storage.py::spark_configs()`（Iceberg SparkCatalog）；`scripts/run_resume_demo.py`；`tests/platform/home_credit/test_{bronze,silver}_iceberg_integration.py` | 已使用，CI 通过 |
| Iceberg | `data/warehouse/` 下真实 Iceberg 元数据（`*.metadata.json` + `*.avro` snapshot + parquet data），四层 | 已使用 |
| Iceberg catalog | **Hadoop catalog（file:// + s3://）**：`StorageProfile` 的 `catalog_backend: hadoop/glue`；本地 = hadoop + file://；S3 = hadoop + S3FileIO（`spark_configs()` 用 `org.apache.iceberg.aws.s3.S3FileIO`）；Glue 枚举存在但 README 标注"Glue Catalog ⏸️ Deferred"——代码支持未部署 | 已使用（hadoop）；glue 未部署 |
| Flink 1.19.1 | `deploy/local/docker-compose.realtime.yml`（flink-jobmanager/taskmanager）；`case_studies/home_credit/streaming/flink/jobs/{streaming_bronze_silver,streaming_features,feature_state_machine}.py`（PyFlink） | 已使用（本地 compose） |
| Kafka 3.9.1 | `deploy/local/docker-compose.realtime.yml`（apache/kafka:3.9.1 + `init-topics.sh`）；`streaming/producer/replay.py`；`tests/streaming/test_event_producer.py` | 已使用 |
| Redis | `case_studies/home_credit/api/redis_client.py`（feature serving、事件时间原子更新、Lua）；`feature_sync.py`（Iceberg → Redis 同步）；README"FeatureUpdate V2 → Redis" | 已使用 |
| FastAPI | 两处真实服务：`case_studies/home_credit/api/feature_api.py`（特征/预测 API，含路由）；`riskcloud/agents/api/app.py`（Agent control plane，含 `/health`、`/agent/runs`）。`riskcloud/serving/cloud_api.py` 仅 dataclass + 端点字典，无实现 | 已使用（两处） |
| Streamlit | `dashboard/app.py`（9 页风控监控） | 已使用 |
| PaddleOCR / OCR | `riskcloud/multimodal/ocr.py`（**Amazon Textract** 管线定义，Phase 5 deferred）+ `pdf_parser.py`（MarkItDown，Phase 4 deferred）——与 data-agent 现有 PaddleOCR 方案是两套 | 未部署 |
| Python 版本 | requires-python >=3.10；`.pyc` 显示 cpython-313 实际运行 | — |

## 3. 模块树（摘要）

```
LeakBench-RiskCloud/
├── riskcloud/                     # 正式库包（5,712 行）
│   ├── adapters/                  # 数据集适配器
│   │   ├── base.py                #   Adapter 抽象基类（dataset_id/版本/闭包校验）
│   │   └── home_credit/           #   ★风控：借贷领域适配（字段映射/boundary/特征目录）
│   ├── agents/                    # ★原项目自己的 Python 多 Agent 系统（Agentic MoE）
│   │   ├── api/app.py             #   FastAPI control plane
│   │   ├── contracts/models.py    #   契约模型（含通用数据画像模型 Dataset/Table/ColumnProfileV1）
│   │   ├── orchestrator/router/supervisor/experts/llm/governance_agent
│   ├── contracts/                 # 共识契约
│   │   ├── validation.py          #   通用校验框架（coerce_*/freeze/thaw/FieldError）
│   │   ├── event.py               #   通用事件契约（event_id 身份/深不可变）
│   │   ├── document.py            #   文档解析契约（★含 is_credit_model_eligible 风控语义）
│   │   ├── feature_catalog.py     #   ★特征目录契约（风险评级）
│   │   └── prediction_point.py    #   ★预测点契约（ML 拆分语义）
│   ├── governance/cdxr/           # ★LeakBench 学术核心：标签泄漏治理引擎（确定性，无 LLM）
│   ├── infra/storage.py           # 通用存储抽象（local/s3 + hadoop/glue + Spark/Flink 配置）
│   ├── ingestion/                 # 空占位
│   ├── multimodal/                # Textract OCR + MarkItDown PDF 管线定义（deferred）
│   ├── profiling/schema_profiler.py  # 通用确定性数据画像（缺失率/唯一率/类型/掩码）
│   ├── serving/                   # ★cloud_api（风险预测/AUC/KS）+ model_training（AUC/KS/Lift/F1/Brier/PSI）
│   └── (flink/ kafka/ lakehouse/ feature_store/ orchestration/ observability/ = 空目录占位)
├── case_studies/home_credit/      # ★风控案例：Home Credit 借贷
│   ├── api/                       #   FastAPI 特征服务 + Redis 客户端 + feature_sync
│   ├── configs/                   #   bronze/silver/features/prediction_points/boundary YAML
│   ├── manifests/                 #   data_manifest.yaml + snapshot_manifest.template.yaml
│   ├── platform/feature_sync.py   #   Iceberg → Redis 同步
│   └── streaming/                 #   Kafka producer + Flink 作业（bronze/silver/features/state machine）
├── dashboard/                     # ★Streamlit 9 页风控监控
├── deploy/                        # Docker Compose（local/cloud）、flink 提交脚本、kafka init、.env.example
├── scripts/                       # run_resume_demo.py（Spark 全链路 demo）、quick-demo.sh
├── docs/                          # 架构/RUNBOOK/ADR/路线图
├── tests/                         # platform（home_credit 为主）+ streaming + agents + dashboard
├── data/warehouse/                # 真实 Iceberg 数据：ods/ocr_result、ods/pdf_parse_result、
│                                  #   ods/streaming_events、dwd/loan_application_detail、
│                                  #   dws/feature_values、dws/prediction_points、ads/model_metrics
└── case_studies/artifacts/        # 模型产物（LightGBM/LR pkl、model card、CDXR 报告）
```

★ = 明显绑定信贷风控/学术治理领域。

## 4. 审计点确认（13 项）

| # | 审计点 | 结论 | 证据 |
|---|--------|------|------|
| 1 | S3/本地对象存储封装 | ✅ 存在且通用 | `riskcloud/infra/storage.py::StorageProfile`（local_dev/cloud/from_env，file:// 与 s3:// 双后端） |
| 2 | Apache Iceberg 使用方式 | ✅ Spark/Flink 双路径写入，warehouse 有真实元数据 | `spark_configs()`、`flink_sql_catalog_ddl()`、`data/warehouse/*/metadata/` |
| 3 | Iceberg catalog 类型 | ✅ Hadoop（local 与 S3 均用）；Glue 枚举存在未部署 | `CatalogBackend.HADOOP/GLUE`；README "Glue Catalog ⏸️ Deferred" |
| 4 | Spark 读写封装 | ✅ | `spark_configs()`、`run_resume_demo.py`、bronze/silver 集成测试 |
| 5 | Flink/Kafka 管线 | ✅ | `case_studies/home_credit/streaming/`（PyFlink jobs + Kafka producer + EventEnvelope），compose 部署 |
| 6 | Redis 使用方式 | ✅ 通用读取封装可抽取 | `api/redis_client.py`（host/port/db/password 环境变量化，key 前缀 `riskcloud:features`） |
| 7 | FastAPI 路由 | ✅ 两处真实实现 + 一处定义 | `feature_api.py`、`agents/api/app.py`（均含真实路由）；`serving/cloud_api.py` 仅定义 |
| 8 | 数据目录/元数据 | ✅ | `data/warehouse/` 四层 + `configs/*.yaml` + `manifests/*.yaml` |
| 9 | 数据质量 | ✅ 有画像无独立质量服务 | `profiling/schema_profiler.py`（确定性画像：缺失率/唯一率/逻辑类型/掩码/候选键）+ `contracts/validation.py` 严格校验 |
| 10 | 数据血缘 | ⚠️ 无独立 lineage 模块/API | 仅通过契约字段间接体现（`source_record_id`、`linkage_evidence_uri`、feature_catalog lineage 字段）；无血缘图谱或查询接口 |
| 11 | 配置系统 | ✅ | 环境变量（`RISKCLOUD_*`）+ YAML configs + `StorageProfile.from_env()` + `deploy/cloud/.env.example` |
| 12 | ODS/DWD/DWS/ADS 分层 | ✅ 真实存在 | `data/warehouse/{ods,dwd,dws,ads}/` 各有 Iceberg 表元数据 |
| 13 | 风控绑定代码 | ✅ 明确 | `adapters/home_credit/`（借贷实体/字段映射）、`governance/cdxr/`（标签泄漏）、`serving/`（AUC/KS/风险概率）、`dashboard/`（风控监控）、`agents/`（治理 Agent）、`contracts/{feature_catalog,prediction_point,document}` |

## 5. 通用模块 vs 风控专用模块

### A. 通用云上湖仓层（可剥离）

| 模块 | 原文件 | 说明 | 动作 |
|------|--------|------|------|
| 存储抽象 | `riskcloud/infra/storage.py` | local/s3 双后端、hadoop/glue catalog、Spark/Flink 配置生成 | **直接复用**（仅默认仓库名无害） |
| 契约校验框架 | `riskcloud/contracts/validation.py` | coerce_*/freeze/thaw/FieldError/结构化错误 | **直接复用** |
| 事件契约 | `riskcloud/contracts/event.py` | EventEnvelope 身份/不可变/碰撞证明 | **直接复用** |
| 数据画像 | `riskcloud/profiling/schema_profiler.py` | 确定性 profile（缺失率/唯一率/类型/掩码/候选键） | **直接复用**（依赖 profile 模型需提取） |
| 画像模型 | `riskcloud/agents/contracts/models.py` 中 Dataset/Table/ColumnProfileV1 | 通用 profile 结构 | **提取复用**（与 agent 状态机模型同文件，剥离） |
| 数据集适配模式 | `riskcloud/adapters/base.py` | dataset_id/display_name/版本 + 闭包校验模式 | **重构复用**：剥离 prediction boundary/feature catalog 语义 → dataset registry 模式 |
| Redis 读取封装 | `case_studies/home_credit/api/redis_client.py` | 通用读取（前缀可配置化） | **重构复用**（key 前缀参数化） |
| 流式架构参考 | `case_studies/home_credit/streaming/flink/jobs/streaming_bronze_silver.py` | Kafka→Flink→Iceberg bronze/silver 通用架构 | **参考不迁移**（本轮不做流式 Gateway） |
| 配置系统 | `deploy/cloud/.env.example` + YAML configs | 环境变量模式 | 借鉴，重命名 `LAKEHOUSE_*` |

### B. 风控领域包（不进入通用层）

| 模块 | 原文件 | 说明 |
|------|--------|------|
| Home Credit 适配器 | `riskcloud/adapters/home_credit/` | 借贷业务实体、字段映射、特征目录 |
| CDXR 治理 | `riskcloud/governance/cdxr/` | 标签泄漏治理（LeakBench 学术核心，确定性引擎） |
| 预测服务 | `riskcloud/serving/cloud_api.py`、`model_training.py` | risk_probability/AUC/KS/Lift/F1/Brier/PSI |
| Python Agent 系统 | `riskcloud/agents/` | 原项目自己的 supervisor/orchestrator/router/experts/llm/governance_agent |
| Dashboard | `dashboard/app.py` | 9 页风控监控 Streamlit |
| 特征/预测点契约 | `riskcloud/contracts/{feature_catalog,prediction_point,document}` | 风险评级/预测点/信贷资格语义 |
| Home Credit 案例 | `case_studies/home_credit/`（含 streaming 特征作业） | 借贷领域实现 |
| 文档资格判定 | `document.py::is_credit_model_eligible` | 信贷模型资格 |

## 6. 可直接复用 / 需重构 / 不应迁移

- **直接复用**：`infra/storage.py`、`contracts/validation.py`、`contracts/event.py`、`profiling/schema_profiler.py`（profile 模型一并）
- **需重构**：`adapters/base.py`（→ dataset registry）、`agents/contracts/models.py` 中 profile 模型（→ 独立 models）、`api/redis_client.py`（→ 前缀参数化）、config 命名（RISKCLOUD_* → LAKEHOUSE_*）
- **不应迁移**：B 节全部（风控领域包），以及 `serving/cloud_api.py` 的端点字典（风控指标）——但"API_ENDPOINTS + dataclass 模型"的轻量 API 定义模式可借鉴
- **参考不迁移**：Flink 作业（PyFlink 架构正确，但本轮 Gateway 是查询服务，流式作业保持原项目运行）

## 7. 风险与依赖

1. **无独立 lineage 模块** → 需在 Gateway 中新建轻量 lineage 抽象（以契约字段 + snapshot 元数据为基础）
2. **无通用查询服务**：现有 FastAPI 均为风控特征服务/Agent control plane → Gateway 为新建件，复用 StorageProfile + profile 能力
3. **重依赖**：pyspark==3.5.3（>600MB）→ Gateway 最小化：fastapi/uvicorn/pydantic + pyarrow（只读 parquet/snapshot 扫描，不引 Spark）；本地模式数据即 `data/warehouse/` 的 Iceberg 表（ods 层有真实数据可用作首个 PoC）
4. **pyproject 包名/依赖**：`riskcloud` 包命名与风控绑定 → 新服务独立 `pyproject.toml`（`lakehouse-gateway`）
5. **warehouse 数据为本地已有**（非 git 跟踪内容属于运行产物）：迁移不复制 `data/warehouse`，本地模式指向原路径或新建测试数据集
6. **许可证**：用户自有仓库（无 license 文件），复制无阻碍
7. **"s3:/" 目录**：误操作产生的本地目录，非 git 内容，忽略
8. **兼容红线**：不重写 Spark/Flink 为 TS；生产资源零改动；原项目代码零删除

## 8. 建议迁移顺序

1. 存储抽象 + 契约校验 + 事件契约（纯通用，零重构）——阶段 1 地基
2. profile 模型提取 + schema_profiler（数据质量内核）——质量能力
3. dataset registry（adapters/base.py 模式通用化）——目录能力
4. query 抽象 + 本地执行器（pyarrow 扫描 local warehouse）——查询能力
5. FastAPI Gateway 装配（health/catalog/dataset/validate/execute/quality/lineage/snapshots）——阶段 3
6. lineage 轻量实现（基于 snapshot 元数据 + 契约字段）
7. TS 侧 data-tools（client/schemas/evidence-adapter/工具）——阶段 4
8. 测试 + e2e + 文档——收尾
