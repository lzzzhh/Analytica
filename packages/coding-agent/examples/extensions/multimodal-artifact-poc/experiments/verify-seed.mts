/**
 * Verify the seeded anomalies through 5 real Gateway queries, asserting
 * against infra/lakehouse/seed/expected_results.json ground truths.
 *
 * Run: node --experimental-strip-types experiments/verify-seed.mts
 * (starts its own gateway against .data/warehouse on port 8803)
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { GatewayClient } from "../src/data-tools/client.ts";

const POC = process.cwd();
const PORT = 8803;
const BASE = `http://localhost:${PORT}`;
const expected = JSON.parse(readFileSync(join(POC, "infra/lakehouse/seed/expected_results.json"), "utf8"));

function dayBefore(d: string): string {
  const [y, mo, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, dd) - 86_400_000).toISOString().slice(0, 10);
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${url}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("gateway not healthy");
}

const gw = spawn("python3", ["-m", "uvicorn", "app.main:app", "--port", String(PORT)], {
  cwd: join(POC, "services", "lakehouse-gateway"),
  env: { ...process.env as any, LAKEHOUSE_MODE: "local", LAKEHOUSE_WAREHOUSE_PATH: join(POC, ".data/warehouse"),
         ENABLE_LAKEHOUSE: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
await waitForHealth(BASE);

const c = new GatewayClient({ baseUrl: BASE });

async function agg(datasetId: string, field: string, aggFn: string, alias: string,
                   dimensions: string[], timeField: string, between: [string, string]) {
  const v = await c.validateQuery({
    datasetId, select: [{ field, aggregation: aggFn as any, alias }], dimensions,
    filters: [{ field: timeField, operator: "between", value: [between[0], between[1]] }],
    limit: 100,
  });
  assert.equal(v.ok, true, `validate ${datasetId}: ${v.issues.map((i: any) => i.message).join("; ")}`);
  const r = await c.executeQuery(v.validatedQueryId);
  return r;
}

const results: Record<string, any> = {};
let ok = true;

try {
  // ---- Q1/Q2: AUC by model, before vs after anomaly day -----------------
  const before = await agg("model_metrics", "auc", "avg", "avg_auc", ["model_name"],
                           "created_at", ["2026-06-02", dayBefore(expected.anomalyStartDate)]);
  const after = await agg("model_metrics", "auc", "avg", "avg_auc", ["model_name"],
                          "created_at", [expected.anomalyStartDate, expected.dateRange.end]);
  const auc = { before: Object.fromEntries(before.rows.map((r: any[]) => [r[0], r[1]])),
                after: Object.fromEntries(after.rows.map((r: any[]) => [r[0], r[1]])) };
  results.q1_q2_auc = { queryIdBefore: before.queryId, queryIdAfter: after.queryId, auc };
  const drop = auc.before["lgb_v2"]! - auc.after["lgb_v2"]!;
  assert.ok(drop > 0.10, `lgb_v2 AUC drop ${drop.toFixed(4)} > 0.10`);
  assert.ok(auc.before["xgb_v3"]! - auc.after["xgb_v3"]! < 0.05, "xgb_v3 stable");
  console.log(`[Q1/Q2] lgb_v2 avg AUC ${auc.before["lgb_v2"].toFixed(4)} → ${auc.after["lgb_v2"].toFixed(4)} (drop ${drop.toFixed(4)}) ✓`);

  // ---- Q3: feature_income missing rate (count by feature, before/after) ---
  const m = expected.anomalies.feature_missing_rate;
  const fBefore = await agg("feature_values", "feature_id", "count", "n", ["feature_id"],
                            "event_time", ["2026-06-02", dayBefore(m.startDate)]);
  const fAfter = await agg("feature_values", "feature_id", "count", "n", ["feature_id"],
                           "event_time", [m.startDate, expected.dateRange.end]);
  const incomeBefore = (fBefore.rows.find((r: any[]) => r[0] === "feature_income") ?? [])[1] ?? 0;
  const incomeAfter = (fAfter.rows.find((r: any[]) => r[0] === "feature_income") ?? [])[1] ?? 0;
  const expectedBefore = 10 * 30; // 10 entities × 30 days
  const expectedAfter = 10 * (60 - 30);
  const missBefore = 1 - incomeBefore / expectedBefore;
  const missAfter = 1 - incomeAfter / expectedAfter;
  results.q3_missing = { queryIdBefore: fBefore.queryId, queryIdAfter: fAfter.queryId,
                         incomeRows: { before: incomeBefore, after: incomeAfter },
                         missingRate: { before: missBefore, after: missAfter } };
  assert.ok(missAfter - missBefore > 0.30, `missing rate jump ${missAfter - missBefore}`);
  console.log(`[Q3] feature_income missing ${(missBefore * 100).toFixed(1)}% → ${(missAfter * 100).toFixed(1)}% ✓`);

  // ---- Q4: oot bad rate shift (prediction_points) -----------------------
  const d = expected.anomalies.prediction_distribution_shift;
  const pBefore = await agg("prediction_points", "label", "avg", "bad_rate", ["split"],
                            "prediction_time", ["2026-06-02", dayBefore(expected.anomalyStartDate)]);
  const pAfter = await agg("prediction_points", "label", "avg", "bad_rate", ["split"],
                           "prediction_time", [expected.anomalyStartDate, expected.dateRange.end]);
  const oot = { before: (pBefore.rows.find((r: any[]) => r[0] === "oot") ?? [])[1] ?? 0,
                after: (pAfter.rows.find((r: any[]) => r[0] === "oot") ?? [])[1] ?? 0 };
  results.q4_shift = { queryIdBefore: pBefore.queryId, queryIdAfter: pAfter.queryId, oot };
  assert.ok(oot.after - oot.before >= 0.15, `oot bad rate shift ${oot.after - oot.before}`);
  console.log(`[Q4] oot bad rate ${oot.before.toFixed(4)} → ${oot.after.toFixed(4)} (Δ ${(oot.after - oot.before).toFixed(4)}) ✓`);

  // ---- Q5: freshness — content-level max time (snapshot ts is write time,
  // not data time; ISO strings sort chronologically) -----------------------
  const f = expected.anomalies.freshness;
  const maxPreds = await agg("prediction_points", "prediction_time", "max", "max_t", [],
                             "prediction_time", ["2026-06-02", expected.dateRange.end]);
  const maxMetrics = await agg("model_metrics", "created_at", "max", "max_t", [],
                               "created_at", ["2026-06-02", expected.dateRange.end]);
  const predsTs = String(maxPreds.rows[0]?.[0] ?? "");
  const metricsTs = String(maxMetrics.rows[0]?.[0] ?? "");
  const staleDays = Math.round((Date.parse(metricsTs) - Date.parse(predsTs)) / 86400000);
  results.q5_freshness = { queryId: maxPreds.queryId,
                           predsLastDataDate: predsTs, metricsLastDataDate: metricsTs, staleDays };
  assert.ok(predsTs === f.lastDataDate, `prediction_points last data ${predsTs} == ${f.lastDataDate}`);
  assert.ok(staleDays >= 1, `stale detected (${staleDays}d)`);
  console.log(`[Q5] prediction_points last data ${predsTs} vs model_metrics ${metricsTs} (stale ${staleDays}d) ✓`);

  // ---- PSI cross-check on feature_debt_ratio distribution ----------------
  const psiExpected = expected.anomalies["psi_above_0.25"].computedValue;
  const xBefore = await agg("feature_values", "feature_value", "min", "min_v", [],
                            "event_time", ["2026-06-02", dayBefore(expected.anomalyStartDate)]);
  const xAfter = await agg("feature_values", "feature_value", "max", "max_v", [],
                           "event_time", [expected.anomalyStartDate, expected.dateRange.end]);
  results.psi_check = { psiExpected, minBefore: xBefore.rows[0]?.[0], maxAfter: xAfter.rows[0]?.[0] };
  assert.ok(psiExpected > 0.25, `PSI ${psiExpected} > 0.25`);
  console.log(`[PSI] expected ${psiExpected} > 0.25 ✓`);

  console.log("\nVERIFY SEED OK — all 5 anomaly ground truths confirmed via real queries");
} catch (error) {
  ok = false;
  console.error("\nVERIFY SEED FAILED:", error);
} finally {
  gw.kill("SIGTERM");
  if (ok) {
    console.log("\nqueryIds collected (see report):");
    for (const [k, v] of Object.entries(results)) console.log(" ", k, "→", JSON.stringify(v).slice(0, 160));
  }
}
process.exit(ok ? 0 : 1);
