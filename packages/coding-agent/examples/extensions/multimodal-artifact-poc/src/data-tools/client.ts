/**
 * Lakehouse Query Gateway client — TypeScript read-only client.
 *
 * Talks to services/lakehouse-gateway (FastAPI). The client NEVER sends raw
 * SQL: it sends structured QueryPlans, gets a validatedQueryId, and executes
 * by id (spec §6/§7).
 */

export interface GatewayConfig {
  baseUrl: string;
  /** timeout per request (ms) */
  timeoutMs?: number;
  /**
   * Stable client identity sent as the x-client-id header. The gateway binds
   * validatedQueryIds to the caller at validate time; without a stable id all
   * requests are "anon" and sessions are shared. PoC note: the header is
   * caller-asserted — a real deployment must bind the authenticated principal.
   */
  clientId?: string;
}

export interface FieldInfo {
  name: string;
  type: string;
  sensitive?: boolean;
  partition?: boolean;
}

export interface DatasetInfo {
  datasetId: string;
  displayName: string;
  layer: string;
  tableName: string;
  description: string;
  fields: FieldInfo[];
  version?: string;
  latestSnapshotId?: number | string | null;
  lastUpdatedAt?: string;
}

export interface SelectField {
  field: string;
  aggregation?: "sum" | "count" | "avg" | "min" | "max" | null;
  alias?: string;
}

export interface FilterCondition {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "in" | "is_null" | "is_not_null";
  value?: unknown;
}

export interface QueryPlan {
  datasetId: string;
  select: SelectField[];
  dimensions?: string[];
  filters?: FilterCondition[];
  limit?: number;
}

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  validatedQueryId: string;
  expiresAt?: string;
  issues: ValidationIssue[];
}

export interface QueryResult {
  queryId: string;
  datasetId: string;
  datasetLayer: string;
  snapshotId?: number | string | null;
  dataVersion: string;
  dataTimestamp: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  rowCount: number;
  qualityStatus: string;
  lineageReference: string;
  warnings: string[];
  artifactId?: string;
  truncated?: boolean;
}

export interface QualityCheck {
  check: string;
  status: string;
  detail: string;
}

export interface QualityResult {
  datasetId: string;
  status: string;
  checks: QualityCheck[];
  profile?: {
    rowCount: number;
    columns: Array<{ column: string; missingRate: number; uniqueRate: number; logicalTypes: string[]; distinctCount: number }>;
    candidateKeys: string[][];
    candidateTimeColumns: string[];
  };
}

export interface LineageResult {
  dataset_id: string;
  upstream: Array<{ source: string; target: string; kind: string }>;
  downstream: Array<{ source: string; target: string; kind: string }>;
  manual_edges: Array<{ source: string; target: string; kind: string }>;
}

export interface SnapshotInfo {
  snapshotId: number;
  timestampMs: number;
  manifestList?: string;
  summary?: Record<string, unknown>;
}

// -- CDXR governance (read-only) ---------------------------------------

export interface GovernanceProfile {
  datasetId: string;
  snapshotId?: string | null;
  governanceScore: number;
  status: string;                    // TRUSTED | CONDITIONAL | UNTRUSTED
  openFindingCount: number;
  highestSeverity: string;
  dimensionScores: Record<string, number>;
  qualityStatus?: string;
  qualityReference?: string | null;
  lineageReference?: string | null;
  findingIds: string[];
  generatedAt?: string;
}

export interface GovernanceFinding {
  findingId: string;
  runId: string;
  ruleId: string;
  datasetId: string;
  fieldName?: string | null;
  riskType?: string;
  riskStatus?: string;
  severity: string;
  confidence: number;
  reasonCodes?: string[];
  evidenceReferences?: string[];
  snapshotId?: string | null;
  dataVersion?: string | null;
  qualityReference?: string | null;
  lineageReference?: string | null;
  status: string;                    // OPEN | UNDER_REVIEW | RESOLVED | WAIVED
  firstDetectedAt?: string;
  lastDetectedAt?: string;
  createdAt?: string;
  recommendation?: string;
  summary?: string;
}

