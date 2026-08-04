/**
 * End-to-end test: local Query Gateway ↔ Pi data tools (spec §11).
 *
 *   1. build a local test Iceberg warehouse (pyiceberg, tmp dir)
 *   2. drive the full chain through the TS GatewayClient AND the Pi tool
 *      definitions (DATA_TOOLS): search → inspect → validate → execute →
 *      quality → lineage → snapshot
 *   3. verify: queryId / snapshot / dataVersion / qualityStatus /
 *      lineageReference returned; agent context receives a bounded summary;
 *      raw SQL is rejected
 *
 * Two run modes:
 *   - Self-contained (default, no env): a local lakehouse-gateway is started
 *     automatically on a free port against the freshly built test warehouse,
 *     then torn down (SIGTERM, no leftover uvicorn) when the run finishes.
 *       node --experimental-strip-types experiments/e2e-lakehouse.mts
 *   - External gateway: when LAKEHOUSE_GATEWAY_URL is set, the script uses
 *     that address as-is, does NOT start (or kill) any local process, and
 *     behaves exactly like before. The external gateway must already serve
 *     the same test datasets (ads.ads_sales_daily / dws / ods).
 *       LAKEHOUSE_GATEWAY_URL=http://localhost:<port> \
 *         node --experimental-strip-types experiments/e2e-lakehouse.mts
 */
// Feature env preamble: round2.lakehouse must be on for DATA_TOOLS to include
// the lakehouse tools (feature-driven registry; round2 defaults OFF).
import "../tests/set-lakehouse-on.ts";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { GatewayClient } from "../src/data-tools/client.ts";
import { DATA_TOOLS } from "../src/data-tools/tools.ts";
import { queryResultToFacts } from "../src/data-tools/evidence-adapter.ts";

const POC = process.cwd();
const GW_DIR = join(POC, "services", "lakehouse-gateway");
const EXTERNAL_URL = (process.env.LAKEHOUSE_GATEWAY_URL ?? "").trim().replace(/\/+$/u, "");

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
  throw new Error(`gateway did not become healthy in time (${timeoutMs}ms)`);
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate a free port")));
      }
    });
  });
}

/** Bounded gateway stderr snapshot for failure reports (never unbounded). */
const MAX_STDERR_BYTES = 8_000;
function bounded(err: string): string {
  return err.length > MAX_STDERR_BYTES
    ? `${err.slice(0, MAX_STDERR_BYTES)}\n... (truncated ${err.length - MAX_STDERR_BYTES} bytes)`
    : err;
}

// 1. build a local test warehouse (existing data-prep convention: tmp dir)
const tmp = mkdtempSync(join(tmpdir(), "lh-e2e-"));
const warehouse = join(tmp, "wh");
try {
  sh("python3", ["-c", `
import sys; sys.path.insert(0, "${GW_DIR}")
from tests.conftest import build_test_warehouse
from pathlib import Path
build_test_warehouse(Path("${warehouse}"))
print("warehouse built")
`], GW_DIR);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    "[e2e] FAILED: test warehouse could not be prepared.\n" +
    "Prepare it manually with:\n" +
    `  cd ${GW_DIR} && python3 -c "import sys; sys.path.insert(0, '.'); ` +
    `from tests.conftest import build_test_warehouse; from pathlib import Path; ` +
    `build_test_warehouse(Path('${warehouse}'))"\n${message}`,
  );
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
console.log("[e2e] 1. local warehouse built at", warehouse);

// 2. gateway selection: external URL (caller-provided) or self-contained
let BASE: string;
let gw: ReturnType<typeof spawn> | null = null;
let gwStderr = "";

