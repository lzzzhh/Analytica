# Lakehouse Architecture — 云上湖仓平台（通用数据层）

日期：2026-08-01
分支：`feature/cloud-lakehouse-datasource`

## 1. 定位

从原"多源信贷风控数据平台"（LeakBench-RiskCloud）剥离出的**通用云上湖仓数据层**，作为 data-agent 的数据底座：

- **数据层 = Python/SQL/PySpark/PyFlink**（不重写成 TypeScript）
- **Agent 层 = TypeScript 客户端 + 工具 schema + Evidence 适配**（本仓库既有多模态/多 Agent 体系）
- **风控业务语义**保留为可选领域模块 `domains/risk/`，不进入通用层

```
┌─────────────────────────── Pi Agent（TypeScript）──────────────────────────┐
│  search_catalog → inspect_dataset → validate_query → execute_query          │
│  → get_data_quality → explain_lineage → get_snapshot                        │
│          │                                      │                           │
│          └── GatewayClient ──→ EvidenceFact(kind="query") ──→ EvidencePacket│
└──────────┬──────────────────────────────────────────────────────────────────┘
           │ HTTP（结构化 QueryPlan / validatedQueryId）
┌──────────▼──────────────────────────────────────────────────────────────────┐
│                    Lakehouse Query Gateway（FastAPI, Python）                 │
│  catalog/    查询目录（Iceberg 扫描 + 元数据）                                │
│  query/      QueryPlan 校验（只读/字段/分区/ODS 拒绝/limit/扫描量）+ 执行      │
│  quality/    确定性数据质量（profile + checks，无 LLM）                        │
│  lineage/    轻量血缘（层间链接 + 手动边）                                    │
│  storage/    存储抽象（local file:// / aws s3:// + Spark/Flink 配置）          │
│  security/   审计日志 + 限流                                                  │
└──────────┬──────────────────────────────────────────────────────────────────┘
           │ pyiceberg（只读扫描）
┌──────────▼──────────────────────────────────────────────────────────────────┐
│          Iceberg Warehouse（ODS → DWD → DWS → ADS）                           │
│  生产写路径（不动）：PySpark / PyFlink 作业 —— 沿用原平台                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 2. 分层边界（平台核心禁止风控名词）

| 层 | 允许内容 | 禁止内容 |
|----|---------|---------|
| 通用湖仓平台层 | 存储抽象 / S3 / local / Iceberg catalog / dataset registry / metadata / quality / lineage / snapshot / Query Gateway / 权限·审计·限流·超时 / 本地与云端配置 | `loan`、`borrower`、`credit_score`、`overdue`、`bad_rate`、`vintage`、`auc`、`ks`、`psi`（除非在 domains/risk） |
| 风控领域包 `domains/risk/` | 贷款/授信/订单/借款人实体；AUC/KS/PSI/坏账率/逾期率/Vintage；风控特征、数据集、指标公式、分析规则、模型监控 | — |
| Agent 智能层 | Pi Agent / 多模态工具 / 多 Agent 编排 / Evidence Packet / 数据工具客户端 / 最终回答 | — |

## 3. 查询协议

**禁止自由 SQL**。查询 = 结构化 QueryPlan → `validate_query` 校验 → `execute_query(validatedQueryId)`。

```
POST /v1/query/validate
{
  "datasetId": "ads.ads_sales_daily",
  "select": [{"field": "revenue", "aggregation": "sum", "alias": "total_revenue"}],
  "dimensions": ["region"],
  "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-01", "2026-07-31"]}],
  "limit": 100
}
→ { "ok": true, "validatedQueryId": "vq_...", "expiresAt": "..." }

