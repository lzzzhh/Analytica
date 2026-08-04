/**
 * Lakehouse data tools for Pi Agent (spec §6: controlled tools).
 *
 * NO raw SQL surface: the agent may search the catalog, inspect datasets,
 * validate a structured QueryPlan, and execute BY validatedQueryId only.
 *
 * Registration is feature-driven: the tool list is built from the feature
 * resolver (round2.* + round3.cdxr_training) at module load. Disabled tools
 * simply do not appear — this module never reads feature env vars directly
 * (single source of truth: src/features/resolver.ts + registry.json).
 * LAKEHOUSE_GATEWAY_URL only configures the connection; it never gates
 * registration.
 */
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "../../../../../src/core/extensions/types.ts";
import type { FeatureId } from "../features/types.ts";
import { getDefaultFeatureResolver } from "../features/resolver.ts";
import { gatewayClientFromEnv, type GatewayClient } from "./client.ts";
import { queryResultToFacts, queryResultSummary } from "./evidence-adapter.ts";
import { INSPECT_REVIEW_GATE_TOOL } from "../reviewer/gate/tool.ts";
import type { EvidenceFact } from "../evidence.ts";

function client(): GatewayClient | null {
  return gatewayClientFromEnv();
}

function notConfigured(toolName: string): AgentToolResult<unknown> {
  return {
    content: [{
      type: "text",
      text: `${toolName}: LAKEHOUSE_GATEWAY_URL is not set — lakehouse data source is not configured. ` +
        "The multimodal tools (parse_image / parse_document / analyze_document) are unaffected.",
    }],
    details: { tool: toolName, configured: false },
  };
}

// ---------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------

const SearchCatalogSchema = Type.Object({
  q: Type.Optional(Type.String({ description: "search term (dataset id / name / description)" })),
  layer: Type.Optional(Type.Union(
    [Type.Literal("ODS"), Type.Literal("DWD"), Type.Literal("DWS"), Type.Literal("ADS")],
    { description: "filter by warehouse layer" },
  )),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});
type SearchCatalogParams = Static<typeof SearchCatalogSchema>;

const InspectDatasetSchema = Type.Object({
  datasetId: Type.String({ description: "dataset id from the catalog" }),
});
type InspectDatasetParams = Static<typeof InspectDatasetSchema>;

const SelectFieldSchema = Type.Object({
  field: Type.String(),
  aggregation: Type.Optional(Type.Union(
    [Type.Literal("sum"), Type.Literal("count"), Type.Literal("avg"), Type.Literal("min"), Type.Literal("max")],
  )),
  alias: Type.Optional(Type.String()),
});

const FilterConditionSchema = Type.Object({
  field: Type.String(),
  operator: Type.Union([
    Type.Literal("eq"), Type.Literal("neq"), Type.Literal("gt"), Type.Literal("gte"),
    Type.Literal("lt"), Type.Literal("lte"), Type.Literal("between"), Type.Literal("in"),
    Type.Literal("is_null"), Type.Literal("is_not_null"),
  ]),
  value: Type.Optional(Type.Any()),
});

