/**
 * B4 实验：相对质量门 + best-attempt selection + 短文档不升级
 *
 * 对比对象：B3'（旧 v1 质量门反事实，同轮生成，消除跨轮 API 噪声）：
 *   - 旧逻辑：attempt2（最后一次）无条件选用 + truncated||retryFailed||agentDeclared 一律升级
 *   - 新逻辑（B4）：best-attempt 按质量分选择 + 短文档(≤2000 tok)不因质量门升级
 *     + expert 分数低于 best attempt 时弃用
 *
 * 验证目标（用户规格）：
 *   - 非 truncated L2 调用率显著下降（目标 <20%）
 *   - 短文档误升级率 ≈ 0
 *   - 有效运行质量不低于 B3
 *   - P50/P95 延迟回落
 *
 * 预注册失败判定：RUN_FAILURE = orchestrator error / API 空响应 3 次
 * judge：B3' vs B4 同文档同轮双评分。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { orchestrateDocumentAnalysis } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/orchestrator.ts";
import { mergeEvidence } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/evidence.ts";
import { callLlm, runL2Agent } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/doc-agents.ts";

const DOCS = [
  { name: "简历-悉尼大学" },
  { name: "面经-RAG" },
  { name: "对接说明" },
  { name: "编码面试" },
  { name: "财富Agent优化" },
  { name: "AI数据分析Agent交接" },
  { name: "RiskCloud任务书" },
  { name: "Spark知识总结" },
  { name: "论文-StructuralFeasibility" },
  { name: "论文-CDXR" },
];

const QUESTION = "总结这个文档的主要内容，并提取 3 个关键事实（尽量包含具体数字或名称）。";
const OUT_DIR = "/tmp/b4-exp";
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

/** 旧逻辑（v1 质量门）升级判定：truncated || retryFailed || agentDeclared */
function b3Escalated(r: any): boolean {
  const d = r.decision;
  if (d.estimatedTokens > 6000) return true; // truncated
  if (d.attempt1.gateReason.startsWith("escalate:agent")) return true;
  if (d.attempt2 && d.attempt2.gateReason.startsWith("retry_failed")) return true;
  return false;
}

async function runB4() {
  const rows = [];
  for (const doc of DOCS) {
    const docText = loadDoc(doc.name);
    const started = Date.now();
    const r = await orchestrateDocumentAnalysis({ documentId: `doc_${doc.name}`, documentText: docText, question: QUESTION });
    const elapsed = Date.now() - started;

    if (r.error) {
      rows.push({ name: doc.name, runFailure: true, error: r.error.slice(0, 120), durationMs: elapsed });
      console.log(`[B4] ${doc.name} RUN_FAILURE: ${r.error.slice(0, 80)}`);
      continue;
    }

    const d = r.decision;
    const retried = Boolean(d.attempt2);
    const oldAttemptPacket = retried ? r.attempt2Packet! : r.attempt1Packet!;
    const b3Esc = b3Escalated(r);

    // B3' 反事实需要 expert：非短文档场景 B4 已跑（或已按新逻辑触发），
    // 短文档场景旧逻辑会升级而新逻辑没有 → 额外跑一次 L2（仅反事实）
    let expertForB3 = r.expertPacket;
    let extraL2 = false;
    if (b3Esc && !expertForB3) {
      const l2 = await runL2Agent({
        documentId: r.documentId,
        scopeText: docText,
        question: QUESTION,
        knownFacts: oldAttemptPacket.facts.map((f: any) => `${f.claim}: ${f.value}`),
      });
      expertForB3 = l2.packet;
      extraL2 = true;
    }

    // B4 答案 = 新管线 merge（best-attempt + expert 门控已内建）
    const b4 = await mainReport(packetToAnswerText(r.merged));

    // B3' 答案 = 旧逻辑 merge(最后一次 attempt, 旧升级规则?expert)
    const b3Merged = mergeEvidence(oldAttemptPacket, b3Esc ? expertForB3 : undefined);
    const b3prime = await mainReport(packetToAnswerText(b3Merged));

    rows.push({
      name: doc.name,
      runFailure: false,
      // 新逻辑过程指标
      estimatedTokens: d.estimatedTokens,
      shortDocument: d.shortDocument,
      retried,
      attempt1Score: d.attempt1.qualityScore,
      attempt2Score: d.attempt2?.qualityScore,
      attempt1Gate: d.attempt1.gateReason,
      attempt2Gate: d.attempt2?.gateReason,
      bestAttempt: d.bestAttempt,
      selectionReason: d.selectionReason,
      newEscalate: r.escalation,
      expertTriggered: d.expertTriggered,
      expertUsed: d.expertUsed,
      expertDiscardReason: d.expertDiscardReason,
      // 旧逻辑反事实
      b3Escalated: b3Esc,
      b3ExtraL2: extraL2,
      // 答案
      answerB3prime: b3prime.text,
      answerB4: b4.text,
      mainTokensB4: b4.tokens,
      totalTokens: r.tokens.l1 + r.tokens.l2 + b4.tokens + (extraL2 ? 0 : 0),
      durationMs: elapsed,
    });
    console.log(`[B4] ${doc.name} done (${(elapsed / 1000).toFixed(0)}s, short=${d.shortDocument}, best=${d.bestAttempt}, esc(B4)=${r.escalation ? "Y" : "n"} esc(B3')=${b3Esc ? "Y" : "n"}${extraL2 ? "+extraL2" : ""}${d.expertDiscardReason ? `, discard:${d.expertDiscardReason.slice(0, 30)}` : ""})`);
  }
  return rows;
}