export interface GovernanceEvidence {
  evidenceId: string;
  findingId: string;
  sourceType: string;
  sourceReference: string;
  sourceSnapshot?: string | null;
  observedValue?: string;
  expectedValue?: string | null;
  confidence: number;
  evaluatorVersion?: string;
  createdAt?: string;
}

export interface GovernanceReviewItem {
  findingId: string;
  datasetId: string;
  severity: string;
  confidence: number;
  summary?: string;
  queuedAt?: string;
  assignee?: string | null;
}

export interface GovernanceRuleResult {
  ruleId: string;
  passed: string;
  resultCount: number;
  detail?: string;
  evaluatedAt?: string;
}

export interface GovernanceRun {
  runId: string;
  datasetId: string;
  datasetLayer?: string;
  snapshotId?: string | null;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  rulesExecuted?: number;
  findingsCreated?: number;
  findingsReopened?: number;
  error?: string | null;
  ruleResults?: GovernanceRuleResult[];
}

// -- CDXR on-demand training assessment (training-data suitability) ----

export interface TrainingWindow {
  start: string;
  end: string;
}

export interface ValidationStrategy {
  type: "random" | "time" | "group";
  field?: string;
  cutoff?: string;
}

export interface TrainingAssessmentRequest {
  datasetId: string;
  targetField: string;
  featureFields: string[];
  snapshotId?: number;
  purpose?: "model_training";
  entityIdFields?: string[];
  predictionTimeField?: string;
  labelTimeField?: string;
  trainingWindow?: TrainingWindow;
  validationStrategy?: ValidationStrategy;
  sensitiveFieldPolicy?: "block" | "review" | "allow";
}

export type TrainingAssessmentStatus = "ALLOW" | "REVIEW" | "BLOCK" | "INSUFFICIENT_EVIDENCE";

export interface TrainingAssessmentFinding {
  code: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  field?: string | null;
  relatedFields?: string[] | null;
  message: string;
  observed?: string | null;
  expected?: string | null;
  evidenceReference?: string | null;
  recommendation?: string | null;
}

export interface TrainingAssessmentResult {
  assessmentId: string;
  datasetId: string;
  snapshotId?: number | null;
  purpose: string;
  status: TrainingAssessmentStatus;
  summary: string;
  checkedFields: string[];
  ruleVersion: string;
  checkedAt: string;
  rawRowsReturned: boolean;
  warnings: string[];
  findings: TrainingAssessmentFinding[];
}

export class GatewayError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = "GatewayError";
  }
}

