# Feature Flag & Ablation Framework

统一的功能开关框架（Round-6）：编译期 + 运行期两级控制，单一 registry 为唯一事实来源，TS/Python 双端同构，实验结果可复现（Feature Snapshot）。

## 1. 核心概念

- **build（编译期）**：构建产物决定哪些 feature 存在。`scripts/generate-feature-manifest.mts` 从 registry + build profile 生成 `src/generated/build-features.ts` / `app/generated/build_features.py` / `build/feature-manifest.json`。运行期**无法开启**未构建的 feature。
- **runtime（运行期）**：env > 配置文件（`FEATURE_RUNTIME_CONFIG_PATH`）> runtime profile（`FEATURE_RUNTIME_PROFILE`）> registry 默认值。
- **effective**：`effectiveEnabled = buildEnabled AND runtimeEnabled AND parentEnabled AND dependenciesEnabled`。禁用原因（`disabledReason`）∈ {`NOT_BUILT`, `RUNTIME_DISABLED`, `PARENT_DISABLED`, `DEPENDENCY_DISABLED`, `INVALID_CONFIGURATION`}，确定性取值，不因顺序变化。
- **Feature Snapshot**：任何一次实验/运行可输出 `{experimentId, commitSha, buildProfile, buildFeatureHash, runtimeProfile, runtimeFeatureHash, effectiveFeatureHash, effectiveFeatures, disabledFeatures, unsafeAblations, modelId, promptVersion, datasetSnapshot, randomSeed, ruleVersion, generatedAt}`。TS 与 Python 对同一配置产生**相同的哈希**（默认 `e1ddae1fa9cddff0`）。
- **Snapshot 语义**：仓库内提交的 `build/feature-snapshot.json` 只是示例/最近一次生成结果，其 `commitSha` 记录的是**生成时点的 HEAD（即提交前的 pre-commit HEAD）**，不代表快照运行于该提交之后的新代码。正式评测时必须**在评测时重新生成**，以记录评测实际使用的 HEAD；评测结果不得长期依赖仓库内这份静态快照。`commitSha` 为可复现标识，不用于代码版本追溯。

## 2. 文件布局

