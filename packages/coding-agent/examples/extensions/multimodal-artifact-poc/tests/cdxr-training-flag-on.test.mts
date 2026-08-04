/**
 * TS unit test for the ENABLE_CDXR_TRAINING_TOOL=true registration path.
 *
 * node --test runs every test file in its own process, so setting the env
 * variable in a side-effect module BEFORE importing tools.ts is race-free.
 */
import "./set-cdxr-flag-on.ts";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ASSESS_TRAINING_DATA_TOOL,
  CDXR_TRAINING_TOOL_ENABLED,
  DATA_TOOLS,
} from "../src/data-tools/tools.ts";

describe("ENABLE_CDXR_TRAINING_TOOL=true", () => {
  test("flag is detected at module load", () => {
    assert.equal(CDXR_TRAINING_TOOL_ENABLED, true);
  });

  test("registers exactly one new tool: assess_training_data", () => {
    const names = DATA_TOOLS.map((t) => t.name);
    assert.equal(DATA_TOOLS.length, 9); // 7 lakehouse + assess_training_data + materialize_query
    assert.ok(names.includes("assess_training_data"));
    assert.equal(ASSESS_TRAINING_DATA_TOOL.name, "assess_training_data");
    // legacy governance tools stay out of the registry even with the flag on
    assert.ok(!names.includes("get_dataset_governance_profile"));
    assert.ok(!names.includes("list_governance_findings"));
    assert.ok(!names.includes("inspect_governance_finding"));
    assert.ok(!names.includes("explain_governance_evidence"));
    assert.ok(!names.includes("get_governance_review_status"));
  });
});
