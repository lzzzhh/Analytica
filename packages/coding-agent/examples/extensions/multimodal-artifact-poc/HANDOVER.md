# 交接文档 — data-agent（multimodal-artifact-poc）

日期：2026-08-01
工作目录：`/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc`
远端：`https://github.com/lzzzhh/data-agent`（分支 `feature/cloud-lakehouse-datasource`）
上游来源（只读）：`/Users/zhanhuilin/Documents/风控大数据/LeakBench-RiskCloud` @ commit `e386f920`

---

## 1. 项目是什么

将"多源信贷风控数据平台"（LeakBench-RiskCloud）的能力**通用化抽取**并接入 Pi Agent（多模态编码助手）作为数据源与治理平面的三步改造。数据平台侧继续使用 Python/pyiceberg（**不重写 Spark/Flink**）；Agent 侧只做 TypeScript 客户端 + 工具 schema + Evidence 适配。

- **第一轮（已交付）**：多模态多 Agent 架构——L1/L2 两层编排、Evidence Quality Gate、确定性 Evidence 合并器（query/parse/cited/inferred + governance）
- **第二轮（已交付）**：云上湖仓数据层——7 张真实 Iceberg 表迁移（ODS/DWD/DWS/ADS）、只读 Query Gateway（结构化 QueryPlan，无 raw SQL）、7 个受控数据工具、确定性种子数据（5 类可验证异常）
- **第三轮（已交付）**：CDXR 治理平面——确定性治理引擎、17 张治理表、6 个只读治理 API、5 个治理工具、3 个演示场景、Evidence `governance` sourceType
- **Review 修复（已交付，commit `2b88b47`）**：EAV 掩码绕过、历史快照扫描、dataset ID 互操作、查询下推、规则失败状态、finding 生命周期、会话绑定等 11 项

## 2. 仓库结构

```
poc 根/
├── index.ts                    # Pi extension 入口（注册 12 个数据/治理工具）
├── src/
│   ├── evidence.ts             # EvidenceSourceType + 合并器（优先级 query>governance>parse>cited>inferred）
│   ├── data-tools/             # GatewayClient / tools.ts（12 工具）/ evidence-adapter.ts
│   └── doc-agents.ts           # 多模态/文档多 Agent（第一轮产物，LLM 调用入口 callLlm）
├── services/lakehouse-gateway/ # FastAPI 只读网关 + CDXR 治理（Python）
│   └── app/
│       ├── api/routes.py            # 8 个查询 API + rate limit + audit
│       ├── api/governance_routes.py # 6 个只读治理 API
│       ├── catalog/dataset_registry.py  # 数据集注册（短名 id、domain 标注）
│       ├── query/{plan,executor}.py # 结构化校验 + 下推执行（row_filter/plan_files 预检）
│       ├── quality/  lineage/  security/  storage/  contracts/
│       ├── governance/cdxr/          # 通用内核：engine/rules/aggregate/store/runner/run(CLI)
│       └── governance/reader.py      # 治理只读读取（短名归一化 + dataset 下推）
├── domains/risk/governance/cdxr/     # 风控词表唯一允许位置（vocabulary + paired_training）
├── infra/lakehouse/seed/             # 确定性种子（generators/seed.py/expected_results.json/cdxr_expected_results.json）
├── experiments/                      # 验收脚本（verify-seed / agent-analysis / e2e-lakehouse / e2e-governance）
├── tests/                            # TS 单测（data-tools / governance）
└── docs/                             # 审计与架构文档（见 §6）
```

## 3. 核心架构与约束

```
Catalog / Quality / Lineage / Snapshot
                 ▼
        CDXR Governance Engine（确定性，无 LLM）
        └─ 产物落 governance_meta/ods/dwd/dws/ads（17 表，全 append + 读侧取最新）
                 ▼
        Query Gateway（只读；validate→validatedQueryId(10min TTL, 绑定 x-client-id)→execute）
                 ▼
        Pi Agent：search_catalog → inspect → validate/execute → quality/lineage/snapshot
                  → get_dataset_governance_profile → findings/evidence/review
```

**不可违反的约束：**
1. **禁词**：`loan borrower credit_score overdue bad_rate vintage auc ks psi` 只能出现在 `domains/risk/`；通用层（`app/`）零命中（测试断言扫描整个 `app/`，唯一白名单 = registry 领域标注 fallback 词表）
2. **只读边界**：Gateway 永不写表；治理写入只经 `python -m app.governance.cdxr.run`（独立身份）
3. **LLM 永不裁决治理**：确定性引擎负责 rule/severity/status/score；LLM 只能解释
4. **无 raw SQL**：QueryPlan 结构化 + validatedQueryId 执行
5. **确定性演示**：固定 `--as-of` 与 seed=42 → 相同 run/finding id（可复现）

## 4. 如何运行

```bash
# 1) 网关（本地模式，无 AWS 凭据）
cd services/lakehouse-gateway
LAKEHOUSE_MODE=local LAKEHOUSE_WAREHOUSE_PATH=<poc>/.data/warehouse python3 -m uvicorn app.main:app --port 8804

# 2) 种子数据（幂等；--reset 重建迁移+种子）
python3 infra/lakehouse/seed/seed.py --reset --seed 42 --days 60 --scale 1

# 3) CDXR 治理 CLI（对真实数仓；固定 as-of 可复现）
cd services/lakehouse-gateway
LAKEHOUSE_WAREHOUSE_PATH=<poc>/.data/warehouse python3 -m app.governance.cdxr.run \
  --dataset-id ads.model_metrics --time-column created_at --as-of 2026-07-31T12:00:00Z

# 4) 测试与验收
cd services/lakehouse-gateway && python3 -m pytest -q                  # Python 99/99
cd <poc> && node --experimental-strip-types --test "tests/*.test.mts"  # TS 22/22
npx tsgo --noEmit                                                      # 0 error
node --experimental-strip-types experiments/verify-seed.mts            # 5 异常 ground truth
LAKEHOUSE_GATEWAY_URL=<gw> node --experimental-strip-types experiments/e2e-lakehouse.mts
node --experimental-strip-types experiments/e2e-governance.mts         # 治理验收（含 LLM 回答，需 API 可用）
node --experimental-strip-types experiments/agent-analysis.mts         # 第二轮验收（LLM）
```

