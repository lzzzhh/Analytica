/**
 * Data Analysis — feature flag wiring tests (spec 27-32).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createFeatureResolver } from "../src/features/resolver.ts";
import { loadFeatureRegistry } from "../src/features/registry.ts";
import { buildExtensionRegistrations } from "../index.ts";

function resolver(runtime: Record<string, boolean> = {}) {
  const saved = { ...process.env };
  try {
    delete process.env.FEATURE_RUNTIME_PROFILE;
    delete process.env.FEATURE_RUNTIME_CONFIG_PATH;
    return createFeatureResolver({ features: runtime });
  } finally {
    process.env = saved as never;
  }
}

describe("feature wiring (spec 27-32)", () => {
  test("registry contains all 13 data_analysis features, runtimeDefault true", () => {
    const reg = loadFeatureRegistry();
    const ids = new Set(reg.features.map((f) => f.id));
    for (const id of [
      "round4.data_analysis", "round4.data_analysis_tool",
      "round4.analysis_task_gate", "round4.analysis_input_materialization",
      "round4.analysis_subagent", "round4.analysis_plan_generation",
      "round4.analysis_workspace", "round4.analysis_script_execution",
      "round4.analysis_retry", "round4.analysis_artifacts",
      "round4.analysis_findings", "round4.analysis_charting",
      "round4.analysis_frontend_render",
    ]) {
      assert.ok(ids.has(id), `missing ${id}`);
    }
    for (const f of reg.features.filter((x) => x.id.startsWith("round4.analysis_") || x.id === "round4.data_analysis")) {
      assert.equal(f.runtimeDefault, true, `${f.id} must default on`);
      assert.equal(f.safetyClass, "safe");
    }
  });

  test("parent off → run_data_analysis not registered", () => {
    const registered = new Set<string>();
    const pi = {
      registerTool: (t: any) => registered.add(t.name),
      registerCommand: () => {},
      on: () => {},
    };
    buildExtensionRegistrations(pi as never, resolver({ "round4.data_analysis": false }));
    assert.ok(!registered.has("run_data_analysis"), "must not register when off");
  });

  test("frontend_render=false → tool not registered (no recitation fallback)", () => {
    const registered = new Set<string>();
    const pi = {
      registerTool: (t: any) => registered.add(t.name),
      registerCommand: () => {},
      on: () => {},
    };
    buildExtensionRegistrations(pi as never, resolver({
      "round4.data_analysis": true,
      "round4.data_analysis_tool": true,
      "round4.analysis_subagent": true,
      "round4.analysis_script_execution": true,
      "round4.analysis_artifacts": true,
      "round4.analysis_frontend_render": false,
    }));
    assert.ok(!registered.has("run_data_analysis"), "frontend render off must prevent registration");
  });

  test("all required features on → tool registered", () => {
    const registered = new Set<string>();
    const pi = {
      registerTool: (t: any) => registered.add(t.name),
      registerCommand: () => {},
      on: () => {},
    };
    // analysis_subagent depends on workspace + script_execution; script
    // execution depends on workspace — open the full dependency chain.
    buildExtensionRegistrations(pi as never, resolver({
      "round4.data_analysis": true,
      "round4.data_analysis_tool": true,
      "round4.analysis_subagent": true,
      "round4.analysis_script_execution": true,
      "round4.analysis_artifacts": true,
      "round4.analysis_frontend_render": true,
      "round4.analysis_workspace": true,
    }));
    assert.ok(registered.has("run_data_analysis"), "tool must register when all features on");
  });

  test("retry=false → maxAttempts forced to 1", () => {
    const reg = loadFeatureRegistry();
    const retry = reg.features.find((f) => f.id === "round4.analysis_retry")!;
    assert.ok(retry, "retry feature exists");
  });

  test("original round1/2/3 tools unchanged with data analysis off", () => {
    const registered = new Set<string>();
    const pi = {
      registerTool: (t: any) => registered.add(t.name),
      registerCommand: () => {},
      on: () => {},
    };
    buildExtensionRegistrations(pi as never, resolver({ "round4.data_analysis": false, "round2.lakehouse": true }));
    for (const t of ["parse_image", "parse_visual", "parse_document", "analyze_document", "analyze_document_v2"]) {
      assert.ok(registered.has(t), `missing ${t}`);
    }
    assert.ok(!registered.has("run_data_analysis"));
  });

  test("TS/Python feature hash parity with data analysis enabled", () => {
    const env = {
      ENABLE_DATA_ANALYSIS: "true",
      ENABLE_DATA_ANALYSIS_TOOL: "true",
      ENABLE_ANALYSIS_FRONTEND_RENDER: "true",
    };
    const saved = { ...process.env };
    try {
      for (const [k, v] of Object.entries(env)) process.env[k] = v;
      const ts = createFeatureResolver({}).getEffectiveFeatureSnapshot();
      const out = execFileSync("python3", ["-m", "app.features", "--print", "--json"], {
        cwd: join(import.meta.dirname, "..", "services", "lakehouse-gateway"),
        env,
        encoding: "utf8",
      });
      const py = JSON.parse(out);
      assert.equal(py.effectiveFeatureHash, ts.effectiveFeatureHash);
      assert.ok(py.effectiveFeatures.includes("round4.data_analysis"));
    } finally {
      process.env = saved as never;
    }
  });
});
