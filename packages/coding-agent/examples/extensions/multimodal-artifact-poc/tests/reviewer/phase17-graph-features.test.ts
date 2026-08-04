/**
 * Phase 17 — round6.graph_* feature gating.
 *
 * default runtime: graph features OFF (existing behavior unchanged).
 * all-enabled runtime: graph features effective.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFeatureResolver } from "../../src/features/resolver.ts";

const ROUND6_FEATURES = [
  "round6.graph_engine",
  "round6.graph_compiler",
  "round6.graph_validation",
  "round6.graph_executor",
  "round6.graph_scheduler",
  "round6.graph_event_store",
  "round6.graph_state_reducer",
  "round6.graph_artifact_edges",
  "round6.graph_feedback_routing",
  "round6.graph_review_integration",
  "round6.graph_skill_nodes",
  "round6.graph_human_gates",
  "round6.graph_observability",
  "round6.graph_frontend_render",
  "round6.graph_tool",
] as const;

describe("round6 graph features", () => {
  test("disabled by default (existing behavior unchanged)", () => {
    const f = createFeatureResolver({});
    for (const id of ROUND6_FEATURES) {
      assert.equal(f.isEffective(id), false, `${id} must be off on the default runtime`);
    }
  });

  test("all-enabled profile makes the full graph feature set effective", () => {
    const f = createFeatureResolver({ runtimeProfile: "all-enabled" });
    for (const id of ROUND6_FEATURES) {
      assert.ok(f.isEffective(id), `${id} should be effective in all-enabled`);
    }
  });

  test("parent off disables children", () => {
    const disabled = Object.fromEntries(ROUND6_FEATURES.map((id) => [id, false]));
    const f = createFeatureResolver({ features: disabled });
    for (const id of ROUND6_FEATURES) {
      assert.equal(f.isEffective(id), false);
    }
  });

  test("explicitly disableable (ablation-safe)", () => {
    const f = createFeatureResolver({
      runtimeProfile: "all-enabled",
      features: { "round6.graph_executor": false },
    });
    assert.equal(f.isEffective("round6.graph_executor"), false);
    // dependencies of the executor still resolve through the parent
    assert.ok(f.isEffective("round6.graph_scheduler"));
  });
});
