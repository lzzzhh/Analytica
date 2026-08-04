/**
 * E2E: Hybrid Pipeline — batch baseline + streaming append + incremental
 * fold; then verify via the Lakehouse Gateway (read-only) and the data
 * analysis artifact path.
 *
 * Run: node --experimental-strip-types experiments/e2e-hybrid-pipeline.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok - ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}

function runHybrid(root: string, extra: string[] = []): string {
  return execFileSync("python3", ["-m", "pipelines.run", "--mode", "hybrid", "--profile", "small", ...extra], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, PIPELINE_TEST_ROOT: root },
    maxBuffer: 10 * 1024 * 1024,
  });
}

function py(root: string, code: string): any {
  const out = execFileSync("python3", ["-c", code], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, PIPELINE_TEST_ROOT: root },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

const LAYERS = `
import json, os, sys
sys.path.insert(0, ".")
from pathlib import Path
from pipelines.common.config import PipelineConfig, open_catalog
cfg = PipelineConfig(root=Path(os.environ["PIPELINE_TEST_ROOT"]), mode="hybrid", profile="small")
catalog = open_catalog(cfg.warehouse)
out = {}
for t in ["ods.streaming_events", "dwd.loan_application_detail", "dws.feature_values", "ads.model_metrics"]:
    try:
        rows = catalog.load_table(t).scan().to_arrow().to_pylist()
        out[t] = len(rows)
    except Exception:
        out[t] = -1
print(json.dumps(out))
`;

console.log("[e2e] Hybrid Pipeline\n");
const root = mkdtempSync(join(tmpdir(), "pipeline-hybrid-e2e-"));

try {
  // A. hybrid reset: batch baseline + streaming + incremental fold
  console.log("A. hybrid run (batch baseline + stream + fold)");
  runHybrid(root, ["--reset"]);
  const l1 = py(root, LAYERS);
  check("ODS streaming_events = 72", l1["ods.streaming_events"] === 72, JSON.stringify(l1));
  check("DWD = 3005 (batch only; stream events stay in ODS, no synthetic keys)",
    l1["dwd.loan_application_detail"] === 3005, `got ${l1["dwd.loan_application_detail"]}`);
  check("DWS feature_values = 12000", l1["dws.feature_values"] === 12000);
  check("ADS = 60", l1["ads.model_metrics"] === 60);

  // B. hybrid re-run (idempotent: no duplicate rows)
  console.log("B. hybrid re-run (idempotency)");
  runHybrid(root);
  const l2 = py(root, LAYERS);
  check("row counts unchanged", JSON.stringify(l1) === JSON.stringify(l2), JSON.stringify(l2));

  // C. Gateway read-only query over pipeline data (validate → execute)
  console.log("C. Gateway query over pipeline tables");
  const GW = `
import json, sys, os
sys.path.insert(0, "services/lakehouse-gateway")
from app.config import LakehouseConfig
from app.catalog.dataset_registry import DatasetRegistry
from app.query.plan import parse_plan, validate_plan
from app.query.executor import QueryExecutor, ValidationSession
wh = os.environ["PIPELINE_TEST_ROOT"] + "/warehouse"
cfg = LakehouseConfig(
    mode="local", warehouse_path=wh, catalog_type="sql",
    gateway_url="http://x", allow_ods=True,
    max_result_bytes=10*1024*1024,
)
reg = DatasetRegistry(cfg)
try:
    reg.discover()
except Exception:
    pass
session = ValidationSession()
executor = QueryExecutor(cfg, reg, session)
plan = parse_plan({"datasetId": "ads.model_metrics", "select": [{"field": "auc", "aggregation": "avg", "alias": "avg_auc"}], "filters": [{"field": "metric_date", "operator": "between", "value": ["2026-05-01", "2026-05-31"]}], "limit": 10})
res = validate_plan(plan, reg, cfg)
if not res.ok:
    print(json.dumps({"error": [str(i) for i in res.issues]})); sys.exit(1)
session.put(res.validatedQueryId, plan, caller="e2e")
qr = executor.execute(res.validatedQueryId, caller="e2e")
print(json.dumps({"queryId": qr.queryId, "rowCount": qr.rowCount, "columns": qr.columns, "rows": qr.rows}))
`;
  const gw = py(root, GW);
  check("gateway executes over pipeline ADS", gw.queryId && gw.rowCount > 0, JSON.stringify(gw));
  check("gateway returns aggregate value", gw.rows && gw.rows.length > 0, JSON.stringify(gw));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n[e2e] hybrid: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
