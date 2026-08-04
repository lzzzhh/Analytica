/**
 * Data Analysis Subagent — protocol contracts (fourth product round).
 *
 * Ownership:
 *  - The subagent and the script produce numbers, tables and charts;
 *  - They are delivered to the Pi frontend through the tool UI renderer
 *    (details channel), never through the model-facing content;
 *  - The main agent only receives AnalysisAgentSummary (refs + status);
 *  - Result artifacts are immutable and carry reviewStatus="NOT_REVIEWED"
 *    (round-5 reviewer consumes them read-only).
 */
export type AnalysisType =
  | "DESCRIPTIVE"
  | "TREND"
  | "PERIOD_COMPARISON"
  | "BREAKDOWN"
  | "DISTRIBUTION"
  | "CORRELATION"
  | "STATISTICAL_TEST"
  | "CUSTOM";

export type AnalysisDataSourceType =
  | "LAKEHOUSE_QUERY"
  | "TABULAR_ARTIFACT"
  | "DERIVED_ARTIFACT";

export type AnalysisDataFormat = "JSON" | "CSV" | "PARQUET" | "ARROW";

export interface AnalysisDataRef {
  artifactId: string;
  sourceType: AnalysisDataSourceType;
  queryId?: string;
  snapshotId?: string;
  contentHash?: string;
  format: AnalysisDataFormat;
  schema?: Array<{ name: string; type: string; sensitive?: boolean }>;
  rowCount?: number;
  allowedColumns?: string[];
  masked: boolean;
}

export interface MetricDefinition {
  metricId: string;
  label: string;
  expression?: string;
  aggregation?: "sum" | "avg" | "min" | "max" | "count" | "distinct";
  valueType?: MetricValueType;
  unit?: string;
  precision?: number;
}

export type MetricValueType =
  | "NUMBER"
  | "PERCENT"
  | "CURRENCY"
  | "INTEGER"
  | "DURATION"
  | "TEXT";

export interface AnalysisTimeRange {
  start?: string;
  end?: string;
  timezone?: string;
}

export interface AnalysisComparison {
  baselineStart?: string;
  baselineEnd?: string;
  method?: string;
}

export type ExpectedView =
  | "METRIC_CARDS"
  | "TABLE"
  | "LINE_CHART"
  | "BAR_CHART"
  | "SCATTER"
  | "HISTOGRAM";

export interface AnalysisConstraints {
  maxAttempts?: number;
  timeoutSeconds?: number;
  maxOutputRows?: number;
  maxSeriesPoints?: number;
}

export interface DataAnalysisRequest {
  objective: string;
  questions?: string[];
  analysisType: AnalysisType;
  dataRefs: AnalysisDataRef[];
  metricDefinitions?: MetricDefinition[];
  dimensions?: string[];
  timeField?: string;
  timeRange?: AnalysisTimeRange;
  comparison?: AnalysisComparison;
  expectedViews?: ExpectedView[];
  constraints?: AnalysisConstraints;
}

/** Deterministic task gate output. */
export type TaskGateRoute = "QUERY_GATEWAY" | "DATA_ANALYSIS_SUBAGENT" | "UNSUPPORTED";

export interface TaskGateResult {
  route: TaskGateRoute;
  reasons: string[];
  complexityScore: number;
}

/** Analysis plan produced by the subagent before any script is written. */
export interface AnalysisPlan {
  planId: string;
  runId: string;
  objective: string;
  analysisType: AnalysisType;
  inputArtifacts: string[];
  selectedColumns: string[];
  metricDefinitions: MetricDefinition[];
  dimensions: string[];
  timeField?: string;
  steps: string[];
  expectedOutputs: string[];
  methods: string[];
  assumptions: string[];
  limitations: string[];
  createdAt: string;
}

/** Result artifact sections (fixed schema — the UI renderer only knows these). */
export interface MetricCard {
  metricId: string;
  label: string;
  value: string | number;
  valueType: MetricValueType;
  unit?: string;
  precision?: number;
  comparison?: { baseline: string; delta: number; method: string };
  warningCode?: string;
}

export interface MetricCardsSection {
  type: "METRIC_CARDS";
  metrics: MetricCard[];
}

export interface TableSection {
  type: "TABLE";
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, string | number | null>>;
  totalRows: number;
  displayedRows: number;
  downloadableArtifactRef?: string;
}

export type ChartKind = "LINE_CHART" | "BAR_CHART" | "SCATTER" | "HISTOGRAM";

export interface ChartSection {
  type: "LINE_CHART" | "BAR_CHART" | "SCATTER" | "HISTOGRAM";
  chartTitle: string;
  x: string;
  series: Array<{
    name: string;
    points: Array<{ x: number | string; y: number }>;
  }>;
  unit?: string;
  precision?: number;
  warnings?: string[];
}

export type AnalysisSection = MetricCardsSection | TableSection | ChartSection;

export type AnalysisResultStatus = "COMPLETED" | "PARTIAL" | "FAILED";

export const REVIEW_STATUS_NOT_REVIEWED = "NOT_REVIEWED" as const;
export type ReviewStatus = "NOT_REVIEWED";

