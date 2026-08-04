# Data Analysis — 协议（Contracts）

核心类型定义：`src/data-analysis/contracts.ts`。

## 1. run_data_analysis 输入（DataAnalysisRequest）

| 字段 | 说明 |
|------|------|
| objective | 分析目标（必填） |
| questions? | 具体问题列表 |
| analysisType | DESCRIPTIVE / TREND / PERIOD_COMPARISON / BREAKDOWN / DISTRIBUTION / CORRELATION / STATISTICAL_TEST / CUSTOM |
| dataRefs | AnalysisDataRef[]（≥1，仅可信 artifact id `art_<16 hex>`） |
| metricDefinitions? | MetricDefinition[]（metricId/label/expression/aggregation/valueType/unit/precision） |
| dimensions? / timeField? | 维度 / 时间字段 |
| timeRange? / comparison? | 时间窗 / 对比基线 |
| expectedViews? | METRIC_CARDS / TABLE / LINE_CHART / BAR_CHART / SCATTER / HISTOGRAM |
| constraints? | maxAttempts(2)/timeoutSeconds(120)/maxOutputRows(500)/maxSeriesPoints(2000) |

AnalysisDataRef：`artifactId`（可信）、`sourceType`（LAKEHOUSE_QUERY/TABULAR_ARTIFACT/DERIVED_ARTIFACT）、`queryId?`、`snapshotId?`、`contentHash?`、`format`（JSON/CSV/PARQUET/ARROW）、`schema?`、`rowCount?`、`allowedColumns?`、`masked`。

禁止：raw SQL、Python/JS 代码、Bash、任意绝对路径、连接串、凭证。

## 2. TaskGateResult

`route`（QUERY_GATEWAY / DATA_ANALYSIS_SUBAGENT / UNSUPPORTED）+ `reasons[]` + `complexityScore`。

## 3. AnalysisPlan（子 Agent 执行前生成）

planId/runId/objective/analysisType/inputArtifacts/selectedColumns/metricDefinitions/dimensions/timeField/steps/expectedOutputs/methods/assumptions/limitations/createdAt。校验（plan-validator）：input 必须匹配请求、字段在允许 schema 内、不改时间范围/目标/数据源、视图合法、steps ≤ 30。

## 4. AnalysisResultArtifact（不可变，UI 直接读取）

schemaVersion/artifactId/runId/status（COMPLETED/PARTIAL/FAILED）/title/sections/findingsRef?/executionManifestRef?/**reviewStatus:"NOT_REVIEWED"**/createdAt/validationRefs[]/reviewPackageRef?/supersedesArtifactId?（后两者为第五轮预留）。

Section 固定 Schema：
- METRIC_CARDS：metrics[]（metricId/label/value/valueType/unit?/precision?/comparison?/warningCode?）
- TABLE：columns[]/rows[]/totalRows/displayedRows/downloadableArtifactRef?
- LINE_CHART/BAR_CHART/SCATTER/HISTOGRAM：chartTitle/x/series[]（name+points[]）/unit?/precision?/warnings?

禁止：任意 HTML/JS/前端代码/模型生成的可执行模板。

## 5. AnalysisAgentSummary（主 Agent 可见，无数值）

artifactId/runId/status/title/availableViews/findingRefs/warningCodes/**displayedDirectly:true**/reviewStatus/dataInputRequired?。禁止字段：value/rows/series/testStatistic/pValue/rawOutput。

## 6. AnalysisFinding

findingId/code/claim/category（TREND/CHANGE/CONTRIBUTION/DISTRIBUTION/CORRELATION/SIGNIFICANCE/DATA_LIMITATION）/direction?/severity/evidenceRefs/method/confidence/limitations/**causalClaim:false**（恒 false）。

## 7. ExecutionManifest（第五轮审核输入）

runId/artifactId/inputArtifacts[]（artifactId+queryId+snapshotId+contentHash）/scriptHash/scriptAttempts/runtimeVersions/dependencyVersions/attempts[]（status/errorCode/errorMessage/durationMs）/warnings/createdAt。

## 8. 错误码

SCRIPT_SYNTAX_ERROR / SCRIPT_IMPORT_ERROR / INPUT_ARTIFACT_MISSING / INPUT_SCHEMA_MISMATCH / FIELD_NOT_ALLOWED / RESULT_SCHEMA_INVALID / EXECUTION_TIMEOUT / OUTPUT_TOO_LARGE / NUMERIC_ERROR / UNSUPPORTED_ANALYSIS / DATA_INPUT_REQUIRED / SANDBOX_VIOLATION。

可重试：SCRIPT_SYNTAX_ERROR / SCRIPT_IMPORT_ERROR / RESULT_SCHEMA_INVALID / NUMERIC_ERROR。

## 9. 物化接口

`POST /v1/query/materialize`（round4.analysis_input_materialization 门控）
入参：validatedQueryId + format（parquet/arrow）
出参：artifactId/queryId/datasetId/snapshotId/rowCount/columns/contentHash/masked/format/expiresAt（无 rows、无 artifactPath）。复用 validate→caller 绑定→权限→脱敏→行/扫描限制链路；不写回业务数仓。
