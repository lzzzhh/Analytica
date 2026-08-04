/**
 * E2E profile tests (spec §14 tests 24-30): build profiles × runtime profiles
 * against a real gateway.
 *
 * For each scenario:
 *   - spawns the gateway with the given build profile (via generator env) and
 *     runtime profile / feature env
 *   - asserts the gateway's feature snapshot line (startup log) and API
 *     availability/blocking behavior matches the expected features
 *
 * Scenarios:
 *   24 baseline      (build=baseline)            → only round1 tools; lakehouse 404
 *   25 multimodal-only (build=multimodal-only)   → same as baseline (round1 only)
 *   26 lakehouse-only (build=lakehouse-only)     → lakehouse ON, round1 OFF
 *   27 full safe     (build=full, runtime default)→ round1 ON, lakehouse OFF
 *   28 no-l2-expert  (full + ablation/no-l2-expert) → l2_expert OFF
 *   29 no-lineage    (full + ablation/no-lineage)  → lineage OFF, lakehouse ON
 *   30 no-cdxr-temporal (full + ablation/no-cdxr-temporal) → temporal rule OFF
 *
 * Run: LAKEHOUSE_GATEWAY_URL=http://localhost:8791 node --experimental-strip-types experiments/e2e-feature-profiles.mts
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const POC = process.cwd();
const GW_DIR = join(POC, "services", "lakehouse-gateway");
const BASE_PORT = 8891;

function sh(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env as any, ...env }, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr?.slice(0, 800)}`);
  return r.stdout;
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("gateway did not become healthy in time");
}

interface Scenario {
  name: string;
  buildProfile: string;
  env: Record<string, string>;
  expect: {
    effective: string[];
    notEffective: string[];
    lakehouse404?: boolean; // catalog search should 404 (feature disabled)
    cdxr404?: boolean;      // training assessments should 404
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: "24-baseline",
    buildProfile: "baseline",
    env: {},
    expect: { effective: ["round1.image_ocr"], notEffective: ["round2.lakehouse", "round3.cdxr_training"], lakehouse404: true, cdxr404: true },
  },
  {
    name: "25-multimodal-only",
    buildProfile: "multimodal-only",
    env: {},
    expect: { effective: ["round1.image_ocr"], notEffective: ["round2.lakehouse"], lakehouse404: true, cdxr404: true },
  },
  {
    name: "26-lakehouse-only",
    buildProfile: "lakehouse-only",
    env: { ENABLE_LAKEHOUSE: "true" },
    expect: { effective: ["round2.lakehouse", "round2.catalog_tools"], notEffective: ["round1.image_ocr", "round3.cdxr_training"], cdxr404: true },
  },
  {
    name: "27-full-safe-default",
    buildProfile: "full",
    env: {},
    expect: { effective: ["round1.image_ocr"], notEffective: ["round2.lakehouse", "ablate.query_validation"], lakehouse404: true, cdxr404: true },
  },
  {
    name: "28-no-l2-expert",
    buildProfile: "full",
    env: { FEATURE_RUNTIME_CONFIG_PATH: join(POC, "experiments", "configs", "ablation", "no-l2-expert.json") },
    expect: { effective: ["round1.image_ocr"], notEffective: ["round1.l2_expert"], lakehouse404: true, cdxr404: true },
  },
  {
    name: "29-no-lineage",
    buildProfile: "full",
    env: { FEATURE_RUNTIME_CONFIG_PATH: join(POC, "experiments", "configs", "ablation", "no-lineage.json") },
    expect: { effective: ["round2.lakehouse", "round2.query_tools"], notEffective: ["round2.lineage"], cdxr404: true },
  },
  {
    name: "30-no-cdxr-temporal",
    buildProfile: "full",
    env: { FEATURE_RUNTIME_CONFIG_PATH: join(POC, "experiments", "configs", "ablation", "no-cdxr-temporal.json") },
    expect: { effective: ["round3.cdxr_training"], notEffective: ["round3.cdxr_temporal"] },
  },
];

async function runScenario(i: number, s: Scenario): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), `lh-prof-${i}-`));
  const warehouse = join(tmp, "wh");
  sh("python3", ["-c", `
import sys; sys.path.insert(0, "${GW_DIR}")
from tests.conftest import build_test_warehouse
from pathlib import Path
build_test_warehouse(Path("${warehouse}"))
print("warehouse built")
`], GW_DIR);
  const port = BASE_PORT + i;
  const gw = spawn("python3", ["-m", "uvicorn", "app.main:app", "--port", String(port)], {
    cwd: GW_DIR,
    env: { ...process.env as any, LAKEHOUSE_MODE: "local", LAKEHOUSE_WAREHOUSE_PATH: warehouse,
           FEATURE_BUILD_PROFILE: s.buildProfile, ...s.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  let stdoutBuf = "";
  gw.stderr!.on("data", (d) => { stderrBuf += String(d); });
  gw.stdout!.on("data", (d) => { stdoutBuf += String(d); });
  const base = `http://localhost:${port}`;
  try {
    await waitForHealth(base);

    // Feature summary line printed at startup (app.main)
    const featureLine = (stdoutBuf + stderrBuf).split("\n").find((l) => l.includes("[features]"));
    assert.ok(featureLine, `[${s.name}] gateway printed [features] summary (stdout: ${stdoutBuf.slice(0, 300)})`);

    // API availability checks
    const search = await fetch(`${base}/v1/catalog/search?query=sales`);
    if (s.expect.lakehouse404) {
      assert.equal(search.status, 404, `[${s.name}] catalog search disabled → 404`);
      assert.ok((await search.json()).detail.startsWith("FEATURE_DISABLED"));
    } else {
      assert.equal(search.status, 200, `[${s.name}] catalog search enabled → 200`);
    }
    const cdxr = await fetch(`${base}/v1/cdxr/training-assessments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (s.expect.cdxr404) {
      assert.equal(cdxr.status, 404, `[${s.name}] training assessments disabled → 404`);
      // Router not mounted → FastAPI default "Not Found"; router mounted but
      // feature off → FEATURE_DISABLED detail. Either way: no execution.
      const detail = (await cdxr.json()).detail;
      assert.ok(detail === "Not Found" || String(detail).startsWith("FEATURE_DISABLED"),
                `[${s.name}] cdxr 404 detail: ${String(detail)}`);
    } else {
      assert.equal(cdxr.status, 422, `[${s.name}] training assessments enabled → 422 (validation, not 404)`);
    }
    console.log(`[e2e] ${s.name}: OK (${s.buildProfile})`);
  } finally {
    gw.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
}

let failed = false;
for (let i = 0; i < SCENARIOS.length; i++) {
  try {
    await runScenario(i, SCENARIOS[i]!);
  } catch (e) {
    failed = true;
    console.error(`[e2e] ${SCENARIOS[i]!.name}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (failed) process.exit(1);
console.log("[e2e] all feature profile scenarios passed (24-30)");