| 路径 | 作用 |
|------|------|
| `config/features/registry.json` | 唯一事实来源（79 个 feature） |
| `config/features/build-profiles/*.json` | 构建档案：full / baseline / multimodal-only / lakehouse-only / evaluation-full |
| `config/features/runtime-profiles/*.json` | 运行档案：default / all-enabled / baseline / ablation/* |
| `experiments/configs/ablation/*.json` | 实验配置（experimentId + features map） |
| `scripts/generate-feature-manifest.mts` | 构建期生成器 |
| `scripts/print-effective-features.mts` | 运行期打印/写快照（TS） |
| `src/features/{types,hash,registry,resolver,snapshot}.ts` | TS 框架核心 |
| `services/lakehouse-gateway/app/features.py` | Python 双胞胎（`python -m app.features --print [--json|--write]`） |
| `src/generated/build-features.ts` / `app/generated/build_features.py` | 生成产物（勿手改） |
| `build/feature-manifest.json` / `build/feature-snapshot.json` | 生成产物 |

## 3. 命令

```bash
# 生成 manifest（默认 full 档案）
node --experimental-strip-types scripts/generate-feature-manifest.mts

# 指定构建档案
FEATURE_BUILD_PROFILE=baseline node --experimental-strip-types scripts/generate-feature-manifest.mts

# 打印当前有效 feature（TS / Python 结果必须一致）
node --experimental-strip-types scripts/print-effective-features.mts
cd services/lakehouse-gateway && python3 -m app.features --print

# 实验运行（runtime 配置）
FEATURE_RUNTIME_CONFIG_PATH=experiments/configs/ablation/no-l2-expert.json \
  node --experimental-strip-types scripts/print-effective-features.mts --json
```

## 4. 默认策略与 env

完整评测运行时必须显式设置 `FEATURE_RUNTIME_PROFILE=all-enabled`。该受支持档案启用完整 Round 1–5 能力，包括 Reviewer、review package、确定性 review gate、代码/分析复核、revision loop、frontend render 和 review tools。未设置 runtime profile 时使用 registry 默认值，不得将其解释为完整评测运行时。

- round1 全部默认 ON（保持既有行为）；round2 / round3 / legacy / round4 运行期默认 OFF，需显式开启：
  - `ENABLE_LAKEHOUSE=true` → `round2.lakehouse`
  - Pipeline（本地批/流处理）：`ENABLE_LAKEHOUSE_PIPELINE=true`（父）→ `round2.pipeline`；子开关 `ENABLE_BATCH_PIPELINE` / `ENABLE_STREAM_REPLAY_PIPELINE` / `ENABLE_PIPELINE_SOURCE_GENERATION` / `ENABLE_PIPELINE_ODS_LOAD` / `ENABLE_PIPELINE_DWD_TRANSFORM` / `ENABLE_PIPELINE_DWS_TRANSFORM` / `ENABLE_PIPELINE_ADS_TRANSFORM` / `ENABLE_PIPELINE_CHECKPOINTING` / `ENABLE_PIPELINE_DEAD_LETTER` / `ENABLE_PIPELINE_VALIDATION`。写路径仅 CLI/E2E 显式运行，不注册为 Agent 工具、不通过 Gateway 暴露。详见 `docs/LAKEHOUSE_PIPELINE_LOCAL_RUNBOOK.md`
  - Pipeline Governance（Phase 1）：`ENABLE_PIPELINE_GOVERNANCE=true`（父）→ `round2.pipeline_governance`；子开关 `ENABLE_PIPELINE_SCHEMA_DISCOVERY` / `ENABLE_PIPELINE_SCHEMA_DESIGN` / `ENABLE_PIPELINE_SPEC_GENERATION` / `ENABLE_PIPELINE_DRAFT_COMPILATION` / `ENABLE_PIPELINE_HUMAN_APPROVAL` / `ENABLE_PIPELINE_AMENDMENT`。审批仅 OPERATOR_CLI（绑定 reviewContentHash + osActor）；Agent 无审批写权限。详见 `docs/PIPELINE_GOVERNANCE_PHASE1.md`
  - `ENABLE_CDXR_TRAINING=true` → `round3.cdxr_training`（依赖 round2.lakehouse）
  - `ENABLE_LEGACY_CDXR_GOVERNANCE_TOOLS=true` / `ENABLE_LEGACY_CDXR_GOVERNANCE_CLI=true`
  - round4（Data Analysis Subagent，功能第四轮实际交付）：`ENABLE_DATA_ANALYSIS=true`（父）→ `round4.data_analysis`；子开关 `ENABLE_DATA_ANALYSIS_TOOL` / `ENABLE_ANALYSIS_TASK_GATE` / `ENABLE_ANALYSIS_INPUT_MATERIALIZATION` / `ENABLE_ANALYSIS_SUBAGENT` / `ENABLE_ANALYSIS_PLAN_GENERATION` / `ENABLE_ANALYSIS_WORKSPACE` / `ENABLE_ANALYSIS_SCRIPT_EXECUTION` / `ENABLE_ANALYSIS_RETRY` / `ENABLE_ANALYSIS_ARTIFACTS` / `ENABLE_ANALYSIS_FINDINGS` / `ENABLE_ANALYSIS_CHARTING` / `ENABLE_ANALYSIS_FRONTEND_RENDER`。硬边界：`analysis_frontend_render=false` 时 run_data_analysis 不注册、不降级为模型复述。详见 `docs/DATA_ANALYSIS_SUBAGENT_ARCHITECTURE.md`。
- 兼容别名（集中解析，别处不得再读）：`ENABLE_CDXR_TRAINING_TOOL` → `round3.cdxr_training`；`ENABLE_LEGACY_CDXR_GOVERNANCE` → 两个 legacy。
- 全部 env 名见 registry.json 的 `envBuildName` / `envRuntimeName`。
- `FEATURE_CONFIG_STRICT=true`：配置引用未知 feature / 非法值 → 启动即失败。

## 5. 禁用语义（重要）

- **tool**：不注册。Agent 的工具清单里根本不存在该工具——不是"注册但返回未配置"。
- **API**：返回 `404 FEATURE_DISABLED`（不执行内部逻辑）。Router 按 feature 挂载，feature 关闭时路由不存在（FastAPI 默认 404）。
- **CLI**（legacy governance）：feature 关闭时退出码 2 并打印 FEATURE_DISABLED。
- **规则**（round3.cdxr_* → 引擎规则）：禁用规则不执行、出现在响应 `disabledRules`、**绝不报告为 PASS**；只要有关闭的规则，评估结果不可能为 ALLOW（降级为 INSUFFICIENT_EVIDENCE，附 warning）。
- **证据**：`round2.query_evidence` 关闭时查询结果不生成 EvidenceFacts；`round2.lineage` / `round2.data_quality` 关闭时相应字段从 facts 与 summary 剥离。

## 6. 不安全 Ablation（safetyClass=unsafe）

`ablate.*` 五个 feature（query_validation / sensitive_masking / ods_guard / scan_limit / raw_data_boundary）默认**不构建**。启用需要三重闸：

1. 构建：`BUILD_UNSAFE_EVALUATION_ABLATIONS=true`（生成器强制要求）
2. 运行：`EVALUATION_MODE=true`
3. 环境：`APP_ENV != production`（production 下检测到 unsafe 配置直接抛错拒绝启动）

未满足闸门时 unsafe feature 静默无效（NOT_BUILT / 警告），绝不半开。

## 7. 为未来功能新增 Feature 的规则（新增功能必须遵守）

1. 先在 `config/features/registry.json` 注册（id 格式 `roundN.name`，写清 parent/dependencies/safetyClass）。
2. 在构建档案的 features 字典中声明默认 build 开关（新功能默认 `false`，全开只发生在显式实验）。
3. 代码里**只允许**通过 resolver 查询：TS `getDefaultFeatureResolver().isEffective("...")`；Python `get_default_resolver().is_effective("...")`。禁止散落 `process.env` / `os.environ` 读取 feature 开关（唯一例外：`src/features/resolver.ts`、`scripts/generate-feature-manifest.mts`、`app/features.py`）。
4. 禁用路径必须是"不注册 / 不执行 / 404"，不是"注册了但返回禁用"。
5. 引擎规则与 feature 的映射统一登记在 `services/cdxr-engine/cdxr/engine.py` 的 `RULE_FEATURE_MAP`。
6. 工具/API 的 feature 映射登记在对应模块的 `*_TOOL_FEATURES` / `_require()` 处。
7. 实验配置放入 `experiments/configs/`（带 experimentId），运行结果附 Feature Snapshot。
8. 双端同步：改 registry / 生成器后必须重跑生成器并确认 TS 与 Python 的 `--print` 哈希一致。
9. 测试：注册/禁用两态都要有断言；禁用态断言"不存在"，不是"返回禁用消息"。
10. 更新本文档与 POC_STATUS 的 Round 章节。

## 8. CI 守则

- manifest 生成后 `build/feature-manifest.json` 的 `buildFeatureHash` 应纳入构建产物；快照哈希变化（同配置）即视为破坏性变更。
- `FEATURE_CONFIG_STRICT=true` 在 CI 常开，配置漂移（未知 feature id）直接失败。
- 不安全 ablation 在任何非实验 pipeline 中禁止开启；CI 任务若使用 unsafe feature 必须显式标注实验身份（experimentId）。
- 本地 `npm run check` 内置 `scripts/check-feature-hygiene.mts` 机器检查：src 中 feature-id 引用必须已注册、每个 API 路由必须有 `@_require` 守卫、业务代码禁止直接读 `ENABLE_*`、default-OFF 功能必须有测试覆盖。接入 CI 时直接运行 `npm run check` 即可。