export class GatewayUnavailableError extends GatewayError {
  constructor(baseUrl: string, cause?: unknown) {
    super(`lakehouse gateway unavailable at ${baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "GatewayUnavailableError";
  }
}

export class GatewayClient {
  private readonly config: GatewayConfig;
  constructor(config: GatewayConfig) {
    this.config = config;
  }

  async health(): Promise<{ status: string; datasets: number; mode: string }> {
    return this._get("/health");
  }

  async searchCatalog(q = "", layer?: string, limit = 50): Promise<{ results: DatasetInfo[]; count: number }> {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (layer) params.set("layer", layer);
    params.set("limit", String(limit));
    return this._get(`/v1/catalog/search?${params.toString()}`);
  }

  async inspectDataset(datasetId: string): Promise<DatasetInfo> {
    return this._get(`/v1/datasets/${encodeURIComponent(datasetId)}`);
  }

  async validateQuery(plan: QueryPlan): Promise<ValidationResult> {
    return this._post("/v1/query/validate", plan);
  }

  async materializeQuery(validatedQueryId: string, fmt = "parquet"): Promise<{
    artifactId: string; queryId: string; datasetId: string;
    rowCount: number; contentHash: string; format: string;
  }> {
    return this._post("/v1/query/materialize", { validatedQueryId, format: fmt });
  }

  async executeQuery(validatedQueryId: string): Promise<QueryResult> {
    return this._post("/v1/query/execute", { validatedQueryId });
  }

  async getQuality(datasetId: string): Promise<QualityResult> {
    return this._get(`/v1/quality/${encodeURIComponent(datasetId)}`);
  }

  async explainLineage(datasetId: string): Promise<LineageResult> {
    return this._get(`/v1/lineage/${encodeURIComponent(datasetId)}`);
  }

  async getSnapshots(datasetId: string): Promise<{ datasetId: string; snapshots: SnapshotInfo[]; count: number }> {
    return this._get(`/v1/snapshots/${encodeURIComponent(datasetId)}`);
  }

  // -- governance (read-only CDXR plane) -------------------------------

  async getGovernanceProfile(datasetId: string): Promise<GovernanceProfile> {
    return this._get(`/v1/governance/cdxr/datasets/${encodeURIComponent(datasetId)}/profile`);
  }

  async listGovernanceFindings(opts: {
    datasetId?: string; severity?: string; status?: string; ruleId?: string; limit?: number;
  } = {}): Promise<{ count: number; findings: GovernanceFinding[] }> {
    const params = new URLSearchParams();
    if (opts.datasetId) params.set("dataset_id", opts.datasetId);
    if (opts.severity) params.set("severity", opts.severity);
    if (opts.status) params.set("status", opts.status);
    if (opts.ruleId) params.set("rule_id", opts.ruleId);
    params.set("limit", String(opts.limit ?? 100));
    return this._get(`/v1/governance/cdxr/findings?${params.toString()}`);
  }

  async getGovernanceFinding(findingId: string): Promise<GovernanceFinding> {
    return this._get(`/v1/governance/cdxr/findings/${encodeURIComponent(findingId)}`);
  }

  async getGovernanceEvidence(findingId: string): Promise<{ findingId: string; count: number; evidence: GovernanceEvidence[] }> {
    return this._get(`/v1/governance/cdxr/findings/${encodeURIComponent(findingId)}/evidence`);
  }

  async getGovernanceReviewStatus(datasetId?: string): Promise<{ count: number; items: GovernanceReviewItem[] }> {
    const params = new URLSearchParams();
    if (datasetId) params.set("dataset_id", datasetId);
    return this._get(`/v1/governance/cdxr/review-queue${params.toString() ? `?${params.toString()}` : ""}`);
  }

  async getGovernanceRun(runId: string): Promise<GovernanceRun> {
    return this._get(`/v1/governance/cdxr/runs/${encodeURIComponent(runId)}`);
  }

  // -- CDXR training assessment (on-demand, read-only) -----------------

  async assessTrainingData(request: TrainingAssessmentRequest): Promise<TrainingAssessmentResult> {
    return this._post("/v1/cdxr/training-assessments", request);
  }

  // -- internals ------------------------------------------------------

  private async _request(method: string, path: string, body?: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    const headers: Record<string, string> = body !== undefined ? { "content-type": "application/json" } : {};
    if (this.config.clientId) headers["x-client-id"] = this.config.clientId;
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      throw new GatewayUnavailableError(this.config.baseUrl, error);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let detail = "";
      try {
        const json: any = await response.json();
        detail = typeof json.detail === "string" ? json.detail : JSON.stringify(json);
      } catch {
        detail = await response.text().catch(() => "");
      }
      throw new GatewayError(`gateway ${response.status}: ${detail}`, response.status);
    }
    return response.json();
  }

  private _get(path: string): Promise<any> {
    return this._request("GET", path);
  }

  private _post(path: string, body: unknown): Promise<any> {
    return this._request("POST", path, body);
  }
}

/** Build a client from env, or null when LAKEHOUSE_GATEWAY_URL is unset. */
export function gatewayClientFromEnv(): GatewayClient | null {
  const baseUrl = process.env.LAKEHOUSE_GATEWAY_URL;
  if (!baseUrl) return null;
  return new GatewayClient({
    baseUrl,
    timeoutMs: Number(process.env.LAKEHOUSE_GATEWAY_TIMEOUT_MS ?? 30_000),
    clientId: process.env.LAKEHOUSE_CLIENT_ID ?? undefined,
  });
}
