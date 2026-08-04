# Contributing — multimodal-artifact-poc

## 开发守则

### Feature Definition of Done

新增功能只有同时满足以下条件才可以合并：

- 已在 Feature Registry 注册；
- 已有 build-time flag；
- 已有 runtime flag；
- 已声明 parent 和 dependencies；
- 默认 profile 已更新；
- enabled/disabled 测试均通过；
- 已提供消融配置；
- 文档和 Feature Snapshot 已更新。

合并前必须通过 `npm run check`，其中 `scripts/check-feature-hygiene.mts`
执行机器强制检查（工具/API 的 feature 接线、env 读取白名单、测试覆盖）。

- 所有新能力必须纳入 Feature Flag 框架（见 `docs/FEATURE_FLAGS.md` §7 十条规则）：先在 `config/features/registry.json` 注册，代码只通过 resolver 查询开关，禁用路径是"不注册/不执行/404"而不是"返回禁用"。
- 不在 resolver/生成器以外的任何位置读取 feature env（`process.env` / `os.environ`）。
- 双端同步：改动 registry 或生成器后重跑 `scripts/generate-feature-manifest.mts`，确认 TS `scripts/print-effective-features.mts` 与 Python `python -m app.features --print` 的 `effectiveFeatureHash` 一致。
- 新增/修改测试后必须运行并保持全绿：
  - `cd services/lakehouse-gateway && python3 -m pytest tests/ -q`
  - `cd services/cdxr-engine && python3 -m pytest tests/ -q`
  - `node --experimental-strip-types --test "tests/*.test.mts"`（PoC 根）
  - Requirement Planning：`node --experimental-strip-types --test tests/requirement-planning.test.mts tests/requirement-planning-features.test.mts`、`node --experimental-strip-types experiments/e2e-requirement-planning.mts`、`node --experimental-strip-types experiments/requirement-planning/evaluate.mts`
  - Data Analysis：`node --experimental-strip-types --test tests/data-analysis.test.mts tests/data-analysis-ui.test.mts tests/data-analysis-context-isolation.test.mts tests/data-analysis-features.test.mts`、`node --experimental-strip-types experiments/e2e-data-analysis.mts`、`node --experimental-strip-types experiments/data-analysis/evaluate.mts`
- E2E 脚本（`experiments/*.mts`）需要 gateway 时在 spawn env 显式开启所需 feature（如 `ENABLE_LAKEHOUSE=true`），不要依赖默认全开。
- Requirement Planning 核心（`src/requirement-planning/`）保持纯确定性：禁止业务工具调用/网络/Python；新增能力先注册 `capability-registry.ts` 与 `adapters/pi-capabilities.ts`（工具名唯一出现处）。
- Data Analysis 核心（`src/data-analysis/`）硬边界：完整数值只进 Result Artifact 与 UI renderer（details），主 Agent content 永不携带数字；`analysis_frontend_render` 关闭时不注册 run_data_analysis、不降级为模型复述；脚本必须落盘后经受控 runner 执行（禁 `-c`/`-e`/heredoc）；子 Agent 不得直接访问数仓/凭据。
- 引擎规则与 feature 的映射统一登记在 `services/cdxr-engine/cdxr/engine.py` 的 `RULE_FEATURE_MAP`；工具与 API 的映射登记在 `*_TOOL_FEATURES` / `_require()`。
- 实验运行必须携带 Feature Snapshot（experimentId + 哈希），保证结果可复现。
  - Pipeline：`python3 -m pytest pipelines/tests/ -q`、`node --experimental-strip-types experiments/e2e-batch-pipeline.mts`、`node --experimental-strip-types experiments/e2e-streaming-pipeline.mts`、`node --experimental-strip-types experiments/e2e-hybrid-pipeline.mts`、`node --experimental-strip-types experiments/verify-pipeline-data.mts`
  - Pipeline Governance：`python3 -m pytest pipelines/governance/tests/ -q`、`node --experimental-strip-types experiments/e2e-governance-phase1.mts`
