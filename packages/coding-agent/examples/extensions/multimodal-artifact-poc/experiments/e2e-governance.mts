/**
 * CDXR governance E2E (spec §13 E2E):
 *   1. governance run materialized for 3 datasets (via CLI, before this script)
 *   2. Query Gateway serves the 6 read-only governance APIs
 *   3. Pi Agent governance tools (get_profile / findings / evidence / review)
 *   4. deterministic checks against infra/lakehouse/seed/cdxr_expected_results.json
 *   5. acceptance question answered by the LLM agent:
 *      "ads.model_metrics 当前是否适合用于分析？请结合数据质量、CDXR 治理发现、
 *       快照和血缘给出结论，并列出需要人工核验的问题。"
 *      answer must carry finding + snapshot + quality + lineage, and must NOT
 *      self-close or dismiss the governance findings.
 *
 * Prereq: the 3 demo governance runs must exist (see seed/README):
 *   python3 -m app.governance.cdxr.run --dataset-id <id> --time-column <col> --as-of 2026-07-31T12:00:00Z
 * Run: node --experimental-strip-types experiments/e2e-governance.mts
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { GatewayClient } from "../src/data-tools/client.ts";
import { callLlm } from "../src/doc-agents.ts";

const POC = process.cwd();
const PORT = 8806;
const BASE = `http://localhost:${PORT}`;
const expected = JSON.parse(readFileSync(join(POC, "infra/lakehouse/seed/cdxr_expected_results.json"), "utf8"));

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${url}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("gateway not healthy");
}

const gw = spawn("python3", ["-m", "uvicorn", "app.main:app", "--port", String(PORT)], {
  cwd: join(POC, "services", "lakehouse-gateway"),
  env: { ...process.env as any, LAKEHOUSE_MODE: "local", LAKEHOUSE_WAREHOUSE_PATH: join(POC, ".data/warehouse"),
         ENABLE_LAKEHOUSE: "true", ENABLE_LEGACY_CDXR_GOVERNANCE_TOOLS: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
await waitForHealth(BASE);

const c = new GatewayClient({ baseUrl: BASE });
let ok = true;
let finalAnswer = "";

try {
  // ---- 1-2. governance APIs across the 3 demo datasets -------------------
  const scenarios = expected.scenarios;
  const profiles: Record<string, any> = {};
  for (const ds of Object.keys(scenarios)) {
    const p = await c.getGovernanceProfile(ds);
    profiles[ds] = p;
    console.log(`[1] profile ${ds}: score=${p.governanceScore} status=${p.status} ` +
                `open=${p.openFindingCount} highest=${p.highestSeverity} snapshot=${p.snapshotId}`);
    const exp = scenarios[ds]!;
    assert.equal(p.governanceScore, exp.governanceScore, `${ds} governance score`);
    assert.equal(p.status, exp.status, `${ds} status`);
    assert.equal(p.highestSeverity, exp.highestSeverity, `${ds} highest severity`);
    assert.equal(p.snapshotId, exp.snapshotId, `${ds} snapshot`);
    assert.equal(p.qualityStatus, exp.qualityStatus, `${ds} quality`);
    // findings carry quality + lineage references
    const findings = await c.listGovernanceFindings({ datasetId: ds });
    assert.equal(findings.count, exp.findings.length, `${ds} finding count`);
    for (const f of findings.findings) {
      assert.ok(f.qualityReference, `${ds} finding qualityReference`);
      assert.ok(f.lineageReference, `${ds} finding lineageReference`);
      assert.ok(f.snapshotId, `${ds} finding snapshot binding`);
      assert.ok(f.evidenceReferences && f.evidenceReferences.length, `${ds} finding evidence refs`);
    }
    // finding detail + evidence drill-down
    const fid = findings.findings[0]!.findingId;
    const detail = await c.getGovernanceFinding(fid);
    assert.equal(detail.status, "OPEN");
    const evidence = await c.getGovernanceEvidence(fid);
    assert.ok(evidence.count >= 1, `${ds} evidence count`);
  }
  // ODS scenario: sensitive finding must exist
  const ocrFindings = await c.listGovernanceFindings({ datasetId: "ods.ocr_result" });
  assert.ok(ocrFindings.findings.some((f) => f.ruleId === "sensitive_field_check"), "ocr sensitive finding");
  assert.ok(ocrFindings.findings.some((f) => f.ruleId === "ocr_confidence_check"), "ocr confidence finding");

  // review queue: one item per open finding
  const queue = await c.getGovernanceReviewStatus();
  assert.ok(queue.count >= 4, `review queue has ${queue.count} items`);

  // ---- 3. governance run details -----------------------------------------
  const run = await c.listGovernanceFindings({ datasetId: "ads.model_metrics" });
  const runRes = await c.getGovernanceRun(run.findings[0]!.runId);
  assert.equal(runRes.status, "COMPLETED");
  assert.ok(runRes.ruleResults.length >= 8);
  console.log(`[2] run ${runRes.runId}: ${runRes.rulesExecuted} rules, ${runRes.findingsCreated} findings`);

  // ---- 4. acceptance question (LLM agent answer) -------------------------
  const p = profiles["ads.model_metrics"]!;
  const f = (await c.listGovernanceFindings({ datasetId: "ads.model_metrics" })).findings[0]!;
  const evidence = [
    `问题：ads.model_metrics 当前是否适合用于分析？请结合数据质量、CDXR 治理发现、快照和血缘给出结论，并列出需要人工核验的问题。`,
    ``,
    `【CDXR 治理档案（ADS trust profile）】`,
    `  datasetId=${p.datasetId} snapshotId=${p.snapshotId}`,
    `  governanceScore=${p.governanceScore} status=${p.status}`,
    `  openFindingCount=${p.openFindingCount} highestSeverity=${p.highestSeverity}`,
    `  dimensionScores=${JSON.stringify(p.dimensionScores)}`,
    `  qualityStatus=${p.qualityStatus} qualityReference=${p.qualityReference}`,
    `  lineageReference=${p.lineageReference}`,
    `  findingIds=${(p.findingIds ?? []).join(",")}`,
    ``,
    `【CDXR finding（DWD）】`,
    `  findingId=${f.findingId} ruleId=${f.ruleId} severity=${f.severity} status=${f.status}`,
    `  reasonCodes=${(f.reasonCodes ?? []).join(",")} summary=${f.summary}`,
    `  snapshotId=${f.snapshotId} qualityReference=${f.qualityReference} lineageReference=${f.lineageReference}`,
    ``,
    `【数据质量】${p.qualityStatus}（PASS=可用于分析的数据存在性）`,
    `【快照】snapshotId=${p.snapshotId}`,
    `【血缘】lineageReference=${p.lineageReference}`,
    `【人工审核队列】该 finding 在 governance review queue 中等待人工核验（Agent 不得自行关闭/豁免）`,
    ``,
    `【回答要求】`,
    `用中文给出结构化结论：1) 是否适合用于分析（给出 governanceScore/status 依据）；2) 结合数据质量、快照、血缘说明；3) 列出需要人工核验的问题（引用 findingId/ruleId/severity）。` +
    `不得声称已解决或忽略该治理发现；治理发现必须保留 OPEN 状态并移交人工核验。`,
  ].join("\n");

  const checks: Array<[string, (a: string) => boolean]> = [
    ["识别 model_metrics 与 DOMAIN_FIELD", (a) => /model_metrics/.test(a) && /DOMAIN_FIELD|domain|字段/.test(a)],
    ["governanceScore/status 依据", (a) => /90/.test(a) && /TRUSTED|可信/.test(a)],
    ["findingId", (a) => /fnd_[a-f0-9]{8,}/.test(a)],
    ["snapshotId", (a) => /8123266417553960382|snapshot|快照/.test(a)],
    ["qualityStatus/qualityReference", (a) => /PASS|quality|质量/.test(a)],
    ["lineageReference", (a) => /lineage|血缘/.test(a)],
    ["列出人工核验问题", (a) => /人工|核验|review|待确认/.test(a)],
    // positive assertion: the answer must keep the finding OPEN and hand it to humans
    ["不自行关闭", (a) => /保持 ?OPEN|不得.*(关闭|豁免|解决)|移交人工|待人工核验/.test(a)],
  ];

  const generate = async () => {
    const llm = await callLlm(
      [{ role: "system", content: "你是数据治理分析 Agent。基于给定的 CDXR 治理证据回答，不得编造数字。" +
         "治理发现不得被自动关闭或忽略——OPEN 的 finding 必须保留并移交人工核验。" },
       { role: "user", content: evidence }],
      "deepseek-v4-flash", 3000,
    );
    return llm.content.trim();
  };

  for (let round = 1; round <= 3; round++) {
    try { finalAnswer = await generate(); } catch (error) {
      console.log(`[4] LLM attempt ${round} failed (${(error as Error).message.slice(0, 60)}), retrying...`);
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    console.log(`\n===== AGENT 回答 (round ${round}) =====`);
    console.log(finalAnswer.slice(0, 1200));
    const results = checks.map(([label, fn]) => [label, fn(finalAnswer)] as [string, boolean]);
    console.log("\n===== 回答验证 =====");
    for (const [label, pass] of results) console.log(`  ${pass ? "✓" : "✗"} ${label}`);
    if (results.every(([, p]) => p)) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  const finalResults = checks.map(([label, fn]) => [label, fn(finalAnswer)] as [string, boolean]);
  assert.ok(finalResults.every(([, p]) => p), "answer verification failed after 3 rounds");
  console.log("\nGOVERNANCE E2E OK — answers consistent with cdxr_expected_results.json, findings remain OPEN");
} catch (error) {
  ok = false;
  console.error("\nGOVERNANCE E2E FAILED:", error);
} finally {
  gw.kill("SIGTERM");
}
process.exit(ok ? 0 : 1);
