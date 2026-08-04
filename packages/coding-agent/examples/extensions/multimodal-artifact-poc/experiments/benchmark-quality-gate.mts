/**
 * 质量门验证实验（B0-B3 递进）— 10 个真实文档
 *
 * 预注册失败判定（run success / run failure，先分类再算分，避免事后筛选）：
 *   RUN_FAILURE    = orchestrator error（含 callLlm 3 次重试仍空响应/HTTP 失败）
 *   PACKET_FAILURE = L1 attempt1 未过质量门（gate verdict != pass），B0 无门会放过
 *
 * 方案链（单次运行反事实导出）：
 *   B0 = 无质量门（v2 架构：truncated 强制升级 + L1 自评升级）→ merge(attempt1, esc?expert)
 *   B1 = + schema 校验（gate 拦截但无重试无升级）→ 已由 verdict 判定记录
 *   B2 = B1 + 差异化重试（recovered 计数）
 *   B3 = B2 + 重试失败自动升级 L2（实际运行管线）
 *
 * 指标：坍缩率 / 自动恢复率 / 升级率 / 成功率 / 有效运行均分 / 端到端期望质量
 *      （= 成功率 × 有效均分）/ 总 token / P50·P95 延迟 / L2 调用率
 *
 * judge：每个答案评 2 次取平均（同答案双评分），自动重试 + schema 校验，
 *       记录失败率；无响应的 judge 不计零分。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { orchestrateDocumentAnalysis } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/orchestrator.ts";
import { mergeEvidence } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/evidence.ts";
import { callLlm } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/doc-agents.ts";

const DOCS = [
  { path: "/Users/zhanhuilin/Documents/林展辉_悉尼大学_2027届毕业生(1).pdf", name: "简历-悉尼大学" },
  { path: "/Users/zhanhuilin/Downloads/大模型 RAG 检索增强生成面.pdf", name: "面经-RAG" },
  { path: "/Users/zhanhuilin/Downloads/对接说明.docx", name: "对接说明" },
  { path: "/Users/zhanhuilin/Downloads/vibe-coding-interviews.docx.docx", name: "编码面试" },
  { path: "/Users/zhanhuilin/Downloads/wealth_agent_optimization.docx", name: "财富Agent优化" },
  { path: "/Users/zhanhuilin/Downloads/AI数据分析Agent_下一会话交接文档_v1.0.md", name: "AI数据分析Agent交接" },
  { path: "/Users/zhanhuilin/Downloads/RiskCloud_多Agent数据治理架构_OpenCode实施任务书.md", name: "RiskCloud任务书" },
  { path: "/Users/zhanhuilin/Downloads/Spark核心知识总结_完整版.md", name: "Spark知识总结" },
  { path: "/Users/zhanhuilin/Downloads/Structural_Feasibility_as_a_Compositional_Value__An_Execution_Algebra_for_Neural_Complex_Query_Answering.pdf", name: "论文-StructuralFeasibility" },
  { path: "/Users/zhanhuilin/Downloads/CDXR_EDBT_2027.pdf", name: "论文-CDXR" },
];

const QUESTION = "总结这个文档的主要内容，并提取 3 个关键事实（尽量包含具体数字或名称）。";
const OUT_DIR = "/tmp/quality-gate-exp";
mkdirSync(OUT_DIR, { recursive: true });

function loadDoc(name: string): string {
  return readFileSync(`/tmp/real-docs-exp/${name}.md`, "utf8");
}

function packetToAnswerText(merged: any): string {
  const lines: string[] = [];
  for (const f of merged.facts) lines.push(`- ${f.claim}: ${f.value}${f.evidence ? ` [${f.evidence}]` : ""}`);
  for (const i of merged.inferences) lines.push(`- ${i.claim}`);
  for (const u of merged.unknowns) lines.push(`- (未知) ${u}`);
  for (const c of merged.conflicts) lines.push(`- (冲突) ${c.claim}: ${c.candidates.map((x: any) => x.value).join(" vs ")}`);
  return lines.join("\n") || "(无提取结果)";
}

/** 主 agent 汇报：成功用自然语言输出，失败降级为证据文本 */
async function mainReport(answerText: string): Promise<{ text: string; tokens: number }> {
  try {
    const main = await callLlm(
      [
        { role: "system", content: "你是对话助手。基于证据包向用户汇报，组织成连贯的总结。" },
        { role: "user", content: `证据包：\n${answerText}\n\n问题：${QUESTION}` },
      ],
      "deepseek-v4-flash",
      800,
    );
    if (main.content.trim()) return { text: main.content, tokens: main.promptTokens + main.completionTokens };
  } catch {}
  return { text: answerText, tokens: Math.ceil(answerText.length / 4) };
}