// ===== Judge：B3' vs B4，双评分 =====
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
          { role: "user", content: `--- 文档原文（截断）---\n${docText.slice(0, 8000)}\n\n--- 答案 A（B3' 旧门）---\n${a.slice(0, 1500)}\n\n--- 答案 B（B4 相对门）---\n${b.slice(0, 1500)}` },
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

async function judgeDoc(docText: string, a: string, b: string) {
  const votes: { A: any; B: any }[] = [];
  for (let v = 0; v < 2; v++) {
    const s = await judgeOnce(docText, a, b);
    if (s) votes.push(s);
  }
  if (votes.length === 0) return null;
  const avg = (k: "A" | "B", f: (x: any) => number) => votes.reduce((s, v) => s + f(v[k]), 0) / votes.length;
  return {
    A: { accuracy: avg("A", (x) => x.accuracy), completeness: avg("A", (x) => x.completeness) },
    B: { accuracy: avg("B", (x) => x.accuracy), completeness: avg("B", (x) => x.completeness) },
    votes: votes.length,
  };
}

console.log("=== B4 实验：相对质量门 + best-attempt + 短文档不升级（10 文档）===");
const rows = await runB4();

console.log("\n--- Judge（B3' vs B4，双评分）---");
const judgeResults = [];
let judgeFail = 0;
for (const row of rows) {
  if (row.runFailure) { judgeResults.push({ name: row.name, judgeFail: true }); continue; }
  const s = await judgeDoc(loadDoc(row.name), row.answerB3prime, row.answerB4);
  if (!s) { judgeFail++; judgeResults.push({ name: row.name, judgeFail: true }); console.log(`[judge] ${row.name} FAILED`); continue; }
  judgeResults.push({ name: row.name, A: s.A, B: s.B, votes: s.votes });
  const a = (s.A.accuracy + s.A.completeness) / 2;
  const b = (s.B.accuracy + s.B.completeness) / 2;
  console.log(`[judge] ${row.name}: B3'=${a.toFixed(1)} B4=${b.toFixed(1)} (votes=${s.votes})`);
}

writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify({ rows, judgeResults, timestamp: new Date().toISOString() }, null, 2));

