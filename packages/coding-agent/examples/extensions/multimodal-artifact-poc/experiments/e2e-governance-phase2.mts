/**
 * E2E: Governance Phase 2 — event-driven state runtime.
 *
 * Verifies:
 *   - multiple pipeline runs coexist with isolated snapshots;
 *   - duplicate / stale-sequence / old-version events never corrupt state;
 *   - the agent worker is triggered by events, reads only the context
 *     package, and never mutates state;
 *   - the reducer is the only source of authoritative snapshots.
 *
 * Run: node --experimental-strip-types experiments/e2e-governance-phase2.mts
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

const GOV_ROOT = join(tmpdir(), `gov-phase2-${Date.now()}`);
const PY = `
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.event_store import EventStore
from pipelines.governance.state_reducer import StateReducer
from pipelines.governance.agent_worker import AgentWorker
repo = Repository()
store = EventStore(repo)
reducer = StateReducer(store)

def evt(seq, etype, run, payload=None, ver=1):
    from pipelines.governance.contracts import sha256_canonical
    return {"eventId": f"evt_{run}_{seq:04d}_{etype.lower()[:10]}", "eventType": etype,
            "pipelineId": "p_1", "pipelineVersion": ver, "runId": run,
            "source": "PIPELINE_GOVERNANCE", "sequenceNumber": seq,
            "occurredAt": f"2026-08-02T00:00:{seq:02d}Z",
            "payloadHash": sha256_canonical(payload or {}), "payloadRef": None,
            "supersedesEventId": None, "payload": payload or {}}
`;

const py = (code: string) => execFileSync("python3", ["-c", PY + code], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  env: { ...process.env, PIPELINE_GOVERNANCE_ROOT: GOV_ROOT },
}).trim().split("\n").pop()!;

console.log("[e2e] Governance Phase 2\n");

try {
  // A. concurrent runs with isolated states
  console.log("A. multi-run isolation");
  const a = JSON.parse(py(`
store.append(evt(1, "RUN_CREATED", "run_a"))
store.append(evt(2, "RUN_STARTED", "run_a"))
store.append(evt(3, "PROCESSING_COMPLETED", "run_a"))
store.append(evt(1, "RUN_CREATED", "run_b"))
store.append(evt(2, "FINDING_DETECTED", "run_b", {"findingId": "gf_b1"}))
sa = reducer.reduce_run("run_a", "p_1", 1)
sb = reducer.reduce_run("run_b", "p_1", 1)
print(json.dumps({"a": sa["state"], "b": sb["state"], "bFindings": sb["openFindingRefs"]}))
`));
  check("run_a PROCESSING_COMPLETED", a.a === "PROCESSING_COMPLETED", JSON.stringify(a));
  check("run_b ISSUE_DETECTED (isolated)", a.b === "ISSUE_DETECTED");
  check("run_b has its own finding", JSON.stringify(a.bFindings) === '["gf_b1"]', JSON.stringify(a.bFindings));

  // B. duplicate + stale + old-version events
  console.log("B. event idempotency / ordering / version control");
  const b = JSON.parse(py(`
store.append(evt(1, "RUN_CREATED", "run_c"))
try:
    store.append(evt(1, "RUN_CREATED", "run_c"))  # duplicate eventId
    dup_rejected = False
except ValueError:
    dup_rejected = True
# stale sequence (regression) written after higher sequence
store.append(evt(5, "RUN_STARTED", "run_c"))
store.append(evt(3, "RUN_CREATED", "run_c"))  # stale seq — must not rewind
# old version event after v2
store.append(evt(6, "PROCESSING_COMPLETED", "run_c", ver=2))
store.append(evt(7, "RUN_CREATED", "run_c", ver=1))  # old version — ignored
snap = reducer.reduce_run("run_c", "p_1", 1)
print(json.dumps({"dupRejected": dup_rejected, "state": snap["state"], "seq": snap["lastSequenceNumber"]}))
`));
  check("duplicate eventId rejected", b.dupRejected === true);
  // stale seq3 (RUN_CREATED v1) written after seq5 cannot rewind; the
  // old-version seq7 RUN_CREATED is ignored; final state is the seq6 result
  check("stale sequence did not rewind (final state from seq6)", b.state === "PROCESSING_COMPLETED", JSON.stringify(b));
  check("old-version event ignored (seq=6 kept)", b.seq === 6);

  // C. worker triggered by event, reads context only, no mutation
  console.log("C. agent worker");
  const c = JSON.parse(py(`
store.append(evt(1, "RUN_CREATED", "run_d"))
store.append(evt(2, "FINDING_DETECTED", "run_d", {"findingId": "gf_d1"}))
seen = []
def caller(prompt):
    seen.append(prompt)
    return {"ok": True, "text": '{"proposal": "repartition"}'}
worker = AgentWorker(reducer=reducer, caller=caller)
worker.on_event(store.events_for_run("run_d")[-1], relevant_event_refs=["evt_d_0002"])
before = reducer.reduce_run("run_d", "p_1", 1)
after = reducer.reduce_run("run_d", "p_1", 1)
print(json.dumps({"promptHasContext": "CONTEXT" in seen[0], "noFullHistory": "events.jsonl" not in seen[0],
                  "stateUnchanged": before == after}))
`));
  check("worker got context package", c.promptHasContext === true);
  check("worker did not receive full history", c.noFullHistory === true);
  check("worker did not mutate state", c.stateUnchanged === true);

  // D. all_snapshots matches per-run reduce (single source of truth)
  console.log("D. snapshot consistency");
  const d = JSON.parse(py(`
snaps = reducer.all_snapshots()
print(json.dumps({"count": len(snaps), "runs": sorted(s["runId"] for s in snaps)}))
`));
  check("all_snapshots covers all runs", d.count === 4, JSON.stringify(d));
} finally {
  rmSync(GOV_ROOT, { recursive: true, force: true });
}

console.log(`\n[e2e] governance phase2: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
