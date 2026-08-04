/**
 * Query result → Evidence Packet adapter (spec §9) + governance adapter (§11).
 *
 * Query-backed facts become EvidenceFact with kind="query" and provenance
 * metadata (datasetId / snapshotId / dataVersion / dataTimestamp /
 * qualityStatus / queryId / lineageReference). Conflicts between query facts
 * and document facts are surfaced by the deterministic merger (different
 * values for the same claim → requires_verification), never auto-resolved.
 *
 * Governance-backed facts use kind="governance" with finding/rule/severity
 * metadata; priority order is query/parse > governance > cited > inferred.
 */
import type { EvidenceFact, EvidenceSourceType, GovernanceFactMetadata } from "../evidence.ts";
import type { GovernanceFinding, GovernanceProfile, QueryResult } from "./client.ts";

export interface QueryFactOptions {
  /** How the fact is framed in the evidence packet */
  claimPrefix?: string;
}

/** Options for the textual summary — used by feature-gated tools so that
 *  disabled sub-features (data_quality / lineage) leave no trace in the
 *  agent-facing text either. */
export interface QuerySummaryOptions {
  includeQuality?: boolean;
  includeLineage?: boolean;
}

/** Build EvidenceFacts from a query result — one fact per row.
 *  Aggregated/grouped results: claim = "<dimension values>: <column label>". */
export function queryResultToFacts(result: QueryResult, opts: QueryFactOptions = {}): EvidenceFact[] {
  const prefix = opts.claimPrefix ?? "";
  const facts: EvidenceFact[] = [];

  for (const row of result.rows) {
    const dimensionParts: string[] = [];
    const valueParts: string[] = [];

    for (let i = 0; i < result.columns.length; i++) {
      const col = result.columns[i]!;
      const value = row[i];
      if (value === null || value === undefined) continue;
      dimensionParts.push(`${col}: ${String(value)}`);
      valueParts.push(String(value));
    }

    // Deterministic result → confidence 1; query source, not a model guess
    const claim = dimensionParts.length
      ? `${prefix}${dimensionParts.join(", ")}`
      : `${prefix}${result.datasetId} result`;

    facts.push({
      claim,
      value: valueParts.join(", "),
      evidence: `query:${result.queryId}`,
      confidence: 1,
      kind: "query",
      metadata: {
        datasetId: result.datasetId,
        snapshotId: result.snapshotId ?? undefined,
        dataVersion: result.dataVersion,
        dataTimestamp: result.dataTimestamp,
        qualityStatus: result.qualityStatus,
        queryId: result.queryId,
        lineageReference: result.lineageReference,
      },
    });
  }

  return facts;
}

/** A compact textual summary for the agent context (spec §8: agent context
 *  receives a summary, not the raw result). */
export function queryResultSummary(result: QueryResult, opts: QuerySummaryOptions = {}): string {
  const includeQuality = opts.includeQuality ?? true;
  const includeLineage = opts.includeLineage ?? true;
  const lines: string[] = [];
  lines.push(`Query ${result.queryId} on ${result.datasetId} (${result.datasetLayer}) — ${result.rowCount} row(s)`);
  lines.push(`dataVersion=${result.dataVersion} snapshot=${result.snapshotId ?? "none"} timestamp=${result.dataTimestamp}`);
  if (includeQuality) lines.push(`qualityStatus=${result.qualityStatus}`);
  if (includeLineage) lines.push(`lineage=${result.lineageReference}`);
  if (result.warnings.length) lines.push(`warnings: ${result.warnings.join("; ")}`);
  if (result.truncated) lines.push(`NOTE: result spilled to ${result.artifactId}; only a summary is shown.`);
  lines.push("columns: " + result.columns.join(", "));
  for (const row of result.rows.slice(0, 20)) {
    lines.push("  " + row.map((v) => (v === null ? "null" : String(v))).join(" | "));
  }
  if (result.rowCount > 20) lines.push(`  ... (${result.rowCount - 20} more rows)`);
  return lines.join("\n");
}

/** Map a gateway dataset layer to an evidence source type */
export function sourceTypeFor(kind: "query" | "quality" | "lineage" | "snapshot" | "governance"): EvidenceSourceType {
  return kind;
}

// ---------------------------------------------------------------------
// Governance → Evidence adapter (spec §11)
// ---------------------------------------------------------------------

/** Build EvidenceFacts from a governance trust profile (ADS level). */
export function governanceProfileToFacts(profile: GovernanceProfile): EvidenceFact[] {
  const facts: EvidenceFact[] = [];
  const base: GovernanceFactMetadata = {
    datasetId: profile.datasetId,
    snapshotId: profile.snapshotId ?? undefined,
    qualityStatus: profile.qualityStatus,
    qualityReference: profile.qualityReference ?? undefined,
    lineageReference: profile.lineageReference ?? undefined,
    governanceScore: profile.governanceScore,
    reviewStatus: profile.status,
    severity: profile.highestSeverity,
    evidenceReferences: profile.findingIds,
  };
  facts.push({
    claim: `${profile.datasetId} governance status`,
    value: profile.status,
    evidence: `governance:profile:${profile.datasetId}`,
    confidence: 1,
    kind: "governance",
    metadata: base,
  });
  facts.push({
    claim: `${profile.datasetId} governance score`,
    value: profile.governanceScore,
    evidence: `governance:profile:${profile.datasetId}`,
    confidence: 1,
    kind: "governance",
    metadata: base,
  });
  if (profile.openFindingCount > 0) {
    facts.push({
      claim: `${profile.datasetId} open governance findings`,
      value: profile.openFindingCount,
      evidence: `governance:profile:${profile.datasetId}`,
      confidence: 1,
      kind: "governance",
      metadata: base,
    });
  }
  return facts;
}

/** Build EvidenceFacts from governance findings (DWD level). */
export function governanceFindingsToFacts(findings: GovernanceFinding[]): EvidenceFact[] {
  return findings.map((f) => ({
    claim: `${f.datasetId} governance finding (${f.ruleId})`,
    value: f.severity,
    evidence: `governance:${f.findingId}`,
    confidence: f.confidence,
    kind: "governance" as const,
    metadata: {
      datasetId: f.datasetId,
      snapshotId: f.snapshotId ?? undefined,
      findingId: f.findingId,
      runId: f.runId,
      ruleId: f.ruleId,
      severity: f.severity,
      reviewStatus: f.status,
      qualityReference: f.qualityReference ?? undefined,
      lineageReference: f.lineageReference ?? undefined,
      evidenceReferences: f.evidenceReferences,
    } satisfies GovernanceFactMetadata,
  }));
}

/** Compact textual summary of a governance profile for the agent context. */
export function governanceProfileSummary(profile: GovernanceProfile): string {
  const dims = Object.entries(profile.dimensionScores ?? {})
    .map(([k, v]) => `${k}=${v}`).join(", ");
  const lines = [
    `Governance profile ${profile.datasetId} (snapshot ${profile.snapshotId ?? "none"})`,
    `  score=${profile.governanceScore} status=${profile.status} openFindings=${profile.openFindingCount} highest=${profile.highestSeverity}`,
    `  dimensions: ${dims || "(none)"}`,
    `  quality=${profile.qualityStatus ?? "?"} qualityRef=${profile.qualityReference ?? "-"}`,
    `  lineageRef=${profile.lineageReference ?? "-"}`,
    `  findings: ${profile.findingIds?.join(", ") || "(none)"}`,
  ];
  return lines.join("\n");
}
