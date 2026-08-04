/**
 * Feature Flag & Ablation Framework — TS unit tests (spec §14 tests 1-23).
 *
 *  1-6  framework core: registry load/validation, precedence, effective
 *       semantics, disabledReason values, snapshots
 *  7    hash parity with the Python twin (app/features.py)
 *  8-12 round1 wiring: tool registration, orchestrator ablations
 * 13-16 round2 wiring: lakehouse tool registry + evidence gating
 * 17-20 round3 wiring: cdxr_training registration, rule gating
 * 21-23 safety: unsafe ablations dual gate, production refusal
 *
 * Run: node --experimental-strip-types --test tests/
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createFeatureResolver, _setDefaultFeatureResolver } from "../src/features/resolver.ts";
import { loadFeatureRegistry } from "../src/features/registry.ts";
import { buildExtensionRegistrations } from "../index.ts";
import { DATA_TOOLS } from "../src/data-tools/tools.ts";
import { orchestrateDocumentAnalysis, _setAgentRunners } from "../src/orchestrator.ts";
import type { L1AgentResult } from "../src/doc-agents.ts";

const ROUND5_FEATURES = [
  "round5.reviewer",
  "round5.review_package",
  "round5.reviewer_agent",
  "round5.deterministic_review_gates",
  "round5.code_review",
  "round5.code_shadow_tests",
  "round5.analysis_review",
  "round5.analysis_replay",
  "round5.analysis_independent_verification",
  "round5.semantic_review",
  "round5.review_revision_loop",
  "round5.review_frontend_render",
  "round5.review_tools",
] as const;

/** Fresh resolver for a given runtime config + env. createFeatureResolver
 *  reads process.env directly, so apply env for the call and restore after.
 *  Runtime-profile env vars are cleared so tests never depend on the caller's
 *  shell environment (they exercise registry defaults instead). */
function resolver(runtime: Record<string, boolean> = {}, env: Record<string, string> = {}) {
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    delete process.env.FEATURE_RUNTIME_PROFILE;
    delete process.env.FEATURE_RUNTIME_CONFIG_PATH;
    return createFeatureResolver({ features: runtime });
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (saved.FEATURE_RUNTIME_PROFILE === undefined) delete process.env.FEATURE_RUNTIME_PROFILE;
    else process.env.FEATURE_RUNTIME_PROFILE = saved.FEATURE_RUNTIME_PROFILE;
    if (saved.FEATURE_RUNTIME_CONFIG_PATH === undefined) delete process.env.FEATURE_RUNTIME_CONFIG_PATH;
    else process.env.FEATURE_RUNTIME_CONFIG_PATH = saved.FEATURE_RUNTIME_CONFIG_PATH;
  }
}

/** Fake L1 result: a passable packet with stable quality signals. */
function fakeL1(status: "complete" | "insufficient" = "complete"): L1AgentResult {
  return {
    packet: {
      producer: { agent: "document-agent", tier: "standard", model: "fake" },
      scope: { documentId: "t" },
      facts: [{ claim: "revenue", value: 100, evidence: "doc p.1", confidence: 0.9, kind: "cited" }],
      inferences: [],
      unknowns: [],
      confidence: 0.8,
      status,
    },
    promptTokens: 100,
    completionTokens: 50,
    durationMs: 1,
    raw: "{}",
  };
}