if (EXTERNAL_URL) {
  // External gateway mode: use it as-is; never start, never kill anything.
  BASE = EXTERNAL_URL;
  console.log("[e2e] 2. using external gateway at", BASE);
} else {
  // Self-contained mode: start a local gateway on a free port, wired to the
  // warehouse built in step 1. LAKEHOUSE_GATEWAY_URL is injected into the
  // CHILD env (gateway reads it for config) and into the PARENT env so the
  // Pi tools (gatewayClientFromEnv) reach the same instance.
  const port = await findFreePort();
  BASE = `http://localhost:${port}`;
  process.env.LAKEHOUSE_GATEWAY_URL = BASE;
  gw = spawn("python3", ["-m", "uvicorn", "app.main:app", "--port", String(port)], {
    cwd: GW_DIR,
    env: {
      ...process.env as any,
      LAKEHOUSE_MODE: "local",
      LAKEHOUSE_WAREHOUSE_PATH: warehouse,
      LAKEHOUSE_AUDIT_LOG: join(tmp, "audit.log"),
      ENABLE_LAKEHOUSE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gw.stderr.on("data", (d: Buffer) => {
    gwStderr = (gwStderr + d.toString()).slice(-MAX_STDERR_BYTES);
  });
  const spawnError = new Promise<never>((_resolve, reject) => {
    gw!.once("error", (err: Error) =>
      reject(new Error(`gateway failed to start: ${err.message}`)));
  });
  try {
    await Promise.race([waitForHealth(BASE), spawnError]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[e2e] FAILED: ${message}`);
    if (gwStderr) console.error(`[e2e] gateway stderr (bounded):\n${bounded(gwStderr)}`);
    if (gw) gw.kill("SIGTERM");
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("[e2e] 2. gateway up on", BASE);
}

let failed = false;
try {
  const c = new GatewayClient({ baseUrl: BASE });

  // 3. full chain via TS client
  const search = await c.searchCatalog("sales_daily");
  assert.ok(search.results.some((d: any) => d.datasetId === "ads.ads_sales_daily"), "catalog search finds ads.ads_sales_daily");
  console.log("[e2e] 3a. search_catalog OK:", search.results.map((d: any) => d.datasetId).join(", "));

  const ds = await c.inspectDataset("ads_sales_daily");
  assert.equal(ds.layer, "ADS");
  assert.ok(ds.fields.some((f: any) => f.name === "revenue"));
  console.log("[e2e] 3b. inspect_dataset OK:", ds.fields.length, "fields");

  const v = await c.validateQuery({
    datasetId: "ads_sales_daily",
    select: [{ field: "revenue", aggregation: "sum", alias: "total_revenue" }],
    dimensions: ["region"],
    filters: [{ field: "event_date", operator: "between", value: ["2026-07-25", "2026-07-31"] }],
    limit: 100,
  });
  assert.equal(v.ok, true, "validate OK");
  console.log("[e2e] 3c. validate_query OK:", v.validatedQueryId);

  const r = await c.executeQuery(v.validatedQueryId);
  assert.equal(r.datasetId, "ads.ads_sales_daily");  // canonical namespaced id
  assert.equal(r.datasetLayer, "ADS");
  assert.ok(r.snapshotId !== null && r.snapshotId !== undefined, "snapshotId present");
  assert.ok(r.dataVersion.startsWith("v"), "dataVersion present");
  assert.ok(r.dataTimestamp, "dataTimestamp present");
  assert.ok(["PASS", "WARN", "FAIL"].includes(r.qualityStatus));
  assert.ok(r.lineageReference.startsWith("lineage://"));
  assert.equal(r.rowCount, 2);
  console.log(`[e2e] 3d. execute_query OK: ${r.rowCount} rows, snapshot=${r.snapshotId}, quality=${r.qualityStatus}`);

  const q = await c.getQuality("ads_sales_daily");
  assert.ok(q.checks.length >= 1);
  console.log("[e2e] 3e. get_data_quality OK:", q.status);

  const l = await c.explainLineage("ads_sales_daily");
  assert.ok(l.upstream.some((e: any) => e.source === "dws.dws_sales_daily"));
  console.log("[e2e] 3f. explain_lineage OK: upstream =", l.upstream.map((e: any) => e.source).join(", "));

  const s = await c.getSnapshots("ads_sales_daily");
  assert.ok(s.count >= 1);
  console.log("[e2e] 3g. get_snapshot OK:", s.count, "snapshot(s)");

  // 4. raw SQL rejected at the API boundary
  const bad = await fetch(`${BASE}/v1/query/execute`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ validatedQueryId: "SELECT * FROM x" }),
  });
  assert.equal(bad.status, 400, "raw SQL rejected");
  console.log("[e2e] 4. raw SQL rejected (400)");

  // 5. Pi tool definitions drive the same chain (agent-facing surface)
  const tool = DATA_TOOLS.find((t) => t.name === "execute_query")!;
  const execResult = await tool.execute(
    "t1", { validatedQueryId: v.validatedQueryId }, undefined, undefined,
    { cwd: POC } as any,
  );
  const text = execResult.content.map((b: any) => b.text).join("\n");
  assert.ok(/Query q_[a-f0-9]+ on/.test(text), "tool output carries queryId");
  assert.ok(text.includes(r.qualityStatus), "tool output carries qualityStatus");
  assert.ok(text.includes("lineage://"), "tool output carries lineageReference");
  assert.ok(text.includes(r.datasetId), "tool output carries datasetId");
  const contentLines = text.split("\n").length;
  assert.ok(contentLines < 40, `agent context bounded (${contentLines} lines)`);
  const facts = queryResultToFacts(r);
  assert.equal(facts.length, 2);
  assert.equal(facts[0]!.kind, "query");
  console.log(`[e2e] 5. Pi tool surface OK: ${contentLines} content lines, ${facts.length} evidence facts`);

  // 6. ODS denied through the tool chain
  const v2 = await c.validateQuery({
    datasetId: "ods_sales_ingest",
    select: [{ field: "event_date", aggregation: "count", alias: "n" }],
    dimensions: [],
    filters: [{ field: "event_date", operator: "between", value: ["2026-07-25", "2026-07-26"] }],
    limit: 10,
  });
  assert.equal(v2.ok, false);
  assert.ok(v2.issues.some((i: any) => i.code === "ods_denied"));
  console.log("[e2e] 6. ODS layer denied OK");

  console.log("\nE2E OK");
} catch (error) {
  failed = true;
  console.error("[e2e] FAILED:", error);
  if (gwStderr) console.error(`[e2e] gateway stderr (bounded):\n${bounded(gwStderr)}`);
} finally {
  // Self-contained mode only: terminate OUR gateway. External mode never
  // touches a process we did not start.
  if (gw) {
    gw.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1_500));
    if (gw.exitCode === null) gw.kill("SIGKILL");
  }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