// ===== 方案 B3（实际运行：完整质量门管线）=====
async function runB3(docs: { name: string; text: string }[]) {
  const rows = [];
  for (const doc of docs) {
    const started = Date.now();
    const r = await orchestrateDocumentAnalysis({ documentId: `doc_${doc.name}`, documentText: doc.text, question: QUESTION });
    const elapsed = Date.now() - started;

    if (r.error) {
      // 预注册判定 RUN_FAILURE（失败不是零分，是任务失败）
      rows.push({ name: doc.name, runFailure: true, error: r.error.slice(0, 120), durationMs: elapsed, escalate: false });
      console.log(`[B3] ${doc.name} RUN_FAILURE: ${r.error.slice(0, 80)}`);
      continue;
    }

    const gate = r.gate;
    const truncated = gate.attempt1Quality.truncated;

    // B3 答案 = 最终 merge → 主汇报
    const b3Packets = packetToAnswerText(r.merged);
    const b3 = await mainReport(b3Packets);

    // B0 反事实 = 无门：merge(attempt1, B0 会升级 ? expert : undefined)
    const b0Escalate = truncated || Boolean(gate.attempt1Packet?.escalation?.required);
    const b0Merged = mergeEvidence(gate.attempt1Packet!, b0Escalate ? r.expertPacket : undefined);
    const b0 = await mainReport(packetToAnswerText(b0Merged));

    rows.push({
      name: doc.name,
      runFailure: false,
      // 预注册判定 PACKET_FAILURE：B0 无门会放过的 attempt1 坍缩
      packetFailure: gate.verdict !== "pass",
      gateVerdict: gate.verdict,
      gateReason: gate.reason,
      retried: gate.retried,
      recovered: gate.recovered,
      truncated,
      escalate: r.escalation,
      attempt1EvidenceChars: gate.attempt1Quality.evidenceChars,
      attempt1FactCount: gate.attempt1Quality.factCount,
      answerB0: b0.text,
      answerB3: b3.text,
      mainTokensB0: b0.tokens,
      mainTokensB3: b3.tokens,
      totalTokens: r.tokens.l1 + r.tokens.l2 + b3.tokens,
      durationMs: elapsed,
      route: r.route.route,
    });
    console.log(`[B3] ${doc.name} done (${(elapsed / 1000).toFixed(0)}s, gate=${gate.verdict}/${gate.reason}, escalate=${r.escalation}${truncated ? "/truncated" : ""}${gate.retried ? (gate.recovered ? "/recovered" : "/retry-failed") : ""})`);
  }
  return rows;
}

// ===== Judge：同答案双评分，自动重试 + schema 校验 =====
const JUDGE_SYSTEM = `你是严格的文档答案评判员。对照文档原文，分别给两个答案评分（1-5 整数）：准确性（是否与文档一致、有无幻觉）、完整性（是否覆盖文档要点）。输出 JSON: {"A": {"accuracy": n, "completeness": n, "note": "..."}, "B": {"accuracy": n, "completeness": n, "note": "..."}}。不要输出其他内容。`;

function scoreValid(s: any): boolean {
  return Boolean(s && typeof s.accuracy === "number" && typeof s.completeness === "number");
}

async function judgeOnce(docText: string, a: string, b: string): Promise<{ A: any; B: any } | null> {
  for (let round = 1; round <= 3; round++) {
    try {
      const r = await callLlm(
        [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `--- 文档原文（截断）---\n${docText.slice(0, 8000)}\n\n--- 答案 A（B0 无门）---\n${a.slice(0, 1500)}\n\n--- 答案 B（B3 质量门）---\n${b.slice(0, 1500)}` },
        ],
        "deepseek-v4-flash",
        800,
      );
      const m = r.content.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : null;
      if (scoreValid(parsed?.A) && scoreValid(parsed?.B)) return parsed;
    } catch {}
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

async function judgeDoc(docText: string, a: string, b: string): Promise<{ A: any; B: any; votes: number } | null> {
  const votes: { A: any; B: any }[] = [];
  for (let v = 0; v < 2; v++) {
    const s = await judgeOnce(docText, a, b);
    if (s) votes.push(s);
  }
  if (votes.length === 0) return null;
  // 双评分成功时取平均，否则用单评分
  const avg = (k: "A" | "B", f: (x: any) => number) => votes.reduce((s, v) => s + f(v[k]), 0) / votes.length;
  return {
    A: { accuracy: avg("A", (x) => x.accuracy), completeness: avg("A", (x) => x.completeness) },
    B: { accuracy: avg("B", (x) => x.accuracy), completeness: avg("B", (x) => x.completeness) },
    votes: votes.length,
  };
}

console.log("=== 质量门验证实验（B0-B3 递进，10 真实文档）===");
const docs = DOCS.map((d) => ({ name: d.name, text: loadDoc(d.name) }));

console.log("\n--- 方案 B3（实际运行管线）---");
const rows = await runB3(docs);

console.log("\n--- Judge（B0 vs B3，双评分）---");
const judgeResults = [];
let judgeFail = 0;
for (const row of rows) {
  if (row.runFailure) { judgeResults.push({ name: row.name, judgeFail: true }); continue; }
  const s = await judgeDoc(loadDoc(row.name), row.answerB0, row.answerB3);
  if (!s) { judgeFail++; judgeResults.push({ name: row.name, judgeFail: true }); console.log(`[judge] ${row.name} FAILED`); continue; }
  judgeResults.push({ name: row.name, A: s.A, B: s.B, votes: s.votes });
  const a = (s.A.accuracy + s.A.completeness) / 2;
  const b = (s.B.accuracy + s.B.completeness) / 2;
  console.log(`[judge] ${row.name}: B0=${a.toFixed(1)} B3=${b.toFixed(1)} (votes=${s.votes})`);
}

writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify({ rows, judgeResults, timestamp: new Date().toISOString() }, null, 2));

