/**
 * Analysis review — tolerance policy, canonical comparison, replay and
 * independent verification (§17, §4).
 *
 * Numeric correctness is NEVER delegated to the LLM. The deterministic
 * verifier replays, canonicalizes, compares within explicit tolerances and
 * independently recomputes key metrics. The LLM receives only a digest of
 * references/error codes (no raw numbers, no full tables, no canary values).
 */
import { canonicalHash } from "../store.ts";

// ---------------------------------------------------------------------------
// Tolerance policy (§17.3)
// ---------------------------------------------------------------------------

export interface NumericTolerance {
  absolute: number;
  relative: number;
}

export const DEFAULT_TOLERANCES: Record<string, NumericTolerance> = {
  INTEGER: { absolute: 0, relative: 0 },
  CURRENCY: { absolute: 0.01, relative: 1e-9 },
  PERCENT: { absolute: 1e-9, relative: 1e-9 },
  NUMBER: { absolute: 1e-9, relative: 1e-9 },
  DURATION: { absolute: 1, relative: 1e-9 },
};

export function withinTolerance(a: number, b: number, tol: NumericTolerance): boolean {
  if (Object.is(a, b)) return true;
  const absDiff = Math.abs(a - b);
  if (absDiff <= tol.absolute) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), Number.EPSILON);
  return absDiff / scale <= tol.relative;
}

// ---------------------------------------------------------------------------
// Canonical comparison (§17.2)
// ---------------------------------------------------------------------------

export type DiscrepancyCode =
  | "METRIC_VALUE_MISMATCH"
  | "DENOMINATOR_MISMATCH"
  | "TIME_WINDOW_MISMATCH"
  | "CHART_SERIES_MISMATCH"
  | "P_VALUE_MISMATCH"
  | "TABLE_HASH_MISMATCH"
  | "STATUS_MISMATCH"
  | "SCHEMA_MISMATCH";

export interface Discrepancy {
  code: DiscrepancyCode;
  location: string;
  detail: string;
}

export interface CanonicalMetric {
  metricId: string;
  valueType: string;
  value: number;
  denominator?: number;
}

export interface ReplayComparisonInput {
  originalMetrics: CanonicalMetric[];
  replayMetrics: CanonicalMetric[];
  originalTables: Array<{ id: string; rows: unknown[] }>;
  replayTables: Array<{ id: string; rows: unknown[] }>;
  originalStatus: string;
  replayStatus: string;
  originalCharts?: Array<{ id: string; series: Array<{ name: string; points: Array<{ x: number | string; y: number }> }> }>;
  replayCharts?: Array<{ id: string; series: Array<{ name: string; points: Array<{ x: number | string; y: number }> }> }>;
}

export interface ChartPoint { x: number | string; y: number }
export interface ChartSeries { name: string; points: ChartPoint[] }
export interface CanonicalChart { id: string; series: ChartSeries[] }

