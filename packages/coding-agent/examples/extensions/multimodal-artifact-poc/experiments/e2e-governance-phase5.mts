/**
 * E2E: Governance Phase 5 — DWS → ADS CDXR feature promotion gate.
 *
 * Uses a stub CDXR caller (no real training data); verifies the promotion
 * lifecycle: candidate → CDXR assessment → operator decision → only
 * APPROVED_FOR_ADS enters ADS; change requests invalidate old approvals and
 * require a fresh review cycle.
 *
 * Run: node --experimental-strip-types experiments/e2e-governance-phase5.mts
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

const GOV_ROOT = join(tmpdir(), `gov-phase5-${Date.now()}`);
const py = (code: string) => execFileSync("python3", ["-c", code], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  env: { ...process.env, PIPELINE_GOVERNANCE_ROOT: GOV_ROOT },
}).trim().split("\n").pop()!;

console.log("[e2e] Governance Phase 5\n");

try {
  // A. candidate → CDXR → approve → APPROVED_FOR_ADS
  console.log("A. promotion approval");
  const a = JSON.parse(py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.cdxr_gate import CdxrPromotionGate
repo = Repository()
def cdxr(tu):
    return {"status": "ALLOW" if tu.get("leakageSafe") else "BLOCK",
            "checkedRules": ["TARGET_IN_FEATURES"], "disabledRules": [], "warnings": []}
g = CdxrPromotionGate(repo, cdxr_caller=cdxr)
tu = {"predictionTarget": "default", "label": "is_default",
      "featureSet": ["feature_income"], "observationTime": "event_time",
      "labelWindow": "30d", "trainValidationTestSplit": "80/10/10",
      "datasetAndSnapshot": "dws.feature_values@v3",
      "featureAvailabilityTime": "event_time", "leakageSafe": True}
review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3", tu)
try:
    g.require_approved(review["reviewId"])
    blocked = False
except ValueError:
    blocked = True
decided = g.decide(review["reviewId"], "APPROVE", os_actor="operator@host")
consumable = g.require_approved(review["reviewId"])
print(json.dumps({"blockedBefore": blocked, "cdxrStatus": review["cdxrAssessment"]["status"],
                  "finalStatus": decided["status"], "consumable": consumable["status"]}))
`));
  check("not consumable before approval", a.blockedBefore === true);
  check("CDXR ran (ALLOW)", a.cdxrStatus === "ALLOW");
  check("APPROVE → APPROVED_FOR_ADS", a.finalStatus === "APPROVED_FOR_ADS");
  check("approved feature consumable", a.consumable === "APPROVED_FOR_ADS");

  // B. BLOCKED CDXR + change request invalidates approval
  console.log("B. blocked + change cycle");
  const b = JSON.parse(py(`
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.repository import Repository
from pipelines.governance.cdxr_gate import CdxrPromotionGate
repo = Repository()
def cdxr(tu):
    return {"status": "BLOCK", "checkedRules": ["POST_OUTCOME_FEATURE"], "disabledRules": [], "warnings": ["leakage"]}
g = CdxrPromotionGate(repo, cdxr_caller=cdxr)
tu = {"predictionTarget": "default", "label": "is_default", "featureSet": ["f1"],
      "observationTime": "t", "labelWindow": "30d", "trainValidationTestSplit": "80/10/10",
      "datasetAndSnapshot": "dws.feature_values@v3", "featureAvailabilityTime": "t", "leakageSafe": False}
review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3", tu)
changed = g.request_change(review["reviewId"], os_actor="op", reason="leakage")
try:
    g.require_approved(review["reviewId"])
    consumable = True
except ValueError:
    consumable = False
# after a change cycle a FRESH review id is required
print(json.dumps({"blocked": review["cdxrAssessment"]["status"], "changedStatus": changed["status"],
                  "notConsumable": consumable is False, "rerunRequired": g.re_run_required(review["reviewId"])}))
`));
  check("CDXR BLOCK detected", b.blocked === "BLOCK");
  check("change request → CHANGES_REQUESTED", b.changedStatus === "CHANGES_REQUESTED");
  check("old approval not consumable after change", b.notConsumable === true);
  check("re-run required", b.rerunRequired === true);
} finally {
  rmSync(GOV_ROOT, { recursive: true, force: true });
}

console.log(`\n[e2e] governance phase5: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
