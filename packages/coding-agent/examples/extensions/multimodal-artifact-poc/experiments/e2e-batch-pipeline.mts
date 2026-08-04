/**
 * E2E: Batch Pipeline — empty test warehouse → batch → verify layers →
 * re-run (idempotency) → appended-date batch (new partitions only).
 *
 * Run: node --experimental-strip-types experiments/e2e-batch-pipeline.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
let passed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok - ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}
let failed = 0;

function runPipeline(root: string, mode: string, extra: string[] = []): string {
  const out = execFileSync("python3", ["-m", "pipelines.run", "--mode", mode, "--profile", "small", ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PIPELINE_TEST_ROOT: root },
    maxBuffer: 10 * 1024 * 1024,
  });
  return out;
}

function py(root: string, code: string): any {
  const out = execFileSync("python3", ["-c", code], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PIPELINE_TEST_ROOT: root },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

const COUNT = `
import json, sys, os
sys.path.insert(0, ".")
from pipelines.common.config import PipelineConfig
from pipelines.common.config import open_catalog
cfg = PipelineConfig(root=__import__("pathlib").Path(os.environ["PIPELINE_TEST_ROOT"]), mode="batch", profile="small")
catalog = open_catalog(cfg.warehouse)
out = {}
for t in ["ods.loan_applications_raw","ods.feature_inputs_raw","ods.prediction_inputs_raw","ods.model_metric_inputs_raw",
          "dwd.loan_application_detail","dws.feature_values","dws.prediction_points","ads.model_metrics"]:
    try:
        out[t] = len(catalog.load_table(t).scan().to_arrow().to_pylist())
    except Exception:
        out[t] = -1
print(json.dumps(out))
`;

console.log("[e2e] Batch Pipeline\n");
const root = mkdtempSync(join(tmpdir(), "pipeline-batch-e2e-"));

try {
  // 1. empty warehouse → run batch
  console.log("A. first run from empty warehouse");
  runPipeline(root, "batch", ["--reset"]);
  const first = py(root, COUNT);
  check("all 8 tables created", Object.values(first).every((v: any) => v > 0), JSON.stringify(first));
  check("DWD 3005 rows", first["dwd.loan_application_detail"] === 3005, `got ${first["dwd.loan_application_detail"]}`);
  check("DWS feature_values 12000", first["dws.feature_values"] === 12000);
  check("DWS prediction_points 2800", first["dws.prediction_points"] === 2800);
  check("ADS 60", first["ads.model_metrics"] === 60);

  // 2. re-run → idempotent (no duplicates)
  console.log("B. re-run (idempotency)");
  runPipeline(root, "batch");
  const second = py(root, COUNT);
  check("row counts unchanged after re-run", JSON.stringify(first) === JSON.stringify(second));

  // 3. snapshot count grows per layer (new snapshot each run)
  const SNAPS = `
import json, os, sys
sys.path.insert(0, ".")
from pathlib import Path
from pipelines.common.config import PipelineConfig
from pipelines.common.config import open_catalog
cfg = PipelineConfig(root=Path(os.environ["PIPELINE_TEST_ROOT"]), mode="batch", profile="small")
catalog = open_catalog(cfg.warehouse)
out = {}
for t in ["ods.loan_applications_raw","dwd.loan_application_detail","dws.feature_values","ads.model_metrics"]:
    tbl = catalog.load_table(t)
    out[t] = len(tbl.history())
print(json.dumps(out))
`;
  const snaps = py(root, SNAPS);
  check("each layer has >= 2 snapshots (2 runs)", Object.values(snaps).every((v: any) => v >= 2), JSON.stringify(snaps));

  // 4. appended-date batch: generate a longer source (more days) and re-run
  console.log("C. appended date range (days 30 -> 40)");
  const LONG = `
import json, os, sys, random
sys.path.insert(0, ".")
from pathlib import Path
from pipelines.common.config import PipelineConfig
cfg = PipelineConfig(root=Path(os.environ["PIPELINE_TEST_ROOT"]), mode="batch", profile="small")
entities = [f"ent_{i:03d}" for i in range(1, 101)]
rng = random.Random(42)
import pyarrow.parquet as pq
import pyarrow as pa
from pipelines.common.generators import gen_loan_applications as g1, gen_feature_inputs as g2, gen_prediction_inputs as g3, gen_model_metric_inputs as g4
for name, rows in [("loan_applications", g1(rng, entities, 40)), ("feature_inputs", g2(rng, entities, 40)),
                   ("prediction_inputs", g3(rng, entities, 40)), ("model_metric_inputs", g4(rng, 40, entities))]:
    d = cfg.batch_source_dir / name
    d.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows), d / "data.parquet")
print(json.dumps({"ok": True}))
`;
  py(root, LONG);
  runPipeline(root, "batch");
  const third = py(root, COUNT);
  check("DWD grew (40-day source)", third["dwd.loan_application_detail"] > second["dwd.loan_application_detail"],
    `${second["dwd.loan_application_detail"]} -> ${third["dwd.loan_application_detail"]}`);
  check("DWS feature_values grew", third["dws.feature_values"] > second["dws.feature_values"]);
  check("ADS grew", third["ads.model_metrics"] > second["ads.model_metrics"]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n[e2e] batch: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
