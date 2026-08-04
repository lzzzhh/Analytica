# Pipeline Governance — Phase 1（Schema Discovery & 设计审批）

实现范围：`DATA_PIPELINE_GOVERNANCE_AGENT_ARCHITECTURE.md` Phase 1。为通用数据 Pipeline 提供 **Schema 发现 → SchemaSpec/PipelineSpec 设计 → 确定性校验 → 非可执行草案编译 → 人工审批 → 版本化 Amendment** 闭环。Agent 只建议，不执行；所有关键决策由 OPERATOR_CLI 人工审批。

## 1. 数据合同（10 个，唯一事实来源 `contracts/pipeline-governance/*.schema.json`）

1. `source-registration` — 源注册
2. `source-schema-profile` — 确定性字段画像（candidate keys 带 evidence+confidence）
3. `schema-spec` — 目标 Schema 设计
4. `pipeline-spec` — Pipeline 设计
5. `pipeline-draft-artifact` — **非可执行**草案（executable=false）
6. `validation-issue` — 校验问题
7. `pipeline-review-package` — 审批包（含 draft）
8. `approval-decision` — 审批决策（绑定 reviewContentHash + approverSource=OPERATOR_CLI + osActor）
9. `pipeline-amendment` — 版本化修订
10. `approved-pipeline-spec` — 冻结 Spec（四哈希：schema/pipeline/draft/reviewPackage）

Python 与 TypeScript 从同一 schema 文件加载（`pipelines/governance/contracts.py` 用 referencing registry 解析 $ref）。

## 2. 状态机

```
DRAFT → VALIDATING → DRAFT_COMPILED → WAITING_FOR_APPROVAL
      → APPROVED | CHANGES_REQUESTED | REJECTED
```

- 草案在**审批前**由确定性 Compiler 生成（executable=false，不可执行/部署）；
- APPROVED 冻结四哈希（无运行许可——Phase 1 不产生运行许可）；
- CHANGES_REQUESTED → 新版本 Spec + 重新编译 + 重新校验 + **新 ReviewPackage**（旧审批不复用）；
- REJECTED 终止该 Spec 谱系。

## 3. Schema Discovery（确定性边界）

- 确定性：字段类型/nullability、null rate、cardinality（有界采样 `col.unique()`）、candidate event time（名称启发式）、sensitive 候选（名称规则）；
- **candidate key 只产出"候选 + 证据（uniquenessRatio/nonNullRatio/cardinality）+ 置信度"**——样本唯一性**绝不自动认定主键**；
- 主键由 Agent 提议 + 人工在 ReviewPackage 确认。

## 4. 审批接口

- **OPERATOR_CLI**：`python3 -m pipelines.governance review <schema.json> <pipeline.json>`、`approve <reviewId> --decision APPROVE|REQUEST_CHANGES|REJECT`、`show <reviewId>`、`sealed <specId>`
- 审批绑定 reviewContentHash + osActor（`user@host`）+ 时间；
- **Agent 无 Shell / approval CLI / 审批存储写权限**——AGENT-source 决策被合同拒绝；
- 不宣称能证明人类身份（CLI 是显式操作员动作，可审计）。

## 5. 持久化（追加式、版本不可变）

- 运行数据在 `.data/pipeline-governance/`（**禁止进入 Git**；源码在 `pipelines/governance/`）；
- `objects/<type>/<id>@<version>.json` 每版本不可变（重复写同版本抛错）；
- `ledger.jsonl` 追加式写日志；`reviews/<reviewId>.json` 审批包不可变；
- `PIPELINE_GOVERNANCE_ROOT` 可指定隔离根（E2E 用临时根）。

## 6. Feature Flags（仅 Phase 1 已实现，7 个）

`round2.pipeline_governance`（父）+ `pipeline_schema_discovery` / `pipeline_schema_design` / `pipeline_spec_generation` / `pipeline_draft_compilation` / `pipeline_human_approval` / `pipeline_amendment`。build full/evaluation-full 编译；runtime 默认关；显式 `ENABLE_PIPELINE_GOVERNANCE`。

**未预注册**：event_store / state_reducer / agent_worker / watchdog / spark/flink governance / iceberg_layout / remediation / placement / cdxr_promotion_gate（后续 Phase 实现时再注册）。

## 7. 测试

- 单元：`pipelines/governance/tests/test_governance.py`（18：合同/仓库不可变/发现证据/校验/编译/审批/Amendment/Agent 无审批权）
- E2E：`experiments/e2e-governance-phase1.mts`（17：发现→设计→校验→编译→CLI 审批→冻结→变更循环→篡改拒绝→Agent 拒绝）

## 8. 非目标（Phase 1 明确不做）

Spark/Flink 运行治理、Event Store 与 Deadline Watchdog、小文件/倾斜检测、PlacementPlan、CDXR DWS→ADS Gate、自动部署/运行 Pipeline、完整状态栏、Cron 轮询、Pi UI 审批（第一版 CLI）。