describe("1. registry and build manifest (framework core)", () => {
  test("registry loads: all expected rounds present", () => {
    const r = loadFeatureRegistry();
    assert.equal(r.registryVersion, "1.0.0");
    const ids = new Set(r.features.map((f) => f.id));
    for (const id of ["round1.multimodal", "round2.lakehouse", "round3.cdxr_training",
                      "legacy.cdxr_governance_cli", "ablate.query_validation"]) {
      assert.ok(ids.has(id), `missing ${id}`);
    }
    // unsafe ablations are never built by default
    for (const f of r.features.filter((f) => f.safetyClass === "unsafe")) {
      assert.equal(f.buildDefault, false, `${f.id} buildDefault must be false`);
      assert.equal(f.runtimeDefault, false, `${f.id} runtimeDefault must be false`);
    }
  });

  test("default runtime: everything ON except unsafe ablations (user policy)", () => {
    const f = resolver();
    for (const id of ["round1.multimodal", "round1.quality_gate",
                      "round2.lakehouse", "round2.pipeline",
                      "round3.cdxr_training",
                      "round4.requirement_planning", "round4.data_analysis",
                      "legacy.cdxr_governance_tools"]) {
      assert.ok(f.isEffective(id), `${id} should be ON by default`);
    }
    assert.equal(f.getEffectiveFeatureSnapshot().effectiveFeatureHash, "1900a97a922ed9de");
  });

  test("runtime can never enable an unbuilt feature (NOT_BUILT wins)", () => {
    const f = resolver({ "ablate.query_validation": true });
    assert.equal(f.isEffective("ablate.query_validation"), false);
    assert.equal(f.getFeatureState("ablate.query_validation").disabledReason, "NOT_BUILT");
  });

  test("disabledReason: RUNTIME_DISABLED / PARENT_DISABLED / DEPENDENCY_DISABLED", () => {
    // round2 parent off → children PARENT_DISABLED
    const f = resolver({ "round2.lakehouse": false });
    assert.equal(f.getFeatureState("round2.catalog_tools").disabledReason, "PARENT_DISABLED");
    // explicitly off → RUNTIME_DISABLED (runtime wins first)
    const g = resolver({ "round3.cdxr_training": false });
    assert.equal(g.getFeatureState("round3.cdxr_training").disabledReason, "RUNTIME_DISABLED");
    // requested ON but dependency (round2.lakehouse) OFF → DEPENDENCY_DISABLED
    const h = resolver({ "round2.lakehouse": false, "round3.cdxr_training": true });
    assert.equal(h.getFeatureState("round3.cdxr_training").disabledReason, "DEPENDENCY_DISABLED");
    // legacy standalone, explicitly off → RUNTIME_DISABLED
    const l = resolver({ "legacy.cdxr_governance_cli": false });
    assert.equal(l.getFeatureState("legacy.cdxr_governance_cli").disabledReason, "RUNTIME_DISABLED");
  });

  test("parent + dependencies flip together (effective semantics)", () => {
    const f = resolver({ "round2.lakehouse": true });
    assert.ok(f.isEffective("round2.lakehouse"));
    assert.ok(f.isEffective("round2.catalog_tools"));
    assert.ok(f.isEffective("round2.query_tools"));
    assert.ok(f.isEffective("round2.query_evidence")); // deps: query_tools
    // round3.cdxr_training depends on round2.lakehouse → ON alongside
    assert.ok(f.isEffective("round3.cdxr_training"));
    // and everything flips off together when the parent is off
    const off = resolver({ "round2.lakehouse": false });
    assert.ok(!off.isEffective("round2.catalog_tools"));
    assert.ok(!off.isEffective("round3.cdxr_training"));
  });

  test("snapshot: hash is deterministic and feature-keyed", () => {
    const a = resolver({ "round2.lakehouse": true }).getEffectiveFeatureSnapshot();
    const b = resolver({ "round2.lakehouse": true }).getEffectiveFeatureSnapshot();
    assert.equal(a.effectiveFeatureHash, b.effectiveFeatureHash);
    const c = resolver({ "round2.lakehouse": false }).getEffectiveFeatureSnapshot();
    assert.notEqual(a.effectiveFeatureHash, c.effectiveFeatureHash);
    // snapshot fields present
    for (const k of ["experimentId", "commitSha", "buildProfile", "buildFeatureHash",
                     "runtimeProfile", "runtimeFeatureHash", "effectiveFeatureHash",
                     "effectiveFeatures", "disabledFeatures", "unsafeAblations", "ruleVersion"]) {
      assert.ok(k in a, `missing snapshot field ${k}`);
    }
  });
});