POST /v1/query/execute
{ "validatedQueryId": "vq_..." }
→ QueryResult
```

validate_query 检查项：只读（结构化解构）、dataset 存在、字段存在、字段权限（敏感字段输出掩码）、分区过滤（分区表必须过滤分区列）、时间范围、最大行数（1000）、最大扫描量（max_scan_rows）、最大执行时间、禁止危险 SQL（防御性关键词检查）、敏感字段、**ODS 默认拒绝**（访问顺序 ADS → DWS → DWD → ODS）。

## 4. 返回协议

```json
{
  "queryId": "q_...",
  "datasetId": "ads.ads_sales_daily",
  "datasetLayer": "ADS",
  "snapshotId": 928374,
  "dataVersion": "v928374",
  "dataTimestamp": "2026-07-31T23:00:00Z",
  "columns": ["region", "total_revenue"],
  "rows": [["east", 300.0]],
  "rowCount": 1,
  "qualityStatus": "PASS",
  "lineageReference": "lineage://ads.ads_sales_daily?snapshot=928374",
  "warnings": [],
  "artifactId": "",
  "truncated": false
}
```

约束：默认 limit 100 / 最大 1000；不允许无界返回；**大结果落盘**（超过 `max_result_bytes` → artifactId + 摘要 20 行）；敏感字段 `***` 掩码；Agent 上下文只收摘要与小结果集。

## 5. 存储与 catalog

| 模式 | 环境变量 | catalog | 执行引擎 |
|------|---------|---------|---------|
| local（默认，无 AWS 凭据） | `LAKEHOUSE_MODE=local`、`LAKEHOUSE_WAREHOUSE_PATH=./.data/warehouse`、`LAKEHOUSE_CATALOG_TYPE=local` | pyiceberg SQL catalog（SQLite 元数据 + 本地数据文件） | pyiceberg scan + pyarrow 计算 |
| aws | `LAKEHOUSE_MODE=aws`、`LAKEHOUSE_S3_WAREHOUSE=s3://...`、`LAKEHOUSE_CATALOG_TYPE=glue` | AWS Glue | 同上（需环境凭据） |

`StorageProfile`（迁移自原平台 `riskcloud/infra/storage.py`）同时保留 Spark/Flink 的 catalog 配置生成（`spark_configs()` / `flink_sql_catalog_ddl()`）——生产写路径继续由原平台的 PySpark/PyFlink 作业驱动，Gateway 只读。

**不硬编码** bucket/region/账号/密钥——全部来自环境变量（`deploy/cloud/.env.example` 模式，改名为 `LAKEHOUSE_*`）。

## 6. 数据质量与血缘

- **质量**：确定性（无 LLM）。`profile`（缺失率/唯一率/逻辑类型/候选键/掩码样本，迁移自 `schema_profiler.py`）+ `checks`（row_count / missing_rate 阈值 → PASS/WARN/FAIL）。质量判定内嵌于每次查询（`qualityStatus`），也有独立端点。
- **血缘**：原平台无 lineage 模块（审计确认）——本实现为新建轻量血缘：层间命名链接（`ods_x → dwd_x → dws_x → ads_x`）+ 手动边注册。血缘引用字符串 `lineage://<dataset>?snapshot=<id>` 随查询结果返回。

## 7. 目录结构

```
services/lakehouse-gateway/
├── pyproject.toml          # 依赖：fastapi/uvicorn/pydantic/pyarrow/pyiceberg
├── README.md
├── app/
│   ├── main.py             # FastAPI 装配 + lifespan
│   ├── config.py           # LAKEHOUSE_* 配置（local/aws 双模式）
│   ├── api/routes.py       # 只读端点（8 个）
│   ├── catalog/dataset_registry.py   # Iceberg 扫描 + dataset 元数据 + search
│   ├── query/plan.py       # QueryPlan 解析 + validate
│   ├── query/executor.py   # 校验会话 + 执行（pyiceberg/pyarrow）+ 掩码/落盘
│   ├── quality/models.py   # profile 模型（迁移自原平台）
│   ├── quality/profile.py  # 确定性画像（迁移自原平台）
│   ├── quality/checks.py   # PASS/WARN/FAIL 判定
│   ├── lineage/lineage.py  # 轻量血缘
│   ├── storage/profile.py  # StorageProfile（迁移自原平台，RISKCLOUD_→LAKEHOUSE_）
│   ├── contracts/validation.py  # 契约校验框架（迁移自原平台）
│   ├── contracts/event.py       # 事件契约（迁移自原平台，领域枚举剥离）
│   └── security/guard.py   # 审计日志 + 滑动窗口限流
└── tests/                  # 57 个 pytest（含 API 冒烟）
```

