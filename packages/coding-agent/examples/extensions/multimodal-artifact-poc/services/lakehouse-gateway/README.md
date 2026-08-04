# Lakehouse Query Gateway

只读数据访问服务（FastAPI），为 data-agent 提供云上湖仓（Iceberg）查询能力。

**核心原则**：不接收自由 SQL——查询必须走结构化 QueryPlan → `validate_query` → `execute_query(validatedQueryId)`。写路径（PySpark/PyFlink 作业）沿用原数据平台，本服务只读。

## 快速开始（本地模式，无 AWS 凭据）

```bash
# 依赖（Python ≥3.10）
pip install "fastapi>=0.110" "uvicorn[standard]>=0.29" "pydantic>=2.0" "pyarrow>=15" "pyiceberg[pyarrow]>=0.7"

# 启动
LAKEHOUSE_MODE=local \
LAKEHOUSE_WAREHOUSE_PATH=./.data/warehouse \
python3 -m uvicorn app.main:app --port 8001

# 健康检查
curl http://localhost:8001/health
```

## 端点（全部只读）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 服务 + catalog 状态 |
| GET | `/v1/catalog/search?q=&layer=&limit=` | 数据集搜索 |
| GET | `/v1/datasets/{dataset_id}` | 数据集元数据（schema/分区/snapshot） |
| POST | `/v1/query/validate` | 校验结构化 QueryPlan → `validatedQueryId` |
| POST | `/v1/query/execute` | 按 `validatedQueryId` 执行（禁自由 SQL） |
| GET | `/v1/quality/{dataset_id}` | 确定性数据质量（PASS/WARN/FAIL + profile） |
| GET | `/v1/lineage/{dataset_id}` | 血缘（upstream/downstream） |
| GET | `/v1/snapshots/{dataset_id}` | 快照列表 |

## 配置

见 `docs/LAKEHOUSE_ARCHITECTURE.md` §8（`LAKEHOUSE_*` 全量变量）。云端模式：

```bash
LAKEHOUSE_MODE=aws \
LAKEHOUSE_S3_WAREHOUSE=s3://<bucket>/<prefix> \
LAKEHOUSE_CATALOG_TYPE=glue \
python3 -m uvicorn app.main:app --port 8001
```

## 测试

```bash
python3 -m pytest tests/ -q   # 57 tests：storage/catalog/validation/executor/quality/lineage/API
```

端到端（含 Pi 工具面）：仓库根 `LAKEHOUSE_GATEWAY_URL=http://localhost:8001 node --experimental-strip-types experiments/e2e-lakehouse.mts`

## 迁移来源

通用核心迁移自 LeakBench-RiskCloud（commit `e386f920`）：存储抽象、契约校验、事件契约、数据画像。详见 `docs/LAKEHOUSE_EXTRACTION_AUDIT.md`（每文件的通用化修改记录于文件头注释）。