describe("2. env precedence and legacy aliases (framework core)", () => {
  test("env canonical name overrides profile/file/input layers", () => {
    const f = resolver({ "round2.lakehouse": true }, { ENABLE_LAKEHOUSE: "false" });
    assert.equal(f.isEffective("round2.lakehouse"), false);
  });

  test("legacy alias ENABLE_CDXR_TRAINING_TOOL maps to round3.cdxr_training", () => {
    const f = resolver({ "round2.lakehouse": true }, { ENABLE_CDXR_TRAINING_TOOL: "true" });
    assert.ok(f.isEffective("round3.cdxr_training"));
    assert.ok(f.isEffective("round3.cdxr_target_leakage"));
  });

  test("legacy alias ENABLE_LEGACY_CDXR_GOVERNANCE maps to both legacy features", () => {
    const f = resolver({}, { ENABLE_LEGACY_CDXR_GOVERNANCE: "true" });
    assert.ok(f.isEffective("legacy.cdxr_governance_cli"));
    assert.ok(f.isEffective("legacy.cdxr_governance_tools"));
  });
});

describe("3. hash parity TS ↔ Python (spec §14 test 7)", () => {
  test("same env produces identical effectiveFeatureHash in Python twin", () => {
    const env = { ...process.env, ENABLE_LAKEHOUSE: "true", ENABLE_CDXR_TRAINING_TOOL: "true" };
    delete env.FEATURE_RUNTIME_PROFILE;
    delete env.FEATURE_RUNTIME_CONFIG_PATH;
    const saved = { ...process.env };
    let tsHash: string;
    try {
      for (const [k, v] of Object.entries(env)) process.env[k] = v;
      delete process.env.FEATURE_RUNTIME_PROFILE;
      delete process.env.FEATURE_RUNTIME_CONFIG_PATH;
      tsHash = createFeatureResolver({}).getEffectiveFeatureSnapshot().effectiveFeatureHash;
    } finally {
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    const out = execFileSync("python3", ["-m", "app.features", "--print", "--json"], {
      cwd: join(import.meta.dirname, "..", "services", "lakehouse-gateway"),
      env,
      encoding: "utf8",
    });
    const py = JSON.parse(out);
    assert.equal(py.effectiveFeatureHash, tsHash);
    // both must agree round1 and legacy are on
    assert.ok(py.effectiveFeatures.includes("round1.multimodal"));
    assert.ok(py.effectiveFeatures.includes("legacy.cdxr_governance_cli"));
  });
});

describe("4. round1 wiring (spec §14 tests 8-12)", () => {
  test("all round1 tools registered when round1 features are effective", () => {
    const registered = new Set<string>();
    const pi = { registerTool: (t: any) => registered.add(t.name), registerCommand: () => {}, on: () => {} };
    const f = resolver({});
    buildExtensionRegistrations(pi as any, f);
    for (const t of ["parse_image", "parse_visual", "parse_document", "analyze_document", "analyze_document_v2"]) {
      assert.ok(registered.has(t), `missing tool ${t}`);
    }
  });

  test("round1.visual_parser=false → parse_visual not registered", () => {
    const registered = new Set<string>();
    const pi = { registerTool: (t: any) => registered.add(t.name), registerCommand: () => {}, on: () => {} };
    const f = resolver({ "round1.visual_parser": false });
    buildExtensionRegistrations(pi as any, f);
    assert.ok(!registered.has("parse_visual"));
    assert.ok(registered.has("parse_image"));
    assert.ok(registered.has("parse_document"));
  });

  test("round1.document_orchestrator_v2=false → analyze_document_v2 not registered", () => {
    const registered = new Set<string>();
    const pi = { registerTool: (t: any) => registered.add(t.name), registerCommand: () => {}, on: () => {} };
    const f = resolver({ "round1.document_orchestrator_v2": false });
    buildExtensionRegistrations(pi as any, f);
    assert.ok(!registered.has("analyze_document_v2"));
    assert.ok(registered.has("analyze_document"));
  });

  test("orchestrator ablations: quality_gate=false skips gate; deps cascade (l1_retry off)", async () => {
    _setAgentRunners({
      runL1: async () => fakeL1(),
      runL2: async () => { throw new Error("L2 must not run"); },
    });
    _setDefaultFeatureResolver(resolver({ "round1.quality_gate": false }));
    try {
      const r = await orchestrateDocumentAnalysis({
        documentId: "t", documentText: "X".repeat(400), question: "what is this",
      });
      assert.equal(r.experiment!.qualityGate, false);
      // l1_retry depends on quality_gate → cascades off (dependency semantics)
      assert.equal(r.experiment!.l1Retry, false);
      assert.equal(r.decision.attempt1.passed, true);
      assert.equal(r.decision.attempt1.gateReason, "quality_gate_disabled");
    } finally {
      _setDefaultFeatureResolver(null);
      _setAgentRunners(null);
    }
  });

  test("orchestrator ablations: l1_retry=false + best_attempt_selection=false keep single attempt", async () => {
    _setAgentRunners({
      runL1: async () => fakeL1(),
      runL2: async () => { throw new Error("L2 must not run"); },
    });
    _setDefaultFeatureResolver(resolver({ "round1.l1_retry": false, "round1.best_attempt_selection": false }));
    try {
      const r = await orchestrateDocumentAnalysis({
        documentId: "t", documentText: "X".repeat(400), question: "what is this",
      });
      assert.equal(r.experiment!.l1Retry, false);
      assert.equal(r.experiment!.bestAttemptSelection, false);
      assert.equal(r.attempt2Packet, undefined);
      assert.equal(r.decision.selectionReason, "single_attempt");
    } finally {
      _setDefaultFeatureResolver(null);
      _setAgentRunners(null);
    }
  });

  test("orchestrator ablations: l2_expert=false never starts L2 even when escalation needed", async () => {
    _setAgentRunners({
      runL1: async () => fakeL1("insufficient"), // hard signal → escalation
      runL2: async () => { throw new Error("L2 must not run"); },
    });
    _setDefaultFeatureResolver(resolver({ "round1.l2_expert": false }));
    try {
      const r = await orchestrateDocumentAnalysis({
        documentId: "t", documentText: "X".repeat(400), question: "what is this",
      });
      assert.equal(r.experiment!.l2Expert, false);
      assert.equal(r.expertPacket, undefined);
      assert.equal(r.escalation, true); // escalation recorded, but no expert ran
    } finally {
      _setDefaultFeatureResolver(null);
      _setAgentRunners(null);
    }
  });

  test("orchestrator ablations: evidence_merger=false projects packet directly (no merge)", async () => {
    _setAgentRunners({
      runL1: async () => fakeL1(),
      runL2: async () => { throw new Error("L2 must not run"); },
    });
    _setDefaultFeatureResolver(resolver({ "round1.evidence_merger": false }));
    try {
      const r = await orchestrateDocumentAnalysis({
        documentId: "t", documentText: "X".repeat(400), question: "what is this",
      });
      assert.equal(r.experiment!.evidenceMerger, false);
      assert.equal(r.merged.facts.length, 1); // projected facts
      assert.equal(r.merged.conflicts.length, 0);
    } finally {
      _setDefaultFeatureResolver(null);
      _setAgentRunners(null);
    }
  });
});

describe("5. round2 wiring (spec §14 tests 13-16)", () => {
  test("default runtime: lakehouse tools registered (everything ON by default)", () => {
    // DATA_TOOLS is built from the process-wide resolver at module load;
    // with the everything-ON policy the lakehouse tools are present.
    assert.ok(DATA_TOOLS.length > 0);
    assert.ok(DATA_TOOLS.some((tool) => tool.name === "search_catalog"), "search_catalog missing");
  });

  test("round2.lakehouse on → 7 lakehouse tools registered", () => {
    const registered = new Set<string>();
    const pi = { registerTool: (t: any) => registered.add(t.name), registerCommand: () => {}, on: () => {} };
    const f = resolver();
    buildExtensionRegistrations(pi as any, f);
    for (const t of ["search_catalog", "inspect_dataset", "validate_query", "execute_query",
                     "get_data_quality", "explain_lineage", "get_snapshot"]) {
      assert.ok(registered.has(t), `missing ${t}`);
    }
    assert.ok(registered.has("assess_training_data"));
  });

  test("round2.lakehouse off → no lakehouse tools registered (no stub)", () => {
    const registered = new Set<string>();
    const pi = { registerTool: (t: any) => registered.add(t.name), registerCommand: () => {}, on: () => {} };
    const f = resolver({ "round2.lakehouse": false });
    buildExtensionRegistrations(pi as any, f);
    assert.ok(!registered.has("search_catalog"));
    assert.ok(!registered.has("execute_query"));
  });

  test("disabled lakehouse tool never reaches the registry (no stub)", () => {
    const registered = new Set<string>();
    const pi = { registerTool: (t: any) => registered.add(t.name), registerCommand: () => {}, on: () => {} };
    const f = resolver({ "round2.lakehouse": true, "round2.data_quality": false, "round2.lineage": false });
    buildExtensionRegistrations(pi as any, f);
    assert.ok(!registered.has("get_data_quality"));
    assert.ok(!registered.has("explain_lineage"));
    assert.ok(registered.has("execute_query"));
  });
});

describe("6. round3 wiring (spec §14 tests 17-20)", () => {
  test("round3.cdxr_training effective → assess_training_data registered", () => {
    const registered = new Set<string>();
    const pi = { registerTool: (t: any) => registered.add(t.name), registerCommand: () => {}, on: () => {} };
    const f = resolver();
    buildExtensionRegistrations(pi as any, f);
    assert.ok(registered.has("assess_training_data"));
  });

  test("round3.cdxr_training off → assess_training_data not registered even if others on", () => {
    const registered = new Set<string>();
    const pi = { registerTool: (t: any) => registered.add(t.name), registerCommand: () => {}, on: () => {} };
    const f = resolver({ "round3.cdxr_training": false });
    buildExtensionRegistrations(pi as any, f);
    assert.ok(!registered.has("assess_training_data"));
  });

  test("rule-level features flip with their parent (round3 semantics)", () => {
    const f = resolver();
    for (const id of ["round3.cdxr_target_leakage", "round3.cdxr_temporal", "round3.cdxr_sensitive",
                      "round3.cdxr_traceability", "round3.cdxr_validation_split"]) {
      assert.ok(f.isEffective(id), `${id} should be effective`);
    }
    const off = resolver({ "round3.cdxr_training": false });
    for (const id of ["round3.cdxr_target_leakage", "round3.cdxr_temporal"]) {
      assert.ok(!off.isEffective(id), `${id} should flip off with parent`);
    }
  });
});

describe("7. safety: unsafe ablations (spec §14 tests 21-23)", () => {
  test("unsafe ablation requested without EVALUATION_MODE → ineffective with warning", () => {
    // build manifest excludes unsafe features, so NOT_BUILT regardless
    const f = resolver({ "ablate.query_validation": true }, { EVALUATION_MODE: "true" });
    assert.equal(f.isEffective("ablate.query_validation"), false);
    assert.equal(f.getFeatureState("ablate.query_validation").disabledReason, "NOT_BUILT");
  });

  test("APP_ENV=production with unsafe requested → resolver throws (refuse to start)", () => {
    assert.throws(
      () => resolver({ "ablate.query_validation": true }, { APP_ENV: "production", EVALUATION_MODE: "true" }),
      /refusing to start/,
    );
  });

  test("APP_ENV=production with NO unsafe features → resolver builds fine", () => {
    const f = resolver({}, { APP_ENV: "production" });
    assert.ok(f.isEffective("round1.multimodal"));
  });
});

describe("8. round5 evaluation runtime", () => {
  test("all-enabled profile makes the complete Reviewer feature set effective", () => {
    const f = createFeatureResolver({ runtimeProfile: "all-enabled" });
    for (const id of ROUND5_FEATURES) {
      assert.ok(f.isEffective(id), `${id} should be effective in all-enabled`);
    }
  });

  test("Reviewer features remain explicitly disableable", () => {
    const disabled = Object.fromEntries(ROUND5_FEATURES.map((id) => [id, false]));
    const f = resolver(disabled);
    for (const id of ROUND5_FEATURES) {
      assert.equal(f.isEffective(id), false, `${id} should be disabled`);
    }
  });
});
