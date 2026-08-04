/**
 * E2E: Streaming Pipeline — replay events with dedup/watermark/checkpoint,
 * verify counters, ODS facts, kill-and-restart recovery (no duplicate
 * consumption).
 *
 * Run: node --experimental-strip-types experiments/e2e-streaming-pipeline.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function runStreaming(root: string, extra: string[] = []): string {
  return execFileSync("python3", ["-m", "pipelines.run", "--mode", "streaming", "--profile", "small", ...extra], {
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

const COUNTERS = `
import json, os, sys
sys.path.insert(0, ".")
from pathlib import Path
from pipelines.common.config import PipelineConfig
from pipelines.streaming.engine import load_state, checkpoint_path
cfg = PipelineConfig(root=Path(os.environ["PIPELINE_TEST_ROOT"]), mode="streaming", profile="small")
state = load_state(cfg)
print(json.dumps({"counters": state.counters, "seen": len(state.seen_event_ids), "lastOffset": state.last_offset, "watermark": state.watermark}))
`;

const ODS = `
import json, os, sys
sys.path.insert(0, ".")
from pathlib import Path
from pipelines.common.config import PipelineConfig, open_catalog
cfg = PipelineConfig(root=Path(os.environ["PIPELINE_TEST_ROOT"]), mode="streaming", profile="small")
catalog = open_catalog(cfg.warehouse)
rows = catalog.load_table("ods.streaming_events").scan().to_arrow().to_pylist()
ids = [r["event_id"] for r in rows]
out = {"rows": len(rows), "unique": len(set(ids)), "dup": len(ids) - len(set(ids))}
out["too_late"] = sum(1 for r in rows if r.get("event_id") and "too_late" in str(r["event_id"]))
out["invalid"] = sum(1 for r in rows if not r.get("event_id"))
print(json.dumps(out))
`;

console.log("[e2e] Streaming Pipeline\n");
const root = mkdtempSync(join(tmpdir(), "pipeline-stream-e2e-"));

try {
  // A. fresh run from empty warehouse
  console.log("A. first replay");
  runStreaming(root, ["--reset"]);
  const c1 = py(root, COUNTERS);
  check("accepted = 72", c1.counters.accepted === 72, JSON.stringify(c1.counters));
  check("duplicate = 6", c1.counters.duplicate === 6);
  check("late > 0", c1.counters.late > 0, `late=${c1.counters.late}`);
  check("tooLate = 4", c1.counters.tooLate === 4);
  check("invalid = 2", c1.counters.invalid === 2);

  const o1 = py(root, ODS);
  check("ODS 72 rows, no duplicate facts", o1.rows === 72 && o1.dup === 0, JSON.stringify(o1));
  check("too-late never in ODS", o1.too_late === 0);
  check("invalid never in ODS", o1.invalid === 0);

  // A2. micro-batch commits: 72 accepted events must NOT produce 72 commits
  console.log("A2. micro-batch commit count");
  const MANIFEST = `
import json, os, sys, glob
sys.path.insert(0, ".")
from pathlib import Path
os.environ.setdefault("PIPELINE_TEST_ROOT", "")
manifests = sorted(glob.glob(os.environ["PIPELINE_TEST_ROOT"] + "/outputs/manifests/execution-*.json"))
d = json.load(open(manifests[-1]))
print(json.dumps(d["streamCommits"]))
`;
  const mc = py(root, MANIFEST);
  check("commitsCreated = 3 (72 events / microBatchSize 25)", mc.commitsCreated === 3, JSON.stringify(mc));
  check("snapshotsCreated = 3", mc.snapshotsCreated === 3);
  check("dataFilesCreated = 72", mc.dataFilesCreated === 72);

  // B. re-run with checkpoint (already consumed) → no new rows, no new commit
  console.log("B. checkpoint replay (idempotent)");
  runStreaming(root);
  const o2 = py(root, ODS);
  check("ODS unchanged after checkpoint replay", o2.rows === 72 && o2.dup === 0, JSON.stringify(o2));
  const mc2 = py(root, MANIFEST);
  check("empty replay creates no new commits", mc2.commitsCreated === 0, JSON.stringify(mc2));

  // C. simulate kill mid-stream: rewind checkpoint to half, restore seen,
  //    then resume — events after the rewind point must be reprocessed but
  //    must NOT create duplicate facts for already-written rows.
  console.log("C. crash + restart recovery");
  const REWIND = `
import json, os, sys
sys.path.insert(0, ".")
from pathlib import Path
from pipelines.common.config import PipelineConfig
from pipelines.streaming.engine import load_state, save_state
cfg = PipelineConfig(root=Path(os.environ["PIPELINE_TEST_ROOT"]), mode="streaming", profile="small")
state = load_state(cfg)
# rewind to offset 50, drop seen ids after that (simulates crash before commit)
state.last_offset = 50
state.seen_event_ids = state.seen_event_ids[:50]
save_state(cfg, state)
print(json.dumps({"rewound": True}))
`;
  py(root, REWIND);
  runStreaming(root);
  const o3 = py(root, ODS);
  // Recovery: ODS is the source of truth — committed event ids are merged
  // into seen at startup, so even after a rewind nothing is double-written.
  check("rewind + resume adds no duplicates", o3.dup === 0, JSON.stringify(o3));
  check("rewind + resume adds no new rows (all already committed)",
    o3.rows === 72, `rows=${o3.rows}`);
  runStreaming(root); // consume the remainder again (now fully seen)
  const o4 = py(root, ODS);
  check("consistent checkpoint replay adds no duplicates", o4.dup === 0, JSON.stringify(o4));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n[e2e] streaming: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