## 8. 配置变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LAKEHOUSE_MODE` | `local` | `local` 无 AWS 凭据；`aws` 需 S3 + 凭据 |
| `LAKEHOUSE_WAREHOUSE_PATH` | `./.data/warehouse` | 本地 warehouse 路径 |
| `LAKEHOUSE_S3_WAREHOUSE` | — | aws 模式必填（`s3://...`） |
| `LAKEHOUSE_CATALOG_TYPE` | `local` | `local` / `glue` |
| `AWS_REGION` | `us-east-1` | aws 模式 |
| `LAKEHOUSE_GATEWAY_URL` | `http://localhost:8001` | Agent 侧连接地址（TS 工具读取） |
| `LAKEHOUSE_DEFAULT_LIMIT` / `LAKEHOUSE_MAX_LIMIT` | `100` / `1000` | 行数限制 |
| `LAKEHOUSE_MAX_SCAN_ROWS` | `1000000` | 扫描量上限 |
| `LAKEHOUSE_MAX_EXECUTION_MS` | `30000` | 执行时间上限 |
| `LAKEHOUSE_ALLOW_ODS` | `false` | 默认拒绝 ODS |
| `LAKEHOUSE_MAX_RESULT_BYTES` | `262144` | 超过则落盘 artifact |
| `LAKEHOUSE_SENSITIVE_FIELDS` | 9 个默认字段 | 输出掩码 |
| `LAKEHOUSE_AUDIT_LOG` | `.data/audit.log` | 审计日志路径 |
| `LAKEHOUSE_RATE_LIMIT` | `60` | 每客户端每分钟请求数 |

## 9. 本地启动与测试

```bash
# 启动（本地模式，无 AWS 凭据）
cd services/lakehouse-gateway
LAKEHOUSE_MODE=local LAKEHOUSE_WAREHOUSE_PATH=./.data/warehouse \
  python3 -m uvicorn app.main:app --port 8001

# 测试
cd services/lakehouse-gateway && python3 -m pytest tests/ -q     # 57 tests
cd <repo-root> && node --experimental-strip-types --test tests/data-tools.test.mts   # 11 tests
LAKEHOUSE_GATEWAY_URL=http://localhost:8001 node --experimental-strip-types experiments/e2e-lakehouse.mts
```

## 10. 真实数据接入（2026-08-01）

原数仓（LeakBench-RiskCloud `data/warehouse`，hadoop catalog 布局）已通过 `services/lakehouse-gateway/scripts/migrate_warehouse.py` **全部迁移**进 data-agent 本地数仓 `.data/warehouse`（pyiceberg SQL catalog）。迁移只读原仓库，7 张表 schema 保真：

| 层 | 表 | 行数 | domain |
|----|-----|------|--------|
| ODS | `ocr_result` | 2 | general |
| ODS | `pdf_parse_result` | 1 | **risk**（含 credit_score 等字段） |
| ODS | `streaming_events` | 0（空表） | general |
| DWD | `loan_application_detail` | 0（空表） | **risk** |
| DWS | `feature_values` | 0（空表） | general |
| DWS | `prediction_points` | 0（空表） | **risk** |
| ADS | `model_metrics` | 2 | **risk**（含 auc/ks 字段） |

**domain 标注**：迁移保留原字段名（数据保真，不 rename）；字段名含风险词（credit_score/auc/ks/applicant 等）的表由 registry 自动标注 `domain="risk"`，`/v1/catalog/search?domain=` 可过滤——语义隔离而非改名。风险词表见 `dataset_registry.py::RISK_DOMAIN_FIELDS`。

**EAV 值级掩码**：`ocr_result` 是 EAV 结构（field_name/field_value），敏感值（id_number 等）在值列——掩码扩展到值级：label 值命中敏感词 → 值列 `***`（`mask_rows`，配置 `LAKEHOUSE_SENSITIVE_LABEL_COLUMN`/`LAKEHOUSE_SENSITIVE_VALUE_COLUMN`）。

验证（真实数据）：`model_metrics` 查询返回 lr_v1 AUC 0.875 / lgb_v1 AUC 0.892；`ocr_result`（需 `LAKEHOUSE_ALLOW_ODS=true`）返回 2 行 OCR 事实，id_number 掩码。

```bash
# 重跑迁移（幂等：已存在的表跳过）
python3 services/lakehouse-gateway/scripts/migrate_warehouse.py \
  --source /path/to/LeakBench-RiskCloud/data/warehouse --target .data/warehouse
```

## 11. 迁移来源记录

| 模块 | 原文件（LeakBench-RiskCloud @ e386f920） | 通用化修改 |
|------|------------------------------------------|-----------|
| `storage/profile.py` | `riskcloud/infra/storage.py` | 环境变量 `RISKCLOUD_*`→`LAKEHOUSE_*`；默认 bucket 去除风险前缀；catalog 名 `riskcloud`→`lakehouse` |
| `contracts/validation.py` | `riskcloud/contracts/validation.py` | 无（原样） |
| `contracts/event.py` | `riskcloud/contracts/event.py` | 领域枚举 EventType/EntityType（loan_application 等）剥离为开放字符串 + snake_case 校验；身份计算/不可变/碰撞证明原样 |
| `quality/models.py` | `riskcloud/agents/contracts/models.py`（3 个 profile 类） | 从 agent 状态机模型文件中提取独立 |
| `quality/profile.py` | `riskcloud/profiling/schema_profiler.py` | 仅 import 更新 |