export function compareReplay(input: ReplayComparisonInput): Discrepancy[] {
  const out: Discrepancy[] = [];

  if (input.originalStatus !== input.replayStatus) {
    out.push({ code: "STATUS_MISMATCH", location: "analysis.status",
      detail: `${input.originalStatus} vs ${input.replayStatus}` });
  }

  const byId = new Map(input.replayMetrics.map((m) => [m.metricId, m]));
  for (const m of input.originalMetrics) {
    const r = byId.get(m.metricId);
    if (!r) {
      out.push({ code: "METRIC_VALUE_MISMATCH", location: `metric:${m.metricId}`,
        detail: "metric missing from replay" });
      continue;
    }
    const tol = DEFAULT_TOLERANCES[m.valueType] ?? DEFAULT_TOLERANCES.NUMBER;
    if (!withinTolerance(m.value, r.value, tol)) {
      out.push({ code: "METRIC_VALUE_MISMATCH", location: `metric:${m.metricId}`,
        detail: `value ${m.value} vs ${r.value} outside tolerance` });
    }
    if (m.denominator !== undefined && r.denominator !== undefined &&
        !withinTolerance(m.denominator, r.denominator, DEFAULT_TOLERANCES.INTEGER)) {
      out.push({ code: "DENOMINATOR_MISMATCH", location: `metric:${m.metricId}`,
        detail: `denominator ${m.denominator} vs ${r.denominator}` });
    }
  }
  // bidirectional: metrics that exist ONLY in the replay are discrepancies too
  const originalIds = new Set(input.originalMetrics.map((m) => m.metricId));
  for (const m of input.replayMetrics) {
    if (!originalIds.has(m.metricId)) {
      out.push({ code: "METRIC_VALUE_MISMATCH", location: `metric:${m.metricId}`,
        detail: "metric present in replay but not in the original result" });
    }
  }

  const tableById = new Map(input.replayTables.map((t) => [t.id, t]));
  for (const t of input.originalTables) {
    const r = tableById.get(t.id);
    if (!r) {
      out.push({ code: "TABLE_HASH_MISMATCH", location: `table:${t.id}`,
        detail: "table missing from replay" });
      continue;
    }
    if (canonicalHash(t.rows) !== canonicalHash(r.rows)) {
      out.push({ code: "TABLE_HASH_MISMATCH", location: `table:${t.id}`,
        detail: "row-set canonical hash differs" });
    }
  }
  const originalTableIds = new Set(input.originalTables.map((t) => t.id));
  for (const t of input.replayTables) {
    if (!originalTableIds.has(t.id)) {
      out.push({ code: "TABLE_HASH_MISMATCH", location: `table:${t.id}`,
        detail: "table present in replay but not in the original result" });
    }
  }

  // chart series comparison (previously declared but never enforced)
  const originalCharts = input.originalCharts ?? [];
  const replayCharts = input.replayCharts ?? [];
  const chartById = new Map(replayCharts.map((c) => [c.id, c]));
  for (const c of originalCharts) {
    const r = chartById.get(c.id);
    if (!r) {
      out.push({ code: "CHART_SERIES_MISMATCH", location: `chart:${c.id}`,
        detail: "chart missing from replay" });
      continue;
    }
    if (canonicalHash(c.series) !== canonicalHash(r.series)) {
      out.push({ code: "CHART_SERIES_MISMATCH", location: `chart:${c.id}`,
        detail: "chart series differ" });
    }
  }
  const originalChartIds = new Set(originalCharts.map((c) => c.id));
  for (const c of replayCharts) {
    if (!originalChartIds.has(c.id)) {
      out.push({ code: "CHART_SERIES_MISMATCH", location: `chart:${c.id}`,
        detail: "chart present in replay but not in the original result" });
    }
  }

  return out;
}

export interface CanonicalizedAnalysisResult {
  metrics: CanonicalMetric[];
  tables: Array<{ id: string; rows: unknown[] }>;
  charts: CanonicalChart[];
  status: string;
}

/**
 * Canonicalizer for the REAL AnalysisResultArtifact shape:
 * metrics/tables/charts live inside `sections` (METRIC_CARDS / TABLE /
 * LINE_CHART|BAR_CHART|SCATTER|HISTOGRAM), never at the top level.
 * Legacy top-level shapes are accepted as a fallback only when there are
 * no sections at all.
 */