// ===== 汇总 =====
const runFailures = rows.filter((r) => r.runFailure).length;
const packetFailures = rows.filter((r) => r.packetFailure).length;
const retried = rows.filter((r) => r.retried);
const recovered = retried.filter((r) => r.recovered);
const escalated = rows.filter((r) => r.escalate);
const gateEscalatedNonTruncated = rows.filter((r) => r.escalate && !r.truncated);
const valid = judgeResults.filter((j) => !j.judgeFail);

const avg = (arr: any[], f: (x: any) => number) => (arr.length ? arr.reduce((s, r) => s + f(r), 0) / arr.length : 0);
const pct = (n: number) => ((n / docs.length) * 100).toFixed(1) + "%";

const aScores = valid.map((j) => (j.A.accuracy + j.A.completeness) / 2);
const bScores = valid.map((j) => (j.B.accuracy + j.B.completeness) / 2);
const aMean = avg(valid, (j) => (j.A.accuracy + j.A.completeness) / 2);
const bMean = avg(valid, (j) => (j.B.accuracy + j.B.completeness) / 2);

const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
const p50 = durations[Math.floor(durations.length * 0.5)]!;
const p95 = durations[Math.floor(durations.length * 0.95)]!;

// 端到端期望质量：成功率 × 有效运行均分（用户规格）
const successRate = (docs.length - runFailures) / docs.length;
const endToEndB0 = successRate * aMean;
const endToEndB3 = successRate * bMean;

console.log("\n===== 汇总 =====");
console.log(`运行: ${docs.length - runFailures}/${docs.length} 成功（RUN_FAILURE=${runFailures}）`);
console.log(`L1 attempt1 坍缩率（gate 拦截）: ${packetFailures}/${docs.length} (${pct(packetFailures)})`);
console.log(`  其中差异化重试: ${retried.length} 次，自动恢复 ${recovered.length} 次 (${retried.length ? ((recovered.length / retried.length) * 100).toFixed(0) : 0}%)`);
console.log(`升级（L2 调用率）: ${escalated.length}/${docs.length}，其中非截断 gate 升级 ${gateEscalatedNonTruncated.length}`);
console.log(`总 token: B0=${avg(rows.filter((r) => !r.runFailure), (r) => r.mainTokensB0).toFixed(0)} (仅主汇报), B3=${avg(rows, (r) => r.totalTokens).toFixed(0)}`);
console.log(`延迟: P50=${(p50 / 1000).toFixed(1)}s, P95=${(p95 / 1000).toFixed(1)}s`);
console.log(`Judge: 有效 ${valid.length}/${rows.length}（失败 ${judgeFail}）`);
console.log(`有效运行均分: B0=${aMean.toFixed(2)}, B3=${bMean.toFixed(2)}`);
console.log(`端到端期望质量（成功率 ${(successRate * 100).toFixed(0)}% × 均分）: B0=${endToEndB0.toFixed(2)}, B3=${endToEndB3.toFixed(2)}`);

console.log("\n分文档：");
for (const row of rows) {
  const j = judgeResults.find((x) => x.name === row.name);
  const s = j && !j.judgeFail ? `B0=${((j.A.accuracy + j.A.completeness) / 2).toFixed(1)} B3=${((j.B.accuracy + j.B.completeness) / 2).toFixed(1)}` : "无分";
  console.log(`[${row.name}] ${s} | gate=${row.gateVerdict ?? "-"}/${row.gateReason ?? "-"} | ${row.runFailure ? "RUN_FAILURE" : row.escalate ? "升级" : "不升级"}${row.retried ? (row.recovered ? "(重试恢复)" : "(重试失败→升级)") : ""} | ${(row.durationMs / 1000).toFixed(0)}s`);
}
console.log(`\n结果已存: ${OUT_DIR}/results.json`);