原项目代码零删除、零修改；生产资源零接触（未运行 Spark/Flink 作业、未写生产 S3/Iceberg/Kafka/Redis）。

## 12. CDXR 治理平面（2026-08-01，第三轮）— LEGACY（v0.6.0 起）

> **LEGACY（2026-08-01，v0.6.0）**：CDXR 已重构为按需训练数据适用性检查（见第 13 节）。本节的常驻治理平面（17 张治理表、治理 CLI、6 个只读 API、5 个治理工具）**代码/API/表全部保留且只读**，但旧治理工具不再注册到 Agent 默认工具集；文档保留供兼容性参考。不再进行迁移，无新写入路径。

CDXR（Cross-Data X-Ray，来自 LeakBench-RiskCloud @ e386f920）不是湖仓的一层，而是横跨各层的治理平面：治理产物按阶段落入 `governance_ods/dwd/dws/ads`（平行命名空间），规则注册表在 `governance_meta`；Query Gateway 保持只读，治理写入只经独立 CLI（`python3 -m app.governance.cdxr.run`）。

- 确定性引擎（无 LLM）：validity/detectability/decision/confidence 原样移植（12 个 reason codes、0.5/0.7 阈值、0.95/0.7 confidence）
- 通用内核禁词（loan/borrower/credit_score/overdue/bad_rate/vintage/auc/ks/psi）只存在于 `domains/risk/governance/cdxr/`（词表注入）
- 17 张治理表（见 `CDXR_DATA_MODEL.md`）；6 个只读治理 API；5 个 Pi 治理工具；Evidence 新增 `governance` sourceType（优先级 query > governance > parse > cited > inferred）
- 三个演示场景 ground truth：`infra/lakehouse/seed/cdxr_expected_results.json`（固定 `--as-of`，确定性 run/finding id）
- 架构与数据模型详见 `CDXR_GOVERNANCE_ARCHITECTURE.md` / `CDXR_DATA_MODEL.md` / `CDXR_AGENT_INTEGRATION.md`

## 13. CDXR 按需训练数据检查（2026-08-01，第五轮）

独立引擎 `services/cdxr-engine/`（核心零依赖，只依赖抽象 `TrainingDatasetPort`）＋ 网关侧只读 adapter（`app/integrations/cdxr_lakehouse_adapter.py`）＋ 单端点 `POST /v1/cdxr/training-assessments`：

- 引擎：contracts（协议/状态聚合）→ ports（TrainingDatasetPort）→ engine（校验/取数/编排/TRACEABILITY）→ rules（10 条确定性规则）；阈值显式配置（`AssessmentConfig`），不硬编码
- 状态汇总（确定性）：CRITICAL/明确泄漏 → BLOCK；信息缺失/规则失败 → INSUFFICIENT_EVIDENCE；HIGH → REVIEW；否则 ALLOW。规则异常绝不判 ALLOW
- 约束：不写 governance_*；不返回原始数据行（仅聚合；敏感字段分布返回 None）；max_scan_rows（metadata 预估算）/ max_execution_ms / snapshot 限制；请求模型 `extra="forbid"`（无 SQL/表达式入口）；审计仅记录元数据
- 触发面：仅显式 POST。启动不扫描，普通 `/v1/query/execute` 不经过 CDXR
- Agent 工具 `assess_training_data` 默认不注册（`ENABLE_CDXR_TRAINING_TOOL=true` 才注册，且只注册这一个）
- 详见 `CDXR_AGENT_INTEGRATION.md` §6

## 14. 批/流 Pipeline（2026-08-02，Round-9）

- 独立写路径 `pipelines/`：Batch（源文件 → ODS → DWD → DWS → ADS）与 Streaming（事件 replay → ODS，watermark/去重/checkpoint/dead-letter），Hybrid 汇合增量 fold。
- Gateway 只读边界不变；pipeline 写路径仅 CLI/E2E 显式触发，不注册 Agent 工具、不经 Gateway 暴露。
- 测试仓库 `.data/pipeline-test/`（独立于 `.data/warehouse`）。详见 `LAKEHOUSE_PIPELINE_AUDIT.md` / `LAKEHOUSE_BATCH_PIPELINE.md` / `LAKEHOUSE_STREAMING_PIPELINE.md` / `LAKEHOUSE_HYBRID_PIPELINE.md` / `LAKEHOUSE_PIPELINE_LOCAL_RUNBOOK.md`。