环境变量：`LAKEHOUSE_GATEWAY_URL`（Agent 连接）、`LAKEHOUSE_WAREHOUSE_PATH`、`LAKEHOUSE_MODE`（local/aws）、`LAKEHOUSE_ALLOW_ODS`（默认 false）。

## 5. 测试基线（2026-08-01，全绿）

| 项 | 结果 | 说明 |
|----|------|------|
| Python pytest | **99/99** | 84 既有 + 15 review 回归（tests/test_review_fixes.py） |
| TS node --test | **22/22** | data-tools 12 工具断言 + governance 11 |
| tsgo | **0 error** | 排除 coding-agent core highlight.js 噪音 |
| verify-seed | OK | 5 类异常真实查询确认（PSI 0.3379 / AUC 0.8906→0.7068 / 缺失 44% / stale 3d / bad rate Δ0.1519） |
| e2e-lakehouse | OK | 注意：需 `LAKEHOUSE_GATEWAY_URL=http://localhost:8791` 环境变量 |
| e2e-governance | OK | 3 数据集 profile 与 expected 逐项一致 + 验收问题 8 项检查 |
| agent-analysis | OK | LLM 回答 9/9（偶发波动，内置 ≤3 轮重生成） |

## 6. 文档索引

| 文档 | 内容 |
|------|------|
| docs/CDXR_EXTRACTION_AUDIT.md | 原 CDXR 模块审计（18 项确认，来源 commit） |
| docs/CDXR_INTEGRATION_BASELINE.md | 第三轮改造前工作区快照 |
| docs/CDXR_GOVERNANCE_ARCHITECTURE.md | 治理平面架构（引擎/规则/确定性边界） |
| docs/CDXR_DATA_MODEL.md | 17 张治理表字段 + 6 个 API |
| docs/CDXR_AGENT_INTEGRATION.md | 5 个治理工具 + Evidence 接入 + 验收场景 |
| docs/LAKEHOUSE_ARCHITECTURE.md | 湖仓平台架构（含治理平面章节） |
| docs/DATA_AGENT_INTEGRATION.md | Agent 接入（含治理工具章节） |
| docs/LAKEHOUSE_EXTRACTION_AUDIT.md | 第二轮湖仓抽取审计 |
| infra/lakehouse/seed/README.md | 种子数据用法 + CDXR 演示场景 |

## 7. 已知限制与遗留问题

1. **pyiceberg 0.11 SQL catalog 本地模式**：aws（Glue）代码路径存在但未实测（需生产凭据，历来禁止接触）；hadoop catalog 不受支持
2. **时间列语义**：种子表时间列是 ISO 字符串（非 timestamp 类型）；between 校验按"类型 or 时间语义列名"判定
3. **执行超时非硬中断**：pyarrow 扫描无中断原语——成本边界由 `plan_files` 预检（max_scan_rows）保证，`max_execution_ms` 超时仅告警（文档已注明）
4. **lineage 为轻量实现**：命名链接；`lineage_reference_check` 默认关闭（避免误报）；完整谱系图谱未做
5. **review/alert 写路径未实现**：`governance_dwd.cdxr_review_action`、`governance_ads.governance_alert` 表结构就位但第一版无写入方（Agent 不可关闭/豁免 finding）
6. **LLM 自由文本偶发不完整**：E2E 内置 ≤3 轮重生成兜底；确定性数值校验不依赖 LLM
7. **paired_training sklearn 实现未经训练验证**：演示走 NOT_EVALUATED（接口 + 领域适配已就位）
8. **registry 短名 id**：查询层沿用短名（`model_metrics`），治理层用全名（`ads.model_metrics`）——reader 已做归一化互操作；同名跨层表冲突会被记录（`registry.collisions`）而非静默覆盖

## 8. 下一步建议

1. review 写路径（人工审核：RESOLVE/WAIVE + review_action 落表 + 认证设计）
2. governance_alert 触发规则（severity 阈值 → 告警表 + 通知）
3. 治理 run 调度化（周期性 job，`cdxr_issue_trend` 结构已就位）
4. aws 模式实测（Glue + S3）
5. lineage 增强后开启 lineage_reference_check
6. 治理平面接入多 Agent 编排（治理结果作为 quality gate 输入）
7. `domains/risk/metrics/`、`domains/risk/datasets/` 领域模块填充（AUC/KS/PSI 公式等，与通用层解耦）

## 9. Git 状态

- 分支 `feature/cloud-lakehouse-datasource`；HEAD `2b88b47`（review 修复），已推送
- 提交历史：`67a899a`（基线）→ `4e21b3e`（第三轮 CDXR）→ `2b88b47`（review 修复）
- **工作区干净**；`.data/`（数仓）、`__pycache__/`、`src/data-tools/*.js`（编译产物）不入库
- 原 RiskCloud 仓库只读（禁止修改/删除）；生产资源零接触
- 每轮改造遵循"**先报告后提交**"：完成交付报告 → 用户确认 → 提交推送