const QueryPlanSchema = Type.Object({
  datasetId: Type.String({ description: "dataset id from the catalog" }),
  select: Type.Array(SelectFieldSchema, {
    description: "fields to project; aggregation for grouped metrics (empty = raw columns)",
  }),
  dimensions: Type.Optional(Type.Array(Type.String(), { description: "group-by columns" })),
  filters: Type.Optional(Type.Array(FilterConditionSchema, {
    description: "bounded filters — partitioned datasets require a partition filter",
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
});
type QueryPlanParams = Static<typeof QueryPlanSchema>;

const ExecuteQuerySchema = Type.Object({
  validatedQueryId: Type.String({ description: "id returned by validate_query — never pass raw SQL" }),
});
type ExecuteQueryParams = Static<typeof ExecuteQuerySchema>;

const DatasetIdSchema = Type.Object({
  datasetId: Type.String({ description: "dataset id from the catalog" }),
});
type DatasetIdParams = Static<typeof DatasetIdSchema>;

// ---------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------

export const SEARCH_CATALOG_TOOL: ToolDefinition<typeof SearchCatalogSchema, unknown> = {
  name: "search_catalog",
  label: "Search Lakehouse Catalog",
  description:
    "Search the lakehouse dataset catalog by name / description / layer. " +
    "Returns dataset ids, layers (ODS/DWD/DWS/ADS), table names, and field lists. " +
    "Call this FIRST to find the dataset id for a question.",
  promptSnippet: "search_catalog(q) — find lakehouse datasets",
  promptGuidelines: [
    "Before querying data, call search_catalog to find the right dataset id.",
    "Prefer ADS (aggregated) and DWS datasets; ODS is denied by default.",
    "Do not invent dataset ids — use ids returned by the catalog.",
  ],
  parameters: SearchCatalogSchema,

  async execute(
    _toolCallId: string,
    params: SearchCatalogParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("search_catalog");
    try {
      const result = await c.searchCatalog(params.q ?? "", params.layer, params.limit ?? 50);
      const lines = [`Catalog search "${params.q ?? ""}": ${result.count} dataset(s)`];
      for (const d of result.results) {
        lines.push(`- ${d.datasetId} [${d.layer}] ${d.displayName} (${d.tableName})`);
        lines.push(`    fields: ${d.fields.map((f) => f.name + (f.partition ? "*" : "")).join(", ") || "(unknown)"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    } catch (error) {
      return { content: [{ type: "text", text: `search_catalog failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

export const INSPECT_DATASET_TOOL: ToolDefinition<typeof InspectDatasetSchema, unknown> = {
  name: "inspect_dataset",
  label: "Inspect Dataset",
  description:
    "Inspect a dataset's schema: fields, types, partition columns, layer, " +
    "latest snapshot id and last update time. Use after search_catalog, " +
    "before building a query plan.",
  promptSnippet: "inspect_dataset(datasetId) — dataset schema + snapshot info",
  promptGuidelines: [
    "Check field names and types here before building a query plan.",
    "Note partition columns (marked *): plans must filter on them.",
  ],
  parameters: InspectDatasetSchema,

  async execute(
    _toolCallId: string,
    params: InspectDatasetParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("inspect_dataset");
    try {
      const d = await c.inspectDataset(params.datasetId);
      const lines = [
        `${d.datasetId} [${d.layer}] — ${d.tableName}`,
        `description: ${d.description}`,
        `snapshot: ${d.latestSnapshotId ?? "none"} | lastUpdated: ${d.lastUpdatedAt ?? "unknown"}`,
        "fields:",
        ...d.fields.map((f) => `  - ${f.name} (${f.type})${f.partition ? " [partition]" : ""}${f.sensitive ? " [sensitive]" : ""}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: d };
    } catch (error) {
      return { content: [{ type: "text", text: `inspect_dataset failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

export const VALIDATE_QUERY_TOOL: ToolDefinition<typeof QueryPlanSchema, unknown> = {
  name: "validate_query",
  label: "Validate Query Plan",
  description:
    "Validate a structured QueryPlan (NO raw SQL). Checks: dataset exists, " +
    "fields exist, limits, partition filters, ODS denial. " +
    "On success returns a validatedQueryId for execute_query. " +
    "Example plan: {\"datasetId\":\"ads_sales_daily\",\"select\":[{\"field\":\"revenue\",\"aggregation\":\"sum\",\"alias\":\"total\"}],\"dimensions\":[\"region\"],\"filters\":[{\"field\":\"event_date\",\"operator\":\"between\",\"value\":[\"2026-07-01\",\"2026-07-31\"]}],\"limit\":100}",
  promptSnippet: "validate_query(plan) — get a validatedQueryId",
  promptGuidelines: [
    "Always validate before executing. Never pass SQL.",
    "If validation fails, read the issues and fix the plan (field names, filters).",
    "Partitioned datasets need a filter on the partition column; ODS is denied.",
  ],
  parameters: QueryPlanSchema,

  async execute(
    _toolCallId: string,
    params: QueryPlanParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("validate_query");
    try {
      const v = await c.validateQuery({
        datasetId: params.datasetId,
        select: params.select,
        dimensions: params.dimensions ?? [],
        filters: params.filters ?? [],
        limit: params.limit ?? 100,
      });
      if (!v.ok) {
        const lines = ["Query plan rejected:"];
        for (const i of v.issues) lines.push(`- [${i.code}] ${i.message}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: v };
      }
      return {
        content: [{
          type: "text",
          text: `Query plan OK. validatedQueryId=${v.validatedQueryId} (valid ~10 min). Use execute_query with this id.`,
        }],
        details: v,
      };
    } catch (error) {
      return { content: [{ type: "text", text: `validate_query failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

export const EXECUTE_QUERY_TOOL: ToolDefinition<typeof ExecuteQuerySchema, unknown> = {
  name: "execute_query",
  label: "Execute Validated Query",
  description:
    "Execute a previously VALIDATED query by validatedQueryId (from validate_query). " +
    "Returns the result with queryId, snapshot/dataVersion, qualityStatus and lineage " +
    "reference. Sensitive fields are masked; large results return a summary.",
  promptSnippet: "execute_query(validatedQueryId) — run a validated plan",
  promptGuidelines: [
    "Only use ids returned by validate_query.",
    "Report queryId + snapshot + qualityStatus in your answer when citing data.",
    "Do not fabricate numbers; if the result is empty say so.",
  ],
  parameters: ExecuteQuerySchema,

  async execute(
    _toolCallId: string,
    params: ExecuteQueryParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("execute_query");
    try {
      const result = await c.executeQuery(params.validatedQueryId);
      // Feature-driven Evidence gating (round2.query_evidence / lineage /
      // data_quality): results may still be returned, but disabled sources
      // never become EvidenceFacts and leave no trace in the summary.
      const features = getDefaultFeatureResolver();
      let facts: ReturnType<typeof queryResultToFacts> = [];
      let includeLineage = true;
      let includeQuality = true;
      if (features.isEffective("round2.query_evidence")) {
        facts = queryResultToFacts(result);
        includeLineage = features.isEffective("round2.lineage");
        includeQuality = features.isEffective("round2.data_quality");
        if (!includeLineage) {
          facts = facts.map(({ metadata, ...f }) => {
            const { lineageReference: _drop, ...rest } = metadata ?? {};
            void _drop;
            return { ...f, metadata: rest as EvidenceFact["metadata"] };
          });
        }
        if (!includeQuality) {
          facts = facts.map(({ metadata, ...f }) => {
            const { qualityStatus: _drop, ...rest } = metadata ?? {};
            void _drop;
            return { ...f, metadata: rest as EvidenceFact["metadata"] };
          });
        }
      }
      const summary = queryResultSummary(result, { includeLineage, includeQuality });
      return { content: [{ type: "text", text: summary }], details: { result, facts } };
    } catch (error) {
      return { content: [{ type: "text", text: `execute_query failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};


const MaterializeQuerySchema = Type.Object({
  validatedQueryId: Type.String({ description: "id returned by validate_query" }),
  format: Type.Optional(Type.Union([Type.Literal("parquet"), Type.Literal("arrow")], { description: "artifact format" })),
});
type MaterializeQueryParams = Static<typeof MaterializeQuerySchema>;
export const MATERIALIZE_QUERY_TOOL: ToolDefinition<typeof MaterializeQuerySchema, unknown> = {
  name: "materialize_query",
  label: "Materialize Query",
  description:
    "Materialize a VALIDATED query into an immutable analysis artifact " +
    "(parquet/arrow) in the trusted artifact store. Returns metadata only " +
    "(artifactId, rowCount, contentHash) — never rows. The artifact can be " +
    "consumed by run_data_analysis.",
  promptSnippet: "materialize_query(validatedQueryId, format?) — freeze query results as a trusted artifact",
  promptGuidelines: [
    "Only materialize queries that were validated first (validatedQueryId).",
    "The artifactId is the input for run_data_analysis.",
  ],
  parameters: MaterializeQuerySchema,

  async execute(
    _toolCallId: string,
    params: MaterializeQueryParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("materialize_query");
    try {
      const meta = await c.materializeQuery(params.validatedQueryId, params.format ?? "parquet");
      const lines = [
        `materialized ${params.validatedQueryId} -> ${meta.artifactId}`,
        `  dataset: ${meta.datasetId} | rows: ${meta.rowCount} | format: ${meta.format}`,
        `  contentHash: ${meta.contentHash.slice(0, 16)}…`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: meta };
    } catch (error) {
      return { content: [{ type: "text", text: `materialize_query failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};
export const GET_DATA_QUALITY_TOOL: ToolDefinition<typeof DatasetIdSchema, unknown> = {
  name: "get_data_quality",
  label: "Data Quality",
  description:
    "Get deterministic data-quality status for a dataset: PASS/WARN/FAIL checks " +
    "(row count, missing rates) plus a profile (distinct counts, candidate keys, time columns).",
  promptSnippet: "get_data_quality(datasetId) — quality checks + profile",
  promptGuidelines: [
    "When a query result looks empty or sparse, check quality first.",
  ],
  parameters: DatasetIdSchema,

  async execute(
    _toolCallId: string,
    params: DatasetIdParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("get_data_quality");
    try {
      const q = await c.getQuality(params.datasetId);
      const lines = [`Quality of ${params.datasetId}: ${q.status}`];
      for (const check of q.checks) lines.push(`- [${check.status}] ${check.check}: ${check.detail}`);
      if (q.profile) {
        lines.push(`rows=${q.profile.rowCount} timeColumns=${q.profile.candidateTimeColumns.join(",") || "-"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: q };
    } catch (error) {
      return { content: [{ type: "text", text: `get_data_quality failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

export const EXPLAIN_LINEAGE_TOOL: ToolDefinition<typeof DatasetIdSchema, unknown> = {
  name: "explain_lineage",
  label: "Explain Lineage",
  description:
    "Explain a dataset's lineage: upstream sources (ODS/DWD/DWS chain) and downstream consumers.",
  promptSnippet: "explain_lineage(datasetId) — upstream + downstream",
  promptGuidelines: [
    "Use to explain where a dataset comes from.",
  ],
  parameters: DatasetIdSchema,

  async execute(
    _toolCallId: string,
    params: DatasetIdParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("explain_lineage");
    try {
      const l = await c.explainLineage(params.datasetId);
      const lines = [`Lineage of ${params.datasetId}`];
      lines.push("upstream:");
      for (const e of l.upstream) lines.push(`  - ${e.source} → ${e.target} (${e.kind})`);
      lines.push("downstream:");
      for (const e of l.downstream) lines.push(`  - ${e.source} → ${e.target} (${e.kind})`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: l };
    } catch (error) {
      return { content: [{ type: "text", text: `explain_lineage failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

export const GET_SNAPSHOT_TOOL: ToolDefinition<typeof DatasetIdSchema, unknown> = {
  name: "get_snapshot",
  label: "Get Snapshots",
  description:
    "List a dataset's Iceberg snapshots (id, timestamp, manifest) — newest first. " +
    "Use to report data freshness / latest snapshot.",
  promptSnippet: "get_snapshot(datasetId) — snapshot list",
  promptGuidelines: [
    "Report the latest snapshot id + timestamp as data version evidence.",
  ],
  parameters: DatasetIdSchema,

  async execute(
    _toolCallId: string,
    params: DatasetIdParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("get_snapshot");
    try {
      const s = await c.getSnapshots(params.datasetId);
      const lines = [`Snapshots of ${params.datasetId}: ${s.count}`];
      for (const snap of s.snapshots.slice(0, 10)) {
        const ts = new Date(snap.timestampMs).toISOString();
        lines.push(`- ${snap.snapshotId} @ ${ts}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: s };
    } catch (error) {
      return { content: [{ type: "text", text: `get_snapshot failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

// ---------------------------------------------------------------------
// CDXR governance tools (spec §10 — read-only, generic names)
// ---------------------------------------------------------------------

const GovernanceProfileSchema = Type.Object({
  datasetId: Type.String({ description: "dataset id from the catalog" }),
});
type GovernanceProfileParams = Static<typeof GovernanceProfileSchema>;

const ListFindingsSchema = Type.Object({
  datasetId: Type.Optional(Type.String()),
  severity: Type.Optional(Type.Union(
    [Type.Literal("INFO"), Type.Literal("LOW"), Type.Literal("MEDIUM"), Type.Literal("HIGH"), Type.Literal("CRITICAL")],
  )),
  status: Type.Optional(Type.Union(
    [Type.Literal("OPEN"), Type.Literal("UNDER_REVIEW"), Type.Literal("RESOLVED"), Type.Literal("WAIVED")],
  )),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
});
type ListFindingsParams = Static<typeof ListFindingsSchema>;

const FindingIdSchema = Type.Object({
  findingId: Type.String({ description: "governance finding id (fnd_...) from list_governance_findings" }),
});
type FindingIdParams = Static<typeof FindingIdSchema>;

const ReviewQueueSchema = Type.Object({
  datasetId: Type.Optional(Type.String()),
});
type ReviewQueueParams = Static<typeof ReviewQueueSchema>;

export const GET_GOVERNANCE_PROFILE_TOOL: ToolDefinition<typeof GovernanceProfileSchema, unknown> = {
  name: "get_dataset_governance_profile",
  label: "Dataset Governance Profile",
  description:
    "Read the ADS trust profile of a dataset: governanceScore, status " +
    "(TRUSTED/CONDITIONAL/UNTRUSTED), open finding count, highest severity, " +
    "dimension scores, quality + lineage references, finding ids. " +
    "Call this FIRST when asked whether a dataset is fit for analysis.",
  promptSnippet: "get_dataset_governance_profile(datasetId) — trust profile (score/status/findings)",
  promptGuidelines: [
    "Before answering 'is this dataset usable', read the governance profile.",
    "The profile references (never replaces) quality and lineage results.",
    "Return the score/status/open findings verbatim; do not smooth over HIGH/CRITICAL findings.",
  ],
  parameters: GovernanceProfileSchema,

  async execute(
    _toolCallId: string,
    params: GovernanceProfileParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("get_dataset_governance_profile");
    try {
      const p = await c.getGovernanceProfile(params.datasetId);
      const dims = Object.entries(p.dimensionScores ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");
      const warnings: string[] = [];
      if (p.status !== "TRUSTED") warnings.push(`governance status is ${p.status}`);
      if ((p.openFindingCount ?? 0) > 0) warnings.push(`${p.openFindingCount} open finding(s), highest ${p.highestSeverity}`);
      if (p.qualityStatus && p.qualityStatus !== "PASS") warnings.push(`quality status is ${p.qualityStatus}`);
      const lines = [
        `Governance profile ${p.datasetId}`,
        `  snapshotId=${p.snapshotId ?? "none"}`,
        `  governanceScore=${p.governanceScore} status=${p.status}`,
        `  openFindingCount=${p.openFindingCount ?? 0} highestSeverity=${p.highestSeverity ?? "INFO"}`,
        `  dimensionScores=${dims || "(none)"}`,
        `  qualityStatus=${p.qualityStatus ?? "?"}`,
        `  qualityReference=${p.qualityReference ?? "-"}`,
        `  lineageReference=${p.lineageReference ?? "-"}`,
        `  findingIds=${(p.findingIds ?? []).join(", ") || "(none)"}`,
        ...(warnings.length ? ["  warnings: " + warnings.join("; ")] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { profile: p, warnings } };
    } catch (error) {
      const msg = String(error);
      if (msg.includes("404")) {
        return { content: [{ type: "text", text: `get_dataset_governance_profile: CDXR 未配置或无治理结果 for ${params.datasetId}` }], details: { configured: false } };
      }
      return { content: [{ type: "text", text: `get_dataset_governance_profile failed: ${msg}` }], details: { error: msg } };
    }
  },
};

export const LIST_GOVERNANCE_FINDINGS_TOOL: ToolDefinition<typeof ListFindingsSchema, unknown> = {
  name: "list_governance_findings",
  label: "List Governance Findings",
  description:
    "List CDXR governance findings (optionally filtered by dataset/severity/status). " +
    "Each finding carries rule id, severity, confidence, reason codes, status, " +
    "and references to snapshot/quality/lineage. Deduplicated to the latest run.",
  promptSnippet: "list_governance_findings(datasetId, severity?, status?) — findings list",
  promptGuidelines: [
    "Drill down from the governance profile to findings when open count > 0.",
    "Findings are deterministic; do not override their status.",
  ],
  parameters: ListFindingsSchema,

  async execute(
    _toolCallId: string,
    params: ListFindingsParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("list_governance_findings");
    try {
      const res = await c.listGovernanceFindings({
        datasetId: params.datasetId, severity: params.severity,
        status: params.status, limit: params.limit ?? 100,
      });
      const lines = [`Governance findings: ${res.count}`, "  id | rule | severity | status | confidence | summary"];
      for (const f of res.findings) {
        lines.push(`  ${f.findingId} | ${f.ruleId} | ${f.severity} | ${f.status} | ${f.confidence} | ${f.summary ?? ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: res };
    } catch (error) {
      return { content: [{ type: "text", text: `list_governance_findings failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

export const INSPECT_GOVERNANCE_FINDING_TOOL: ToolDefinition<typeof FindingIdSchema, unknown> = {
  name: "inspect_governance_finding",
  label: "Inspect Governance Finding",
  description:
    "Inspect one governance finding in detail: reason codes, evidence references, " +
    "snapshot/data version, quality + lineage references, recommendation.",
  promptSnippet: "inspect_governance_finding(findingId) — finding detail",
  promptGuidelines: [
    "Use after list_governance_findings to understand a specific finding.",
  ],
  parameters: FindingIdSchema,

  async execute(
    _toolCallId: string,
    params: FindingIdParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("inspect_governance_finding");
    try {
      const f = await c.getGovernanceFinding(params.findingId);
      const lines = [
        `Finding ${f.findingId}`,
        `  dataset=${f.datasetId} rule=${f.ruleId} field=${f.fieldName ?? "-"}`,
        `  severity=${f.severity} status=${f.status} confidence=${f.confidence} riskType=${f.riskType ?? "-"}`,
        `  reasonCodes=${(f.reasonCodes ?? []).join(", ") || "-"}`,
        `  snapshotId=${f.snapshotId ?? "-"} dataVersion=${f.dataVersion ?? "-"}`,
        `  qualityReference=${f.qualityReference ?? "-"}`,
        `  lineageReference=${f.lineageReference ?? "-"}`,
        `  firstDetectedAt=${f.firstDetectedAt ?? "-"} lastDetectedAt=${f.lastDetectedAt ?? "-"}`,
        `  recommendation=${f.recommendation ?? "-"}`,
        `  summary=${f.summary ?? ""}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: f };
    } catch (error) {
      return { content: [{ type: "text", text: `inspect_governance_finding failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

export const EXPLAIN_GOVERNANCE_EVIDENCE_TOOL: ToolDefinition<typeof FindingIdSchema, unknown> = {
  name: "explain_governance_evidence",
  label: "Explain Governance Evidence",
  description:
    "List the deterministic evidence attached to a governance finding " +
    "(source type, reference, snapshot, observed vs expected value, evaluator version).",
  promptSnippet: "explain_governance_evidence(findingId) — evidence for a finding",
  promptGuidelines: [
    "Evidence is deterministic; quote observed vs expected values verbatim.",
  ],
  parameters: FindingIdSchema,

  async execute(
    _toolCallId: string,
    params: FindingIdParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("explain_governance_evidence");
    try {
      const res = await c.getGovernanceEvidence(params.findingId);
      const lines = [`Evidence for finding ${params.findingId}: ${res.count}`];
      for (const e of res.evidence) {
        lines.push(`  [${e.sourceType}] ${e.sourceReference} snapshot=${e.sourceSnapshot ?? "-"} confidence=${e.confidence}`);
        lines.push(`    observed=${e.observedValue ?? "-"} expected=${e.expectedValue ?? "-"} evaluator=${e.evaluatorVersion ?? "-"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: res };
    } catch (error) {
      return { content: [{ type: "text", text: `explain_governance_evidence failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

export const GET_GOVERNANCE_REVIEW_STATUS_TOOL: ToolDefinition<typeof ReviewQueueSchema, unknown> = {
  name: "get_governance_review_status",
  label: "Governance Review Status",
  description:
    "Read the governance review queue: findings awaiting human review, their " +
    "severity, confidence and summary. Read-only — the agent cannot close, " +
    "waive or modify any finding (write path requires human confirmation).",
  promptSnippet: "get_governance_review_status(datasetId?) — items awaiting review",
  promptGuidelines: [
    "Never mark findings resolved/waived yourself — that is a human action.",
    "Surface items from this queue as 'needs human review' in the answer.",
  ],
  parameters: ReviewQueueSchema,

  async execute(
    _toolCallId: string,
    params: ReviewQueueParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("get_governance_review_status");
    try {
      const res = await c.getGovernanceReviewStatus(params.datasetId);
      const lines = [`Governance review queue: ${res.count} item(s) awaiting human review`];
      for (const it of res.items) {
        lines.push(`  ${it.findingId} [${it.severity}] ${it.datasetId} conf=${it.confidence} — ${it.summary ?? ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: res };
    } catch (error) {
      return { content: [{ type: "text", text: `get_governance_review_status failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

// ---------------------------------------------------------------------
// CDXR on-demand training assessment (opt-in; off by default)
// ---------------------------------------------------------------------

const TrainingWindowSchema = Type.Object({
  start: Type.String({ description: "training window start (ISO date)" }),
  end: Type.String({ description: "training window end (ISO date)" }),
});

const ValidationStrategySchema = Type.Object({
  type: Type.Union(
    [Type.Literal("random"), Type.Literal("time"), Type.Literal("group")],
    { description: "train/validation split strategy" },
  ),
  field: Type.Optional(Type.String({ description: "split field (time/group)" })),
  cutoff: Type.Optional(Type.String({ description: "split boundary (time, ISO date)" })),
});

const TrainingAssessmentSchema = Type.Object({
  datasetId: Type.String({ description: "dataset id from the catalog" }),
  targetField: Type.String({ description: "label/target field to be predicted" }),
  featureFields: Type.Array(Type.String(), {
    description: "candidate feature fields (must not include the target)",
    minItems: 1,
  }),
  snapshotId: Type.Optional(Type.Integer({ description: "optional snapshot id to assess (default: latest)" })),
  purpose: Type.Optional(Type.Literal("model_training", { default: "model_training" })),
  entityIdFields: Type.Optional(Type.Array(Type.String(), {
    description: "entity identity fields (for group-based validation checks)",
  })),
  predictionTimeField: Type.Optional(Type.String({
    description: "field holding the prediction/business time — required for future-information leakage checks",
  })),
  labelTimeField: Type.Optional(Type.String({ description: "field holding the label time" })),
  trainingWindow: Type.Optional(TrainingWindowSchema),
  validationStrategy: Type.Optional(ValidationStrategySchema),
  sensitiveFieldPolicy: Type.Optional(Type.Union(
    [Type.Literal("block"), Type.Literal("review"), Type.Literal("allow")],
    { default: "review" },
  )),
});
type TrainingAssessmentParams = Static<typeof TrainingAssessmentSchema>;

export const ASSESS_TRAINING_DATA_TOOL: ToolDefinition<typeof TrainingAssessmentSchema, unknown> = {
  name: "assess_training_data",
  label: "Assess Training Data",
  description:
    "On-demand suitability check of a dataset (or snapshot) for model training: " +
    "returns a deterministic verdict (ALLOW/REVIEW/BLOCK/INSUFFICIENT_EVIDENCE) with " +
    "rule findings for target leakage, future-information leakage, sensitive fields, " +
    "label distribution, sample size, missingness, constant features, validation " +
    "split sanity and traceability. Constraints: it is NOT a general query tool, it " +
    "does NOT train or modify any model, it writes NO data and grants NO waivers, and " +
    "it returns NO raw rows (aggregates only).",
  promptSnippet: "assess_training_data(datasetId, targetField, featureFields, predictionTimeField?) — on-demand training-data suitability verdict",
  promptGuidelines: [
    "Use ONLY when the user asks whether data is fit for model training — never for ordinary analysis queries.",
    "Report the status and findings verbatim; a REVIEW/BLOCK verdict needs human follow-up.",
    "This tool never waives findings and never returns raw data rows.",
  ],
  parameters: TrainingAssessmentSchema,

  async execute(
    _toolCallId: string,
    params: TrainingAssessmentParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const c = client();
    if (!c) return notConfigured("assess_training_data");
    try {
      const res = await c.assessTrainingData({
        datasetId: params.datasetId,
        targetField: params.targetField,
        featureFields: params.featureFields,
        snapshotId: params.snapshotId,
        purpose: params.purpose ?? "model_training",
        entityIdFields: params.entityIdFields,
        predictionTimeField: params.predictionTimeField,
        labelTimeField: params.labelTimeField,
        trainingWindow: params.trainingWindow,
        validationStrategy: params.validationStrategy,
        sensitiveFieldPolicy: params.sensitiveFieldPolicy ?? "review",
      });
      // bounded summary output — status + findings only, never raw rows
      const lines = [
        `Training assessment ${res.assessmentId}: ${res.status} (ruleVersion ${res.ruleVersion})`,
        `  dataset=${res.datasetId} snapshot=${res.snapshotId ?? "latest"} purpose=${res.purpose}`,
        `  checkedFields=${res.checkedFields.join(", ")}`,
        `  summary: ${res.summary}`,
      ];
      for (const f of res.findings) {
        lines.push(`  [${f.severity}] ${f.code}${f.field ? ` (${f.field})` : ""}: ${f.message}`);
      }
      for (const w of res.warnings) {
        lines.push(`  warning: ${w}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: res };
    } catch (error) {
      return { content: [{ type: "text", text: `assess_training_data failed: ${String(error)}` }], details: { error: String(error) } };
    }
  },
};

// ---------------------------------------------------------------------
// Tool registry (feature-driven — built at module load)
// ---------------------------------------------------------------------

/** Tool → feature mapping: the ONLY place that decides which feature gates
 *  which tool. Disabled tools are not registered at all (they disappear from
 *  the agent tool registry, never "registered but returning disabled"). */
export const DATA_TOOL_FEATURES: Array<[ToolDefinition<any, any, any>, FeatureId]> = [
  [SEARCH_CATALOG_TOOL, "round2.catalog_tools"],
  [INSPECT_DATASET_TOOL, "round2.catalog_tools"],
  [VALIDATE_QUERY_TOOL, "round2.query_tools"],
  [EXECUTE_QUERY_TOOL, "round2.query_tools"],
  [GET_DATA_QUALITY_TOOL, "round2.data_quality"],
  [EXPLAIN_LINEAGE_TOOL, "round2.lineage"],
  [GET_SNAPSHOT_TOOL, "round2.snapshot"],
  [ASSESS_TRAINING_DATA_TOOL, "round3.cdxr_training"],
  [MATERIALIZE_QUERY_TOOL, "round4.analysis_input_materialization"],
  [INSPECT_REVIEW_GATE_TOOL, "round5.deterministic_review_gates"],
];

const _features = getDefaultFeatureResolver();

/** Compatibility alias (resolver-backed): true when round3.cdxr_training is
 *  effective. Honors the legacy ENABLE_CDXR_TRAINING_TOOL env alias centrally
 *  in src/features/resolver.ts. */
export const CDXR_TRAINING_TOOL_ENABLED = _features.isEffective("round3.cdxr_training");

/** Tools whose feature is effective (round2.lakehouse + children, and
 *  round3.cdxr_training which depends on the lakehouse adapter). The legacy
 *  CDXR governance tools (get_dataset_governance_profile etc.) are
 *  intentionally NOT part of this registry — their code and client methods
 *  remain for read-only compatibility (legacy.cdxr_governance_tools), but
 *  the agent never sees a governance plane by default. */
export const DATA_TOOLS = DATA_TOOL_FEATURES
  .filter(([, featureId]) => _features.isEffective(featureId))
  .map(([tool]) => tool);
