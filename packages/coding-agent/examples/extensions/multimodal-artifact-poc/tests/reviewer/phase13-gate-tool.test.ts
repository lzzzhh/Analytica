/**
 * Phase 13 — P1: inspect_review_gate read-only tool + explainability.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerStore, canonicalHash } from "../../src/reviewer/store.ts";
import {
  gateInspectDetails,
  INSPECT_REVIEW_GATE_TOOL,
  renderGateExplanation,
} from "../../src/reviewer/gate/tool.ts";
import { MODE_BUDGETS } from "../../src/reviewer/gate/review-gate.ts";
import type { ReviewGateDecisionArtifact } from "../../src/reviewer/gate/review-gate.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "p13-"));
}

function gate(over: Partial<ReviewGateDecisionArtifact> = {}): ReviewGateDecisionArtifact {
  const base: ReviewGateDecisionArtifact = {
    schemaVersion: "1.0",
    gateDecisionId: "final_explain",
    stage: "FINAL",
    subjectType: "CODE_PROPOSAL",
    subjectId: "p1",
    subjectContentHash: "abc123def456",
    profile: "CODE",
    scores: { impact: 3, reversibility: 3, complexity: 2, uncertainty: 1, autonomy: 2, total: 11 },
    triggers: ["PRODUCTION_WRITE"],
    triggerSources: [
      { trigger: "PRODUCTION_WRITE", source: "PATH", evidence: "pipelines/common/write_gate.py" },
      { trigger: "PRODUCTION_WRITE", source: "DIFF", evidence: "writeFile pattern in diff" },
    ],
    reviewMode: "STRICT",
    deliveryMode: "NORMAL",
    restrictions: [],
    requiredChecks: ["integrity", "execution", "shadow", "semantic"],
    budget: MODE_BUDGETS.STRICT,
    policyVersion: "1.0.0",
    contentHash: "",
    createdAt: new Date().toISOString(),
  };
  const merged = { ...base, ...over };
  const { contentHash: _c, ...body } = merged;
  merged.contentHash = canonicalHash(body);
  return merged;
}

describe("gate explanation rendering", () => {
  test("summary shows mode, scores, triggers with sources, budget, checks", () => {
    const text = renderGateExplanation(gate());
    assert.ok(text.includes("mode STRICT"));
    assert.ok(text.includes("impact 3"));
    assert.ok(text.includes("PRODUCTION_WRITE [PATH]"));
    assert.ok(text.includes("PRODUCTION_WRITE [DIFF]"));
    assert.ok(text.includes("required checks: integrity, execution, shadow, semantic"));
    assert.ok(text.includes("budget: input 64000"));
    assert.ok(text.includes("policyVersion 1.0.0"));
  });
  test("exploratory delivery shows restrictions", () => {
    const g = gate({ deliveryMode: "EXPLORATORY_UNREVIEWED", reviewMode: "NONE", restrictions: ["NO_MERGE", "NO_PRODUCTION_WRITE"] });
    assert.ok(renderGateExplanation(g).includes("EXPLORATORY_UNREVIEWED"));
    assert.ok(renderGateExplanation(g).includes("NO_MERGE"));
  });
  test("explainModeDecision explains upgrades", () => {
    const g = gate(); // total 11 -> STRICT tier already; no upgrade note
    const details = gateInspectDetails(g);
    assert.ok(details.explanation.some((e) => e.includes("hard triggers")));
    assert.ok(details.explanation.some((e) => e.includes("score tier STRICT")));
  });
  test("explanation of an upgraded gate", () => {
    const g = gate({ scores: { impact: 1, reversibility: 1, complexity: 1, uncertainty: 1, autonomy: 1, total: 5 }, reviewMode: "STRICT" });
    const details = gateInspectDetails(g);
    assert.ok(details.explanation.some((e) => e.includes("upgraded")));
  });
});

describe("inspect_review_gate tool (read-only)", () => {
  test("reads a frozen gate from the store and renders summary", async () => {
    const root = tmp();
    const store = new ReviewerStore(root);
    const g = gate();
    await store.writeImmutable(`gate/${g.gateDecisionId}.json`, g);
    const prevRoot = process.env.REVIEWER_STORE_ROOT;
    process.env.REVIEWER_STORE_ROOT = root;
    const res = await INSPECT_REVIEW_GATE_TOOL.execute("t1", { gateDecisionId: g.gateDecisionId }, undefined, undefined, {} as never);
    if (prevRoot === undefined) delete process.env.REVIEWER_STORE_ROOT; else process.env.REVIEWER_STORE_ROOT = prevRoot;
    const text = (res.content[0] as { type: "text"; text: string }).text;
    assert.ok(text.includes("mode STRICT"));
    assert.ok(text.includes("PRODUCTION_WRITE"));
    // details carry the read-only structured view
    const details = res.details as { dashboardType: string };
    assert.equal(details.dashboardType, "REVIEW_GATE");
  });
  test("missing gate -> explicit error, no crash", async () => {
    const prevRoot = process.env.REVIEWER_STORE_ROOT;
    process.env.REVIEWER_STORE_ROOT = tmp();
    const res = await INSPECT_REVIEW_GATE_TOOL.execute("t2", { gateDecisionId: "nope" }, undefined, undefined, {} as never);
    if (prevRoot === undefined) delete process.env.REVIEWER_STORE_ROOT; else process.env.REVIEWER_STORE_ROOT = prevRoot;
    const text = (res.content[0] as { type: "text"; text: string }).text;
    assert.ok(text.includes("not found"));
  });
  test("no store configured -> notConfigured style message", async () => {
    const prev = process.env.REVIEWER_STORE_ROOT;
    delete process.env.REVIEWER_STORE_ROOT;
    const res = await INSPECT_REVIEW_GATE_TOOL.execute("t3", { gateDecisionId: "x" }, undefined, undefined, {} as never);
    if (prev !== undefined) process.env.REVIEWER_STORE_ROOT = prev;
    const text = (res.content[0] as { type: "text"; text: string }).text;
    assert.ok(text.includes("REVIEWER_STORE_ROOT"));
  });
  test("tool is registered under the round5 gate feature", async () => {
    const { DATA_TOOL_FEATURES } = await import("../../src/data-tools/tools.ts");
    const entry = DATA_TOOL_FEATURES.find(([t]) => t.name === "inspect_review_gate");
    assert.ok(entry, "inspect_review_gate registered");
    assert.equal(entry![1], "round5.deterministic_review_gates");
  });
});
