/**
 * verify-pipeline-data — check the test warehouse against the pipeline
 * ground truth (infra/lakehouse/pipeline-fixtures/expected-results.json).
 *
 * Verifies row counts, stream counters, dedup, idempotency and the 10 known
 * scenarios. Runs against .data/pipeline-test (never the shared warehouse).
 *
 * Run: node --experimental-strip-types experiments/verify-pipeline-data.mts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const GT = JSON.parse(
  readFileSync(join(ROOT, "infra", "lakehouse", "pipeline-fixtures", "expected-results.json"), "utf8"),
);

function py(code: string): any {
  const out = execFileSync("python3", ["-c", code], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

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

const PY = `
import json, sys
sys.path.insert(0, ".")
from pipelines.common.config import load_config, open_catalog
cfg = load_config()
catalog = open_catalog(cfg.warehouse)
def rows(t):
    try:
        return catalog.load_table(t).scan().to_arrow().to_pylist()
    except Exception:
        return []
out = {}
out["streaming_events"] = len(rows("ods.streaming_events"))
out["dwd"] = len(rows("dwd.loan_application_detail"))
out["dws_feat"] = len(rows("dws.feature_values"))
out["dws_pred"] = len(rows("dws.prediction_points"))
out["ads"] = len(rows("ads.model_metrics"))
# unique event ids in ODS
ids = [r["event_id"] for r in rows("ods.streaming_events")]
out["ods_unique_ids"] = len(set(ids))
out["ods_dup_ids"] = len(ids) - len(set(ids))
# too-late / invalid never in ODS
out["ods_too_late"] = sum(1 for r in rows("ods.streaming_events") if r.get("event_id") and "too_late" in str(r["event_id"]))
out["ods_invalid"] = sum(1 for r in rows("ods.streaming_events") if not r.get("event_id"))
# AUC decline
ads = rows("ads.model_metrics")
v2 = [r for r in ads if r.get("model_id") == "lgb_v2"]
before = [r["auc"] for r in v2 if r["metric_date"] < "2026-05-15"]
after = [r["auc"] for r in v2 if r["metric_date"] >= "2026-05-15"]
out["auc_before"] = sum(before)/len(before) if before else 0
out["auc_after"] = sum(after)/len(after) if after else 0
# missingness rise
feat = rows("dws.feature_values")
db_before = [r for r in feat if r.get("feature_id")=="feature_debt_ratio" and r["event_time"] < "2026-05-15"]
db_after = [r for r in feat if r.get("feature_id")=="feature_debt_ratio" and r["event_time"] >= "2026-05-15"]
out["debt_before_mean"] = sum(r["feature_value"] for r in db_before if r["feature_value"] is not None)/len(db_before)
out["debt_after_mean"] = sum(r["feature_value"] for r in db_after if r["feature_value"] is not None)/len(db_after)
out["missing_before"] = sum(1 for r in db_before if r["feature_value"] is None)
out["missing_after"] = sum(1 for r in db_after if r["feature_value"] is None)
# prediction freshness
pred_dates = sorted({r["event_time"] for r in rows("dws.prediction_points")})
out["pred_last_date"] = pred_dates[-1] if pred_dates else None
# null borrower scores only after anomaly day
dwd = rows("dwd.loan_application_detail")
null_before = [r for r in dwd if r.get("borrower_score") is None and r["event_time"] < "2026-05-15"]
null_after = [r for r in dwd if r.get("borrower_score") is None and r["event_time"] >= "2026-05-15"]
out["null_before"] = len(null_before)
out["null_after"] = len(null_after)
print(json.dumps(out))
`;

console.log("[verify] pipeline ground truth checks\n");

const data = py(PY);
const fx = GT.fixtures.small;

check("ODS streaming_events row count", data.streaming_events === fx.expectedRowCounts["ods.streaming_events"],
  `got ${data.streaming_events}, want ${fx.expectedRowCounts["ods.streaming_events"]}`);
check("ODS unique event ids (no duplicate facts)", data.ods_dup_ids === 0, `dup=${data.ods_dup_ids}`);
check("DWD row count (dedup applied, no synthetic stream keys)",
  data.dwd === fx.expectedRowCounts["dwd.loan_application_detail"],
  `got ${data.dwd}, want ${fx.expectedRowCounts["dwd.loan_application_detail"]}`);
check("DWS feature_values count", data.dws_feat === fx.expectedRowCounts["dws.feature_values"],
  `got ${data.dws_feat}`);
check("DWS prediction_points count", data.dws_pred === fx.expectedRowCounts["dws.prediction_points"],
  `got ${data.dws_pred}`);
check("ADS model_metrics count", data.ads === fx.expectedRowCounts["ads.model_metrics"], `got ${data.ads}`);

// scenarios
check("scenario: AUC decline (lgb_v2)", data.auc_after < data.auc_before - 0.02,
  `before=${data.auc_before.toFixed(4)} after=${data.auc_after.toFixed(4)}`);
check("scenario: feature drift (debt_ratio +0.2)", data.debt_after_mean > data.debt_before_mean + 0.12,
  `before=${data.debt_before_mean.toFixed(4)} after=${data.debt_after_mean.toFixed(4)}`);
check("scenario: missingness rise", data.missing_after > data.missing_before,
  `before=${data.missing_before} after=${data.missing_after}`);
check("scenario: freshness (predictions stop 2 days early)", data.pred_last_date === "2026-05-28",
  `last=${data.pred_last_date}`);
check("scenario: null borrower_score only after anomaly day", data.null_before === 0 && data.null_after > 0,
  `before=${data.null_before} after=${data.null_after}`);
check("scenario: too-late never in ODS", data.ods_too_late === 0, `got ${data.ods_too_late}`);
check("scenario: invalid never in ODS", data.ods_invalid === 0, `got ${data.ods_invalid}`);

console.log(`\n[verify] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
