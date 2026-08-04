/**
 * ReviewGate tests — risk-tiered trigger, hard triggers, budgets, and the
 * path-based trigger heuristic.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReviewGate,
  inferTriggersFromPaths,
  MODE_BUDGETS,
  runnerModeFlags,
} from "../../src/reviewer/gate/review-gate.ts";
import type { ReviewGateInput } from "../../src/reviewer/gate/review-gate.ts";

function gate(score: Partial<ReviewGateInput["score"]>, triggers: ReviewGateInput["triggers"] = []) {
  return evaluateReviewGate({
    score: { impact: 0, reversibility: 0, complexity: 0, uncertainty: 0, autonomy: 0, ...score },
    triggers,
  });
}

describe("score -> mode thresholds", () => {
  test("total <= 3 -> NONE", () => {
    assert.equal(gate({ impact: 1, complexity: 1 }), "NONE");
  });
  test("4-6 -> DETERMINISTIC_ONLY", () => {
    assert.equal(gate({ impact: 2, complexity: 2, uncertainty: 1 }), "DETERMINISTIC_ONLY");
  });
  test("7-10 -> STANDARD", () => {
    assert.equal(gate({ impact: 2, complexity: 2, uncertainty: 2, autonomy: 2 }), "STANDARD");
  });
  test("11-15 -> STRICT", () => {
    assert.equal(gate({ impact: 3, reversibility: 3, complexity: 2, uncertainty: 2, autonomy: 2 }), "STRICT");
  });
  test("score capped at 15", () => {
    assert.equal(gate({ impact: 3, reversibility: 3, complexity: 3, uncertainty: 3, autonomy: 3 }), "STRICT");
  });
});

describe("hard triggers override the score tier", () => {
  test("CREDENTIALS -> at least STRICT even for a tiny score", () => {
    assert.equal(gate({ impact: 1 }, ["CREDENTIALS"]), "STRICT");
  });
  test("PRODUCTION_WRITE -> STRICT", () => {
    assert.equal(gate({ impact: 1 }, ["PRODUCTION_WRITE"]), "STRICT");
  });
  test("DATA_DELETE_OR_MIGRATION -> STRICT", () => {
    assert.equal(gate({ impact: 1 }, ["DATA_DELETE_OR_MIGRATION"]), "STRICT");
  });
  test("STATISTICAL_OR_PREDICTIVE -> STRICT", () => {
    assert.equal(gate({ impact: 1 }, ["STATISTICAL_OR_PREDICTIVE"]), "STRICT");
  });
  test("EXTERNAL_PUBLICATION -> at least STANDARD", () => {
    assert.equal(gate({ impact: 1 }, ["EXTERNAL_PUBLICATION"]), "STANDARD");
    assert.equal(gate({ impact: 3, reversibility: 3, complexity: 3, uncertainty: 3, autonomy: 3 }, ["EXTERNAL_PUBLICATION"]), "STRICT");
  });
  test("DATA_QUALITY_WARNING -> never NONE", () => {
    assert.equal(gate({ impact: 1 }, ["DATA_QUALITY_WARNING"]), "DETERMINISTIC_ONLY");
    assert.equal(gate({ impact: 2, complexity: 2, uncertainty: 2, autonomy: 2 }, ["DATA_QUALITY_WARNING"]), "STANDARD");
  });
});

describe("runner mode flags", () => {
  test("NONE/DETERMINISTIC_ONLY never call the semantic model", () => {
    assert.deepEqual(runnerModeFlags("NONE"), { semantic: false, shadow: false });
    assert.deepEqual(runnerModeFlags("DETERMINISTIC_ONLY"), { semantic: false, shadow: false });
  });
  test("STANDARD: semantic once, no shadow", () => {
    assert.deepEqual(runnerModeFlags("STANDARD"), { semantic: true, shadow: false });
  });
  test("STRICT: semantic + shadow", () => {
    assert.deepEqual(runnerModeFlags("STRICT"), { semantic: true, shadow: true });
  });
});

describe("budgets", () => {
  test("STRICT allows more context than STANDARD", () => {
    assert.ok(MODE_BUDGETS.STRICT.maxInputTokens > MODE_BUDGETS.STANDARD.maxInputTokens);
    assert.ok(MODE_BUDGETS.STRICT.maxSemanticCalls >= MODE_BUDGETS.STANDARD.maxSemanticCalls);
  });
  test("DETERMINISTIC_ONLY has zero semantic calls", () => {
    assert.equal(MODE_BUDGETS.DETERMINISTIC_ONLY.maxSemanticCalls, 0);
    assert.equal(MODE_BUDGETS.DETERMINISTIC_ONLY.maxInputTokens, 0);
  });
});

describe("path-based trigger heuristic", () => {
  test("auth/credential paths -> CREDENTIALS", () => {
    assert.ok(inferTriggersFromPaths(["src/auth/keys.ts"]).includes("CREDENTIALS"));
  });
  test("write-gate path -> PRODUCTION_WRITE", () => {
    assert.ok(inferTriggersFromPaths(["pipelines/common/write_gate.py"]).includes("PRODUCTION_WRITE"));
  });
  test("delete/migration path -> DATA_DELETE_OR_MIGRATION", () => {
    assert.ok(inferTriggersFromPaths(["services/gateway/migrations/002_drop.sql"]).includes("DATA_DELETE_OR_MIGRATION"));
  });
  test("statistics path -> STATISTICAL_OR_PREDICTIVE", () => {
    assert.ok(inferTriggersFromPaths(["analysis/correlation.py"]).includes("STATISTICAL_OR_PREDICTIVE"));
  });
  test("doc/format paths trigger nothing", () => {
    assert.deepEqual(inferTriggersFromPaths(["docs/readme.md", "src/format.ts", "components/button.tsx"]), []);
  });
});
