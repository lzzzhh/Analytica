/** Shared fixtures for data analysis tests. */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/data-analysis/artifact-store.ts";
import type {
  AnalysisResultArtifact,
  DataAnalysisRequest,
} from "../src/data-analysis/contracts.ts";

export type FeatureSnapshotLike = {
  effectiveFeatures: string[];
};

export function fakeSnapshot(features: string[] = []): FeatureSnapshotLike {
  return { effectiveFeatures: features };
}

export function fakeStore(): ArtifactStore {
  const dir = mkdtempSync(join(tmpdir(), "da-store-"));
  const store = new ArtifactStore(dir);
  const data = JSON.stringify([
    { auc: 0.82, event_date: "2026-07-01", model_version: "v2" },
    { auc: 0.81, event_date: "2026-07-02", model_version: "v2" },
  ]);
  store.register(
    {
      artifactId: "art_aaaaaaaaaaaaaaaa",
      contentType: "application/json",
      rowCount: 2,
      columns: ["auc", "event_date", "model_version"],
      contentHash: createHash("sha256").update(data).digest("hex"),
      queryId: "q_1",
      snapshotId: "v1",
      masked: true,
      createdAt: new Date().toISOString(),
    },
    data,
  );
  return store;
}

export const SAMPLE_REQUEST: DataAnalysisRequest = {
  objective: "analyze the AUC trend over the last 30 days vs the previous 30 days",
  questions: ["is the trend up or down?"],
  analysisType: "PERIOD_COMPARISON",
  dataRefs: [
    {
      artifactId: "art_aaaaaaaaaaaaaaaa",
      sourceType: "LAKEHOUSE_QUERY",
      queryId: "q_1",
      snapshotId: "v1",
      format: "JSON",
      schema: [
        { name: "auc", type: "float" },
        { name: "event_date", type: "string" },
        { name: "model_version", type: "string" },
      ],
      rowCount: 100,
      allowedColumns: ["auc", "event_date", "model_version"],
      masked: true,
    },
  ],
  metricDefinitions: [
    { metricId: "auc", label: "AUC", valueType: "NUMBER", precision: 3 },
  ],
  dimensions: ["model_version"],
  timeField: "event_date",
  expectedViews: ["METRIC_CARDS", "LINE_CHART", "TABLE"],
  constraints: { maxAttempts: 2, timeoutSeconds: 30 },
};

export const SAMPLE_RESULT: AnalysisResultArtifact = {
  schemaVersion: "1.0",
  artifactId: "art_0123456789abcdef",
  runId: "run_test",
  status: "COMPLETED",
  title: "AUC trend analysis",
  sections: [
    {
      type: "METRIC_CARDS",
      metrics: [
        { metricId: "auc", label: "AUC (30d)", value: 918273.645, valueType: "NUMBER", precision: 3 },
      ],
    },
    {
      type: "TABLE",
      columns: [{ name: "period", type: "string" }, { name: "auc", type: "float" }],
      rows: [
        { period: "current", auc: 918273.645 },
        { period: "previous", auc: 0.8 },
      ],
      totalRows: 2,
      displayedRows: 2,
    },
    {
      type: "LINE_CHART",
      chartTitle: "AUC by day",
      x: "event_date",
      series: [{ name: "auc", points: [{ x: "2026-07-01", y: 918273.645 }] }],
    },
  ],
  reviewStatus: "NOT_REVIEWED",
  validationRefs: [],
  createdAt: new Date().toISOString(),
};
