/**
 * Input resolver — resolves AnalysisDataRef against the trusted Artifact
 * Registry, validates schema/columns, and answers DATA_INPUT_REQUIRED when
 * inputs are insufficient. Never accepts arbitrary filesystem paths.
 */
import { createHash } from "node:crypto";
import type {
  AnalysisDataRef,
  DataAnalysisRequest,
  MetricDefinition,
} from "./contracts.ts";

export interface ResolvedAnalysisInput {
  dataRefs: Array<AnalysisDataRef & { resolvedPath?: string }>;
  columns: string[];
  rowCount: number;
  missing: string[];
  messages: string[];
}

export interface ArtifactResolver {
  resolveArtifact(artifactId: string): Promise<{
    path: string;
    contentType: string;
    meta: Record<string, unknown>;
  } | null>;
}

export const ARTIFACT_ID_RE = /^art_[a-z0-9]{16}$/;

/** Deterministic artifact id for a materialized query. */
export function newArtifactId(source: string): string {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `art_${hash}`;
}

export function checkForbiddenRequest(request: DataAnalysisRequest): string | null {
  const text = JSON.stringify(request);
  // Raw SQL statements.
  if (/\b(select|insert|update|delete|drop|create|alter|truncate|grant)\b[\s\S]{0,120}\b(from|into|table|set|values|database|view|index)\b/i.test(text)) {
    return "request contains a raw SQL statement";
  }
  // Executable code / credentials / connection strings / absolute paths.
  if (/[\s\S]*(?:import\s+(?:os|subprocess|socket|requests)|os\.system|subprocess\.|eval\(|exec\(|__import__)/i.test(text)) {
    return "request contains executable code";
  }
  if (/(?:password|secret|api[_-]?key|token)\s*[:=]/i.test(text)) {
    return "request contains credential-like fields";
  }
  if (/(?:jdbc|postgresql|mysql|sqlite|mongodb|redshift|bigquery):\/\//i.test(text)) {
    return "request contains a database connection string";
  }
  if (/(?:[a-zA-Z]:[\\/]|\/Users\/|\/home\/|\/tmp\/|\/var\/|\/etc\/|\/opt\/)/.test(text)) {
    return "request contains an absolute filesystem path";
  }
  return null;
}

export async function resolveAnalysisInput(
  request: DataAnalysisRequest,
  resolver: ArtifactResolver,
): Promise<ResolvedAnalysisInput> {
  const missing: string[] = [];
  const messages: string[] = [];

  if (!request.objective?.trim()) missing.push("objective");
  if (!request.dataRefs || request.dataRefs.length === 0) missing.push("dataRefs");
  if (!request.analysisType) missing.push("analysisType");

  const dataRefs: Array<AnalysisDataRef & { resolvedPath?: string }> = [];
  const columns = new Set<string>();
  let rowCount = 0;

  for (const ref of request.dataRefs ?? []) {
    if (!ARTIFACT_ID_RE.test(ref.artifactId)) {
      missing.push(`dataRef artifactId ${ref.artifactId} (untrusted)`);
      continue;
    }
    const resolved = await resolver.resolveArtifact(ref.artifactId);
    if (!resolved) {
      missing.push(`dataRef artifact ${ref.artifactId}`);
      continue;
    }
    const allowed = ref.allowedColumns ?? [];
    if (allowed.length > 0) {
      const schemaNames = (ref.schema ?? []).map((s) => s.name);
      const bad = allowed.filter((c) => !schemaNames.includes(c));
      if (bad.length > 0) {
        messages.push(`allowedColumns not in schema: ${bad.join(", ")}`);
      }
      for (const c of allowed) columns.add(c);
    } else {
      for (const s of ref.schema ?? []) columns.add(s.name);
    }
    rowCount = Math.max(rowCount, ref.rowCount ?? 0);
    dataRefs.push({ ...ref, resolvedPath: resolved.path });
  }

  if (dataRefs.length === 0) missing.push("dataRefs (none resolvable)");

  // If dimensions are requested they must exist in the schema.
  for (const dim of request.dimensions ?? []) {
    if (columns.size > 0 && !columns.has(dim)) missing.push(`dimension '${dim}'`);
  }
  if (request.timeField && columns.size > 0 && !columns.has(request.timeField)) {
    missing.push(`timeField '${request.timeField}'`);
  }

  // Metric definitions must reference a column or be pure expressions.
  for (const m of request.metricDefinitions ?? []) {
    const valid = m.expression !== undefined || columns.has(m.metricId);
    if (!valid) missing.push(`metric '${m.metricId}' (no column/expression)`);
  }

  return { dataRefs, columns: [...columns], rowCount, missing, messages };
}

export function metricDefinitionsSummary(metrics: MetricDefinition[] | undefined): string {
  return (metrics ?? []).map((m) => `${m.metricId}${m.label ? ` (${m.label})` : ""}`).join(", ");
}
