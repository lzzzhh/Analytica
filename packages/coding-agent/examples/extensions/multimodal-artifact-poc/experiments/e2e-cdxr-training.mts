/**
 * End-to-end test: CDXR on-demand training assessment (spec §12 — new plane).
 *
 *  1. build a local test Iceberg warehouse (pyiceberg, tmp dir)
 *  2. start the FastAPI gateway (uvicorn) against it
 *  3. scenarios:
 *     A. safe training plan → ALLOW or REVIEW, rawRowsReturned=false,
 *        no raw row arrays in the response
 *     B. target field included in features → BLOCK with TARGET_IN_FEATURES
 *     C. a normal execute_query never triggers CDXR (no assessment audit
 *        record, no governance run)
 *
 * Run: LAKEHOUSE_GATEWAY_URL=http://localhost:8791 node --experimental-strip-types experiments/e2e-cdxr-training.mts
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { GatewayClient } from "../src/data-tools/client.ts";

const POC = process.cwd();
const GW_DIR = join(POC, "services", "lakehouse-gateway");
const PORT = 8791;
const BASE = `http://localhost:${PORT}`;

function sh(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env as any, ...env }, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr?.slice(0, 500)}`);
  return r.stdout;
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("gateway did not become healthy in time");
}

// 1. build a local warehouse
const tmp = mkdtempSync(join(tmpdir(), "cdxr-e2e-"));
const warehouse = join(tmp, "wh");
sh("python3", ["-c", `
import sys; sys.path.insert(0, "${GW_DIR}")
from tests.conftest import build_test_warehouse
from pathlib import Path
build_test_warehouse(Path("${warehouse}"))
print("warehouse built")
`], GW_DIR);
console.log("[e2e] 1. local warehouse built");

// 2. start the gateway
const auditLog = join(tmp, "audit.log");
const gw = spawn("python3", ["-m", "uvicorn", "app.main:app", "--port", String(PORT)], {
  cwd: GW_DIR,
  env: { ...process.env as any, LAKEHOUSE_MODE: "local", LAKEHOUSE_WAREHOUSE_PATH: warehouse, LAKEHOUSE_AUDIT_LOG: auditLog,
         ENABLE_LAKEHOUSE: "true", ENABLE_CDXR_TRAINING: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
await waitForHealth(BASE);
console.log("[e2e] 2. gateway up on", BASE);

let failed = false;
try {
  const c = new GatewayClient({ baseUrl: BASE });

  // --- scenario A: safe plan → ALLOW/REVIEW, no raw rows -----------------
  const a = await c.assessTrainingData({
    datasetId: "dws.dws_sales_daily",
    targetField: "orders",
    featureFields: ["revenue", "region"],
    predictionTimeField: "event_date",
  });
  assert.ok(["ALLOW", "REVIEW"].includes(a.status),
    `safe plan should be ALLOW or REVIEW, got ${a.status}`);
  assert.equal(a.rawRowsReturned, false, "no raw rows");
  assert.equal(a.datasetId, "dws.dws_sales_daily");
  assert.ok(a.assessmentId.startsWith("ast_"));
  assert.ok(a.ruleVersion);
  assert.deepEqual(a.checkedFields, ["orders", "revenue", "region"]);
  assert.ok(!JSON.stringify(a).includes('"rows"'), "no row arrays in payload");
  console.log(`[e2e] 3A. safe plan -> ${a.status}, findings=${a.findings.length}`);

  // --- scenario B: target leak → BLOCK + TARGET_IN_FEATURES --------------
  const b = await c.assessTrainingData({
    datasetId: "dws.dws_sales_daily",
    targetField: "orders",
    featureFields: ["revenue", "orders"],   // target sneaks into features
    predictionTimeField: "event_date",
  });
  assert.equal(b.status, "BLOCK");
  assert.ok(b.findings.some((f) => f.code === "TARGET_IN_FEATURES" && f.severity === "CRITICAL"));
  console.log("[e2e] 3B. target leak -> BLOCK (TARGET_IN_FEATURES)");

  // --- scenario C: normal query never triggers CDXR ----------------------
  const countCdxrRecords = (log: string) =>
    log.split("\n").filter((ln) => ln.includes("cdxr_training_assessment")).length;
  const auditBefore = readFileSync(auditLog, "utf-8");
  const cdxrBefore = countCdxrRecords(auditBefore);
  const v = await c.validateQuery({
    datasetId: "ads_sales_daily",
    select: [{ field: "revenue", aggregation: "sum", alias: "total_revenue" }],
    dimensions: ["region"],
    filters: [{ field: "event_date", operator: "between", value: ["2026-07-25", "2026-07-31"] }],
    limit: 100,
  });
  assert.equal(v.ok, true);
  const q = await c.executeQuery(v.validatedQueryId);
  assert.ok(q.queryId.startsWith("q_"));
  const auditAfter = readFileSync(auditLog, "utf-8");
  assert.equal(countCdxrRecords(auditAfter), cdxrBefore,
    "a normal query must not produce CDXR assessment records");
  // governance plane also untouched (no materialized runs)
  const profile = await fetch(`${BASE}/v1/governance/cdxr/datasets/ads.ads_sales_daily/profile`);
  assert.equal(profile.status, 404, "no governance profile without a CDXR run");
  console.log("[e2e] 3C. execute_query did not trigger CDXR (audit + governance clean)");

  console.log("\n[e2e] cdxr-training: ALL SCENARIOS PASSED");
} catch (error) {
  failed = true;
  console.error("\n[e2e] cdxr-training FAILED:", error);
} finally {
  gw.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(tmp, { recursive: true, force: true });
  if (failed) process.exit(1);
}