/** Immutable analysis result artifact — consumed by the UI renderer and (round 5) by the reviewer. */
export interface AnalysisResultArtifact {
  schemaVersion: string;
  artifactId: string;
  runId: string;
  status: AnalysisResultStatus;
  title: string;
  sections: AnalysisSection[];
  findingsRef?: string;
  executionManifestRef?: string;
  /** Real analysis-plan artifact in the trusted store (Round 5 evidence). */
  analysisPlanRef?: string;
  /** Trusted-store provenance for Round 5 review (real artifact, hash-bound). */
  scriptArtifactRef?: string;
  /** Trusted-store copy of the FULL input manifest the script executed
   *  against (schema/columns/rowCount/mappings) — replay equivalence. */
  inputManifestRef?: string;
  reviewStatus: ReviewStatus;
  createdAt: string;
  /** Round-5 compatibility: stable review interface. */
  validationRefs: string[];
  reviewPackageRef?: string;
  supersedesArtifactId?: string;
}

/** What the main agent sees — no numbers, no rows, no series. */
export interface AnalysisAgentSummary {
  artifactId: string;
  runId: string;
  status: AnalysisResultStatus;
  title: string;
  availableViews: string[];
  findingRefs: string[];
  warningCodes: string[];
  displayedDirectly: true;
  reviewStatus: ReviewStatus;
  dataInputRequired?: {
    missing: string[];
    message: string;
  };
}

export type FindingCategory =
  | "TREND"
  | "CHANGE"
  | "CONTRIBUTION"
  | "DISTRIBUTION"
  | "CORRELATION"
  | "SIGNIFICANCE"
  | "DATA_LIMITATION";

export type FindingDirection = "UP" | "DOWN" | "STABLE" | "MIXED";
export type FindingSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

export interface AnalysisFinding {
  findingId: string;
  code: string;
  claim: string;
  category: FindingCategory;
  direction?: FindingDirection;
  severity: FindingSeverity;
  evidenceRefs: string[];
  method: string;
  confidence: number;
  limitations: string[];
  /** Default false — trends/contributions/correlations are never causal claims. */
  causalClaim: false;
}

/** Execution manifest — provenance for round-5 review. */
export interface ExecutionManifest {
  runId: string;
  artifactId: string;
  inputArtifacts: Array<{
    artifactId: string;
    queryId?: string;
    snapshotId?: string;
    contentHash?: string;
  }>;
  scriptHash: string;
  scriptAttempts: number;
  runtimeVersions: Record<string, string>;
  dependencyVersions: Record<string, string>;
  attempts: Array<{
    attempt: number;
    status: "RUN" | "FAILED" | "SUCCEEDED";
    errorCode?: string;
    errorMessage?: string;
    durationMs: number;
  }>;
  warnings: string[];
  createdAt: string;
}

export type AnalysisErrorCode =
  | "SCRIPT_SYNTAX_ERROR"
  | "SCRIPT_IMPORT_ERROR"
  | "SUBAGENT_LAUNCH_FAILED"
  | "INPUT_ARTIFACT_MISSING"
  | "INPUT_SCHEMA_MISMATCH"
  | "FIELD_NOT_ALLOWED"
  | "RESULT_SCHEMA_INVALID"
  | "EXECUTION_TIMEOUT"
  | "OUTPUT_TOO_LARGE"
  | "NUMERIC_ERROR"
  | "UNSUPPORTED_ANALYSIS"
  | "DATA_INPUT_REQUIRED"
  | "SANDBOX_VIOLATION";

export interface AnalysisFailure {
  errorCode: AnalysisErrorCode;
  message: string;
  retryable: boolean;
}

export const FORBIDDEN_INPUT_PATTERNS: RegExp[] = [
  /\b(select|insert|update|delete|create|drop|alter)\b[\s\S]{0,80}\b(from|into|table|database)\b/i,
  /\b(python3?|node|bash|sh|zsh)\b[\s-]+[c-e]/i,
  /(?:import|from)\s+(?:os|subprocess|socket|requests|urllib|http.client|ftplib|paramiko|shutil|pathlib)/,
  /\b(?:os\.system|subprocess\.|eval\(|exec\(|__import__|compile\(|open\(["'][/]|\bopen\(["'][a-zA-Z]:\\)/,
  /\b(?:pip|curl|wget|nc|ncat)\b/i,
  /(?:password|passwd|secret|token|api[_-]?key|connection[_-]?string)\s*[:=]/i,
  /\b(?:jdbc|postgresql|mysql|sqlite|mongodb|redshift|bigquery):\/\//i,
];

export const ANALYSIS_SCRIPT_RETRYABLE: ReadonlySet<AnalysisErrorCode> = new Set([
  "SCRIPT_SYNTAX_ERROR",
  "SCRIPT_IMPORT_ERROR",
  "RESULT_SCHEMA_INVALID",
  "NUMERIC_ERROR",
]);

export const DEFAULT_ANALYSIS_CONSTRAINTS: Required<AnalysisConstraints> = {
  maxAttempts: 2,
  timeoutSeconds: 120,
  maxOutputRows: 500,
  maxSeriesPoints: 2000,
};

/** Hard boundary: numbers never enter the model context. */
export const CANARY_NUMBER = "918273.645";
