/**
 * 两级 Agent 编排器评估（10 个真实文档）
 *
 * 对比：
 *  方案 A：直返（文档全文 → LLM 单次调用）
 *  方案 B：两级编排器（预路由 → L1 flash → 升级 → L2 pro → Evidence Merger）
 *
 * 指标：
 *  1. 主上下文输入 tokens
 *  2. 总 token 消耗
 *  3. 端到端耗时
 *  4. LLM judge 评分（1-5）：准确性、完整性
 *  5. 升级触发情况
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { orchestrateDocumentAnalysis } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/orchestrator.ts";
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
const OUT_DIR = "/tmp/orchestrator-exp";
mkdirSync(OUT_DIR, { recursive: true });

// 复用 /tmp/real-docs-exp 已解析的文档（markitdown 结果）
function loadDoc(name: string): string {
  return readFileSync(`/tmp/real-docs-exp/${name}.md`, "utf8");
}

function packetToAnswerText(merged: any): string {
  const lines: string[] = [];
  for (const f of merged.facts) {
    lines.push(`- ${f.claim}: ${f.value}${f.evidence ? ` [${f.evidence}]` : ""}`);
  }
  for (const i of merged.inferences) lines.push(`- ${i.claim}`);
  for (const u of merged.unknowns) lines.push(`- (未知) ${u}`);
  for (const c of merged.conflicts) {
    lines.push(`- (冲突) ${c.claim}: ${c.candidates.map((x: any) => x.value).join(" vs ")}`);
  }
  return lines.join("\n") || "(无提取结果)";
}

// ===== 方案 A：直返（v4-flash，同 L1 模型）=====
async function runDirect(docs: { name: string; text: string }[]): Promise<any[]> {
  const results = [];
  for (const doc of docs) {
    const r = await callLlm(
      [
        { role: "system", content: "你是文档分析师。基于文档内容回答。不要猜测文档中不存在的信息。" },
        { role: "user", content: `--- 文档内容 ---\n${doc.text}\n\n--- 问题 ---\n${QUESTION}` },
      ],
      "deepseek-v4-flash",
      1500,
    );
    results.push({ name: doc.name, answer: r.content, mainContextTokens: r.promptTokens, totalTokens: r.promptTokens + r.completionTokens, durationMs: r.durationMs });
    console.log(`[A] ${doc.name} done (${(r.durationMs / 1000).toFixed(0)}s)`);
  }
  return results;
}

// ===== 方案 B：两级编排 =====
async function runOrchestrated(docs: { name: string; text: string }[]): Promise<any[]> {
  const results = [];
  for (const doc of docs) {
    const started = Date.now();
    const r = await orchestrateDocumentAnalysis({
      documentId: `doc_${doc.name}`,
      documentText: doc.text,
      question: QUESTION,
    });
    if (r.error) {
      results.push({ name: doc.name, answer: `ERROR: ${r.error}`, mainContextTokens: 0, totalTokens: 0, durationMs: Date.now() - started, escalated: false, route: "error" });
      console.log(`[B] ${doc.name} ERROR: ${r.error.slice(0, 80)}`);
      continue;
    }
    // 主上下文 = 合并后的证据文本（发给主 agent 的内容）
    const answerText = packetToAnswerText(r.merged);
    let mainTokens = 0;
    let answer = answerText; // 默认降级：证据文本直接作为答案
    try {
      const main = await callLlm(
        [
          { role: "system", content: "你是对话助手。基于证据包向用户汇报，组织成连贯的总结。" },
          { role: "user", content: `证据包：\n${answerText}\n\n问题：${QUESTION}` },
        ],
        "deepseek-v4-flash",
        800,
      );
      mainTokens = main.promptTokens + main.completionTokens;
      if (main.content.trim()) answer = main.content; // 主汇报成功时用它做答案
    } catch {
      mainTokens = Math.ceil(answerText.length / 4);
    }
    results.push({
      name: doc.name,
      answer,
      mainContextTokens: Math.ceil(answerText.length / 4),
      totalTokens: r.tokens.l1 + r.tokens.l2 + mainTokens,
      durationMs: Date.now() - started,
      escalated: r.escalation,
      route: r.route.route,
      riskScore: r.route.riskScore,
    });
    console.log(`[B] ${doc.name} done (${((Date.now() - started) / 1000).toFixed(0)}s, escalate=${r.escalation})`);
  }
  return results;
}

// ===== Judge =====
async function judge(docs: { name: string; text: string }[], a: any[], b: any[]): Promise<any[]> {
  const scores = [];
  for (let i = 0; i < docs.length; i++) {
    let r;
    try {
      r = await callLlm(
        [
          { role: "system", content: "你是严格的文档答案评判员。对照文档原文，分别给两个答案评分（1-5 整数）：准确性（是否与文档一致、有无幻觉）、完整性（是否覆盖文档要点）。输出 JSON: {\"A\": {\"accuracy\": n, \"completeness\": n, \"note\": \"...\"}, \"B\": {\"accuracy\": n, \"completeness\": n, \"note\": \"...\"}}。不要输出其他内容。" },
          { role: "user", content: `--- 文档原文（截断）---\n${docs[i]!.text.slice(0, 8000)}\n\n--- 答案 A（直返）---\n${a[i]!.answer.slice(0, 1500)}\n\n--- 答案 B（两级编排）---\n${b[i]!.answer.slice(0, 1500)}` },
        ],
        "deepseek-v4-flash",
        800,
      );
    } catch (e) {
      console.log(`[judge] ${docs[i]!.name} ERROR: ${(e as Error).message.slice(0, 60)}`);
      scores.push({ name: docs[i]!.name, raw: "", A: null, B: null });
      continue;
    }
    let parsed: any = null;
    try {
      const m = r.content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch {}
    scores.push({ name: docs[i]!.name, raw: r.content, A: parsed?.A, B: parsed?.B });
    console.log(`[judge] ${docs[i]!.name} done${parsed ? "" : " (PARSE FAIL)"}`);
  }
  return scores;
}

console.log("=== 两级编排器评估（10 真实文档）===");
const docs = DOCS.map((d) => ({ name: d.name, text: loadDoc(d.name) }));

console.log("\n--- 方案 A（直返 flash）---");
const resultsA = await runDirect(docs);

console.log("\n--- 方案 B（两级编排）---");
const resultsB = await runOrchestrated(docs);

console.log("\n--- Judge ---");
const scores = await judge(docs, resultsA, resultsB);

writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify({ resultsA, resultsB, scores, timestamp: new Date().toISOString() }, null, 2));

console.log("\n===== 汇总 =====");
for (let i = 0; i < docs.length; i++) {
  const a = resultsA[i]!;
  const b = resultsB[i]!;
  const s = scores[i]!;
  const aScore = s.A ? (s.A.accuracy + s.A.completeness) / 2 : 0;
  const bScore = s.B ? (s.B.accuracy + s.B.completeness) / 2 : 0;
  console.log(`[${docs[i]!.name}] A=${aScore.toFixed(1)} B=${bScore.toFixed(1)} | 升级=${b.escalated ? "Y" : "n"}(${b.route}) | A主ctx=${a.mainContextTokens} B主ctx=${b.mainContextTokens} | A=${(a.durationMs / 1000).toFixed(0)}s B=${(b.durationMs / 1000).toFixed(0)}s`);
}

const avg = (arr: any[], f: (x: any) => number) => arr.reduce((s, r) => s + f(r), 0) / arr.length;
console.log(`\n===== 最终对比 =====`);
console.log(`主上下文输入: A=${avg(resultsA, r => r.mainContextTokens).toFixed(0)} tok, B=${avg(resultsB, r => r.mainContextTokens).toFixed(0)} tok`);
console.log(`总 token: A=${avg(resultsA, r => r.totalTokens).toFixed(0)} tok, B=${avg(resultsB, r => r.totalTokens).toFixed(0)} tok`);
console.log(`耗时: A=${(avg(resultsA, r => r.durationMs) / 1000).toFixed(1)}s, B=${(avg(resultsB, r => r.durationMs) / 1000).toFixed(1)}s`);
const valid = scores.filter((s) => s.A && s.B);
console.log(`Judge 均分: A=${(valid.reduce((s, x) => s + (x.A.accuracy + x.A.completeness) / 2, 0) / valid.length).toFixed(2)}, B=${(valid.reduce((s, x) => s + (x.B.accuracy + x.B.completeness) / 2, 0) / valid.length).toFixed(2)}`);
console.log(`升级触发: ${resultsB.filter((r) => r.escalated).length}/10`);
console.log(`\n结果已存: ${OUT_DIR}/results.json`);