// ===== 汇总 =====
const runFailures = rows.filter((r) => r.runFailure).length;
const valid = judgeResults.filter((j) => !j.judgeFail);
const avg = (arr: any[], f: (x: any) => number) => (arr.length ? arr.reduce((s, r) => s + f(r), 0) / arr.length : 0);

const aMean = avg(valid, (j) => (j.A.accuracy + j.A.completeness) / 2);
const bMean = avg(valid, (j) => (j.B.accuracy + j.B.completeness) / 2);
const successRate = (rows.length - runFailures) / rows.length;

const okRows = rows.filter((r) => !r.runFailure);
const newL2 = okRows.filter((r) => r.newEscalate);
const oldL2 = okRows.filter((r) => r.b3Escalated);
const newNonTruncL2 = okRows.filter((r) => r.newEscalate && r.estimatedTokens <= 6000);
const shortDocs = okRows.filter((r) => r.shortDocument);
const shortEscOld = shortDocs.filter((r) => r.b3Escalated);
const shortEscNew = shortDocs.filter((r) => r.newEscalate);
const bestKeptA1 = okRows.filter((r) => r.retried && r.bestAttempt === "attempt1");
const expertDiscarded = okRows.filter((r) => r.expertDiscardReason);
const recovered = okRows.filter((r) => r.attempt2Gate?.startsWith("recovered"));

const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
const p50 = durations[Math.floor(durations.length * 0.5)]!;
const p95 = durations[Math.floor(durations.length * 0.95)]!;

console.log("\n===== 汇总 =====");
console.log(`运行: ${rows.length - runFailures}/${rows.length} 成功（RUN_FAILURE=${runFailures}）`);
console.log(`L2 调用率: B3'(旧)=${oldL2.length}/10, B4(新)=${newL2.length}/10`);
console.log(`非 truncated L2: B4=${newNonTruncL2.length}/10（目标 <20%）`);
console.log(`短文档(≤2000tok): ${shortDocs.length} 篇（简历/对接），旧逻辑升级 ${shortEscOld.length} → 新逻辑 ${shortEscNew.length}（目标 0）`);
console.log(`best-attempt 保留 attempt1: ${bestKeptA1.length} 次（attempt2 更差被否决）`);
console.log(`expert 被弃用（分数低于 best standard）: ${expertDiscarded.length} 次`);
console.log(`差异化重试恢复: ${recovered.length} 次`);
console.log(`平均总 token (B4): ${avg(okRows, (r) => r.totalTokens).toFixed(0)}`);
console.log(`延迟: P50=${(p50 / 1000).toFixed(1)}s, P95=${(p95 / 1000).toFixed(1)}s`);
console.log(`Judge 有效 ${valid.length}/${rows.length}（失败 ${judgeFail}）`);
console.log(`有效运行均分: B3'=${aMean.toFixed(2)}, B4=${bMean.toFixed(2)}`);
console.log(`端到端期望质量（成功率 ${(successRate * 100).toFixed(0)}%）: B3'=${(successRate * aMean).toFixed(2)}, B4=${(successRate * bMean).toFixed(2)}`);

console.log("\n分文档：");
for (const row of okRows) {
  const j = judgeResults.find((x) => x.name === row.name);
  const s = j && !j.judgeFail ? `B3'=${((j.A.accuracy + j.A.completeness) / 2).toFixed(1)} B4=${((j.B.accuracy + j.B.completeness) / 2).toFixed(1)}` : "无分";
  console.log(`[${row.name}] ${s} | est=${row.estimatedTokens} ${row.shortDocument ? "[短]" : ""} | best=${row.bestAttempt} | B4升级=${row.newEscalate ? "Y" : "n"} B3'升级=${row.b3Escalated ? "Y" : "n"} | ${row.expertDiscardReason ? "专家弃用" : ""} | ${(row.durationMs / 1000).toFixed(0)}s`);
}
console.log(`\n结果已存: ${OUT_DIR}/results.json`);
