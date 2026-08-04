/**
 * E2E: Governance Phase 4 — placement planning + approval.
 *
 * Verifies: deterministic layer validation (ODS/DWD/DWS/ADS/FEATURE_STORE),
 * controlled-target enforcement, approval gate before any write, and that
 * rejected/unapproved plans cannot be consumed.
 *
 * Run: node --experimental-strip-types experiments/e2e-governance-phase4.mts
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

const GOV_ROOT = join(tmpdir(), `gov-phase4-${Date.now()}`);
const py = (code: string) => execFileSync("python3", ["-c", code], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  env: { ...process.env, PIPELINE_GOVERNANCE_ROOT: GOV_ROOT },
}).trim().split("\n").pop()!;

console.log("[e2e] Governance Phase 4\n");

try {
  // A. valid DWD placement proposed + approved
  console.log("A. DWD placement propose → approve");
  const a = JSON.parse(py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.placement import PlacementGovernance
g = PlacementGovernance(Repository())
plan = {"placementPlanId": "pp_e2e_dwd", "version": 1,
        "sourceDataset": "source.events", "targetLayer": "DWD",
        "targetDataset": "dwd.loan_application_detail",
        "rationale": "clean loan detail for downstream analysis",
        "grainDetail": "per loan application", "derivation": "RAW",
        "targetSchemaRef": "schema-spec:schema_001@1",
        "primaryKey": ["application_id"], "partitioning": ["event_time"],
        "writeMode": "INCREMENTAL", "schemaEvolutionPolicy": "ADDITIVE",
        "retentionPolicy": "90d", "backfillRequired": False,
        "affectedDownstream": ["dws.feature_values"], "qualityGateRefs": [],
        "assumptions": [], "risks": [], "status": "DRAFT"}
proposed = g.propose(plan)
try:
    g.require_approved(proposed["placementPlanId"])
    blocked = False
except ValueError:
    blocked = True
approved = g.approve(proposed["placementPlanId"], os_actor="operator@host")
consumable = g.require_approved(proposed["placementPlanId"])
print(json.dumps({"blockedBeforeApproval": blocked,
                  "approvedStatus": approved["status"],
                  "consumableStatus": consumable["status"]}))
`));
  check("unapproved plan cannot be consumed", a.blockedBeforeApproval === true);
  check("approval sets APPROVED", a.approvedStatus === "APPROVED");
  check("approved plan consumable", a.consumableStatus === "APPROVED");

  // B. layer validation rejects invalid placements
  console.log("B. layer validation");
  const b = JSON.parse(py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.placement import PlacementGovernance
g = PlacementGovernance(Repository())
base = {"placementPlanId": "pp_x", "version": 1, "sourceDataset": "s",
        "targetSchemaRef": "r", "primaryKey": ["k"], "partitioning": ["event_time"],
        "writeMode": "APPEND", "schemaEvolutionPolicy": "ADDITIVE",
        "retentionPolicy": "d", "backfillRequired": False,
        "affectedDownstream": [], "qualityGateRefs": [],
        "assumptions": [], "risks": [], "status": "DRAFT"}
ods_bad = g.validate_plan({**base, "targetLayer": "ODS", "targetDataset": "ods.streaming_events",
                           "rationale": "final metric", "derivation": "DERIVED"})
ads_bad = g.validate_plan({**base, "targetLayer": "ADS", "targetDataset": "ads.model_metrics",
                           "rationale": "x"})
uncontrolled = g.validate_plan({**base, "targetLayer": "DWD", "targetDataset": "foo.bar",
                                "rationale": "whatever"})
mismatch = g.validate_plan({**base, "targetLayer": "ADS", "targetDataset": "dws.feature_values",
                            "rationale": "a very explicit consumption purpose for reports"})
print(json.dumps({"odsRejected": any("ODS must be RAW" in e for e in ods_bad),
                  "adsRejected": any("ADS requires" in e for e in ads_bad),
                  "uncontrolledRejected": any("not a controlled harness target" in e for e in uncontrolled),
                  "mismatchRejected": any("layer/namespace mismatch" in e for e in mismatch)}))
`));
  check("ODS derived-metric placement rejected", b.odsRejected === true);
  check("ADS without purpose rejected", b.adsRejected === true);
  check("uncontrolled target rejected", b.uncontrolledRejected === true);
  check("layer/namespace mismatch rejected", b.mismatchRejected === true);

  // C. reject is terminal
  console.log("C. reject terminal");
  const c = JSON.parse(py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.placement import PlacementGovernance
g = PlacementGovernance(Repository())
plan = {"placementPlanId": "pp_rej", "version": 1, "sourceDataset": "s",
        "targetLayer": "DWD", "targetDataset": "dwd.loan_application_detail",
        "rationale": "valid plan", "grainDetail": "per loan application",
        "derivation": "RAW", "targetSchemaRef": "r",
        "primaryKey": ["k"], "partitioning": ["event_time"],
        "writeMode": "APPEND", "schemaEvolutionPolicy": "ADDITIVE",
        "retentionPolicy": "d", "backfillRequired": False,
        "affectedDownstream": [], "qualityGateRefs": [],
        "assumptions": [], "risks": [], "status": "DRAFT"}
p = g.propose(plan)
g.reject(p["placementPlanId"], os_actor="op")
try:
    g.require_approved(p["placementPlanId"])
    consumable = True
except ValueError:
    consumable = False
print(json.dumps({"rejectedNotConsumable": consumable is False}))
`));
  check("rejected plan not consumable", c.rejectedNotConsumable === true);
} finally {
  rmSync(GOV_ROOT, { recursive: true, force: true });
}

console.log(`\n[e2e] governance phase4: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