export function canonicalizeAnalysisResult(a: unknown): CanonicalizedAnalysisResult {
  const art = a as { status?: string; sections?: unknown[] } | null;
  const sections = Array.isArray(art?.sections) ? art.sections : [];
  if (sections.length === 0) {
    const legacy = a as { metrics?: CanonicalMetric[]; tables?: Array<{ id: string; rows: unknown[] }> } | null;
    return {
      metrics: Array.isArray(legacy?.metrics) ? legacy.metrics : [],
      tables: Array.isArray(legacy?.tables) ? legacy.tables : [],
      charts: [],
      status: String(art?.status ?? "COMPLETED"),
    };
  }
  const metrics: CanonicalMetric[] = [];
  const tables: Array<{ id: string; rows: unknown[] }> = [];
  const charts: CanonicalChart[] = [];
  let tableIndex = 0;
  for (const raw of sections) {
    const s = raw as {
      type?: string;
      metrics?: Array<{ metricId: string; value: string | number; valueType: string; denominator?: number }>;
      rows?: Array<Record<string, string | number | null>>;
      downloadableArtifactRef?: string;
      chartTitle?: string;
      series?: ChartSeries[];
    } | null;
    if (!s) continue;
    const type = s.type ?? "";
    if (type === "METRIC_CARDS") {
      for (const m of s.metrics ?? []) {
        const v = typeof m.value === "number" ? m.value : Number(m.value);
        if (!Number.isFinite(v)) continue;
        metrics.push({ metricId: m.metricId, valueType: m.valueType, value: v, denominator: m.denominator });
      }
    } else if (type === "TABLE") {
      tables.push({
        id: s.downloadableArtifactRef ?? `table_${tableIndex}`,
        rows: (s.rows ?? []) as unknown[],
      });
      tableIndex++;
    } else if (type === "LINE_CHART" || type === "BAR_CHART" || type === "SCATTER" || type === "HISTOGRAM") {
      charts.push({ id: s.chartTitle ?? `chart_${charts.length}`, series: (s.series ?? []) as ChartSeries[] });
    }
  }
  return { metrics, tables, charts, status: String(art?.status ?? "COMPLETED") };
}

// ---------------------------------------------------------------------------
// Independent verification (§17.4) — deterministic recomputation of core KPIs
// ---------------------------------------------------------------------------

export interface VerificationCase {
  metricId: string;
  kind: "MEAN" | "SUM" | "COUNT" | "RATIO" | "TOP_N" | "CORRELATION";
  data: number[] | Array<[string, number]>;
  expected?: number;
}

export function verifyIndependently(cases: VerificationCase[]): Array<{
  metricId: string;
  ok: boolean;
  computed: number;
  expected?: number;
}> {
  return cases.map((c) => {
    let computed = 0;
    if (c.kind === "MEAN") {
      const xs = c.data as number[];
      computed = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    } else if (c.kind === "SUM") {
      computed = (c.data as number[]).reduce((a, b) => a + b, 0);
    } else if (c.kind === "COUNT") {
      computed = (c.data as number[]).length;
    } else if (c.kind === "RATIO") {
      const xs = c.data as number[];
      computed = xs.length >= 2 && xs[1] !== 0 ? xs[0]! / xs[1]! : 0;
    } else if (c.kind === "TOP_N") {
      computed = (c.data as Array<[string, number]>).length;
    } else if (c.kind === "CORRELATION") {
      computed = pearson(c.data as number[]);
    }
    const ok = c.expected === undefined || withinTolerance(computed, c.expected, DEFAULT_TOLERANCES.NUMBER);
    return { metricId: c.metricId, ok, computed, expected: c.expected };
  });
}

function pearson(xs: number[]): number {
  const n = xs.length / 2;
  const a = xs.slice(0, Math.floor(n));
  const b = xs.slice(Math.floor(n), Math.floor(n) * 2);
  if (!a.length || a.length !== b.length) return 0;
  const meanA = a.reduce((x, y) => x + y, 0) / a.length;
  const meanB = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - meanA) * (b[i]! - meanB);
    denA += (a[i]! - meanA) ** 2;
    denB += (b[i]! - meanB) ** 2;
  }
  return denA && denB ? num / Math.sqrt(denA * denB) : 0;
}

// ---------------------------------------------------------------------------
// Analysis review digest (§15.2) — the ONLY thing the reviewer LLM receives
// ---------------------------------------------------------------------------

export interface AnalysisReviewDigest {
  objective: string;
  analysisType: string;
  artifactId: string;
  sectionIds: string[];
  methods: string[];
  assumptions: string[];
  limitations: string[];
  checkSummaries: Array<{ checkId: string; status: string; summary: string; evidenceRefIds: string[] }>;
  findingClaims: Array<{ findingId: string; claimTemplate: string; category: string; causalClaim: boolean; evidenceRefIds: string[] }>;
  discrepancyCodes: string[];
}
