/**
 * Phase 16 — delivery-chain tools (closes the tool-calling evaluation gap):
 * materialize_query, pipeline_ingest, write_gate_check, promote_analysis.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonHash, checkWriteAuthorization } from "../../src/pipelines/delivery-tools.ts";
import { createFeatureResolver } from "../../src/features/resolver.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "p16-"));
}

function writeRepoObject(root: string, type: string, id: string, version: number, content: unknown): void {
  const dir = join(root, "objects", type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}@${version}.json`), JSON.stringify({ type, id, version, content }));
}

function appendLedger(root: string, entry: Record<string, unknown>): void {
  const path = join(root, "ledger.jsonl");
  mkdirSync(root, { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

function approvedRepo(root: string, target: string, tamper = false): string {
  const now = new Date().toISOString();
  const pipelineSpec = {
    specId: "pspec_t", version: 1, pipelineId: "pipeline_t", sources: ["local.s"],
    target, executionMode: "BATCH", executionBackend: "PYICEBERG_LOCAL", updateMode: "APPEND",
    steps: [{ stepId: "write", operation: "WRITE", input: "local.s", output: target }],
    keys: { primaryKey: ["id"] }, timeSemantics: "PROCESSING_TIME",
    partitioning: [], schemaEvolutionPolicy: "ADDITIVE",
    assumptions: [], risks: [], createdAt: now,
  };
  const seal = {
    specId: "pspec_t", version: 1, approvalId: "ap_1", target,
    pipelineSpecHash: canonicalJsonHash(pipelineSpec),
    schemaSpecHash: "sha256:abc", draftArtifactHash: "sha256:def",
    createdAt: now,
  };
  if (tamper) seal.pipelineSpecHash = "sha256:tampered";
  writeRepoObject(root, "pipeline-spec", "pspec_t", 1, pipelineSpec);
  writeRepoObject(root, "approved-pipeline-spec", "pspec_t", 1, seal);
  writeRepoObject(root, "approval-decision", "dec_1", 1, {
    approvalId: "ap_1", decision: "APPROVE", approverSource: "OPERATOR_CLI",
    reviewId: "r", reviewContentHash: "h", decidedAt: now,
  });
  appendLedger(root, { type: "approved-pipeline-spec", id: "pspec_t", version: 1, at: now });
  appendLedger(root, { type: "approval-decision", id: "dec_1", version: 1, at: now });
  return root;
}

describe("write_gate_check", () => {
  test("authorized when a sealed OPERATOR_CLI approval covers the target", () => {
    const root = approvedRepo(tmp(), "eval_raw.sample");
    const state = checkWriteAuthorization("eval_raw.sample", root);
    assert.equal(state.authorized, true);
    assert.equal(state.approvalId, "ap_1");
  });

  test("blocked for an unrelated target", () => {
    const root = approvedRepo(tmp(), "eval_raw.sample");
    const state = checkWriteAuthorization("other.table", root);
    assert.equal(state.authorized, false);
  });

  test("blocked when the seal hash was tampered", () => {
    const root = approvedRepo(tmp(), "eval_raw.sample", true);
    const state = checkWriteAuthorization("eval_raw.sample", root);
    assert.equal(state.authorized, false);
    assert.ok(state.reasons.some((r) => r.includes("mismatch")), state.reasons.join(";"));
  });

  test("blocked when the repository does not exist", () => {
    const state = checkWriteAuthorization("eval_raw.sample", join(tmp(), "nope"));
    assert.equal(state.authorized, false);
  });
});

describe("promote_analysis tool", () => {
  test("PASS verdict authorizes formal delivery", async () => {
    const { authorizePromotion } = await import("../../src/reviewer/gate/review-gate.ts");
    const auth = authorizePromotion("PASS", { reviewMode: "STRICT", deliveryMode: "NORMAL", restrictions: [] });
    assert.equal(auth.allowed, true);
    assert.ok(auth.allowedActions.includes("MERGE_CODE"));
    assert.ok(auth.allowedActions.includes("PUBLISH_REPORT"));
  });

  test("ABSTAIN / CHANGES_REQUIRED / REJECT block formal delivery", async () => {
    const { authorizePromotion } = await import("../../src/reviewer/gate/review-gate.ts");
    for (const verdict of ["ABSTAIN", "CHANGES_REQUIRED", "REJECT"] as const) {
      const auth = authorizePromotion(verdict, { reviewMode: "STRICT", deliveryMode: "NORMAL", restrictions: [] });
      assert.equal(auth.allowed, false, `${verdict} must block promotion`);
      assert.ok(!auth.allowedActions.includes("PUBLISH_REPORT"));
    }
  });

  test("EXPLORATORY_UNREVIEWED only allows exploratory delivery", async () => {
    const { authorizePromotion } = await import("../../src/reviewer/gate/review-gate.ts");
    const auth = authorizePromotion("UNREVIEWED_LOW_RISK", {
      reviewMode: "NONE", deliveryMode: "EXPLORATORY_UNREVIEWED",
      restrictions: ["NO_MERGE", "NO_EXTERNAL_PUBLICATION", "NO_PRODUCTION_WRITE", "NO_FORMAL_REPORT", "NO_GOVERNANCE_APPROVAL"],
    });
    assert.ok(auth.allowedActions.includes("DELIVER_EXPLORATORY_RESULT"));
    assert.ok(!auth.allowedActions.includes("MERGE_CODE"));
    assert.ok(!auth.allowedActions.includes("PRODUCTION_WRITE"));
  });
});

describe("tool registration", () => {
  test("all-enabled profile exposes the four delivery-chain tools", async () => {
    const { buildExtensionRegistrations } = await import("../../index.ts");
    const registered: string[] = [];
    const pi = { registerTool: (t: { name: string }) => { registered.push(t.name); }, registerCommand: () => {}, on: () => {} } as never;
    buildExtensionRegistrations(pi as never, createFeatureResolver({ runtimeProfile: "all-enabled" }));
    for (const name of ["materialize_query", "pipeline_ingest", "write_gate_check", "promote_analysis"]) {
      assert.ok(registered.includes(name), `${name} must be registered (got ${registered.length} tools)`);
    }
  });

  test("round5 tools stay hidden on the default runtime; round2 pipeline tools are default-on", async () => {
    const { buildExtensionRegistrations } = await import("../../index.ts");
    const registered: string[] = [];
    const pi = { registerTool: (t: { name: string }) => { registered.push(t.name); }, registerCommand: () => {}, on: () => {} } as never;
    buildExtensionRegistrations(pi as never, createFeatureResolver({}));
    assert.ok(registered.includes("pipeline_ingest"), "round2.pipeline is default-on");
    assert.ok(!registered.includes("promote_analysis"), "round5.review_tools default off");
  });
});

describe("pipeline_ingest tool", () => {
  test("refuses (BLOCKED) when no governance repository exists — even in dry-run", async () => {
    const { PIPELINE_INGEST_TOOL } = await import("../../src/pipelines/delivery-tools.ts");
    const root = tmp();
    const contractPath = join(root, "contract.json");
    writeFileSync(contractPath, JSON.stringify({
      source: { path: join(root, "s.csv"), sha256: "0".repeat(64), format: "csv" },
      target: "eval_raw.sample", schemaPolicy: "strict", expectedSchema: [],
      primaryKey: ["id"], qualityRules: {}, approvalId: "none",
    }));
    const res = await PIPELINE_INGEST_TOOL.execute("t1", {
      contractPath, warehouse: join(root, "warehouse"), governanceRoot: join(root, "no-repo"), dryRun: true,
    }, undefined, undefined, {} as never);
    const text = (res.content[0] as { text: string }).text;
    assert.ok(text.includes("refused") || text.toLowerCase().includes("blocked"), text);
  });
});
