/**
 * 真实文档对比实验：直返 vs 子 agent（10 个本地文档，含 PDF/DOCX/MD）
 *
 * 每个文档统一问题：总结主要内容 + 提取 3 个关键事实（含具体数字/名称）
 * 指标：
 *  1. 主上下文输入 tokens
 *  2. 总 token 消耗
 *  3. 端到端耗时
 *  4. LLM judge 评分（1-5）：准确性、完整性、幻觉
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LLM_URL = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-chat";
const API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const MAX_CHARS = 200000; // DeepSeek 128K 上下文，不截断

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

const OUT_DIR = "/tmp/real-docs-exp";
mkdirSync(OUT_DIR, { recursive: true });

async function callLlm(messages: { role: string; content: string }[]): Promise<{ content: string; promptTokens: number; completionTokens: number; durationMs: number }> {
  const started = Date.now();
  const resp = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 600 }),
  });
  const data = await resp.json() as any;
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - started,
  };
}

// 解析文档（markitdown）→ 截断 → 落盘
async function prepareDocs(): Promise<{ name: string; file: string; text: string }[]> {
  const prepared: { name: string; file: string; text: string }[] = [];
  for (const doc of DOCS) {
    const { execFile } = await import("node:child_process");
    const text = await new Promise<string>((res, rej) => {
      execFile("python3", ["-c", `
import warnings, sys, json
warnings.filterwarnings('ignore')
from markitdown import MarkItDown
md = MarkItDown()
r = md.convert(sys.argv[1])
print(json.dumps(r.text_content, ensure_ascii=False))
`, doc.path], { maxBuffer: 1024 * 1024 * 50 }, (err, stdout) => {
        if (err) rej(new Error(`markitdown failed: ${err.message}`));
        else {
          try { res(JSON.parse(stdout)); } catch { rej(new Error("parse failed")); }
        }
      });
    });
    const truncated = text.slice(0, MAX_CHARS);
    const file = join(OUT_DIR, `${doc.name}.md`);
    writeFileSync(file, truncated);
    prepared.push({ name: doc.name, file, text: truncated });
    console.log(`[prepare] ${doc.name}: ${text.length} chars → ${truncated.length} chars (${text.length > MAX_CHARS ? "截断" : "完整"})`);
  }
  return prepared;
}

// ===== 方案 A：直返 =====
async function runDirect(docs: { name: string; text: string }[]): Promise<any[]> {
  const results = [];
  for (const doc of docs) {
    const r = await callLlm([
      { role: "system", content: "你是文档分析师。基于文档内容回答。不要猜测文档中不存在的信息。" },
      { role: "user", content: `--- 文档内容 ---\n${doc.text}\n\n--- 问题 ---\n${QUESTION}` },
    ]);
    results.push({ name: doc.name, answer: r.content, mainContextTokens: r.promptTokens, totalTokens: r.promptTokens + r.completionTokens, durationMs: r.durationMs });
    console.log(`[A] ${doc.name} done (${(r.durationMs / 1000).toFixed(0)}s)`);
  }
  return results;
}

// ===== 方案 B：子 agent =====
async function runSubagent(docs: { name: string; file: string }[]): Promise<any[]> {
  const results = [];
  for (const doc of docs) {
    const started = Date.now();
    // 子 agent = 独立上下文窗口的 API 调用（DeepSeek）
    const sub = await callLlm([
      { role: "system", content: "你是文档分析师，在独立上下文中工作。基于文档内容回答。不要猜测文档中不存在的信息。" },
      { role: "user", content: `--- 文档内容 ---\n${doc.text}\n\n--- 问题 ---\n${QUESTION}` },
    ]);
    const main = await callLlm([
      { role: "system", content: "你是对话助手。基于工具返回的分析结果汇报。" },
      { role: "user", content: `子代理分析结果：\n${sub.content}\n\n问题：${QUESTION}` },
    ]);
    results.push({ name: doc.name, answer: sub.content, mainContextTokens: main.promptTokens, totalTokens: sub.promptTokens + sub.completionTokens + main.promptTokens + main.completionTokens, durationMs: Date.now() - started });
    console.log(`[B] ${doc.name} done (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  return results;
}

// ===== Judge：对照文档评两个答案 =====
async function judge(docs: { name: string; text: string }[], a: any[], b: any[]): Promise<any[]> {
  const scores = [];
  for (let i = 0; i < docs.length; i++) {
    const r = await callLlm([
      { role: "system", content: "你是严格的文档答案评判员。对照文档原文，分别给两个答案评分（1-5 整数）：准确性（是否与文档一致、有无幻觉）、完整性（是否覆盖文档要点）、简洁性。输出 JSON: {\"A\": {\"accuracy\": n, \"completeness\": n, \"note\": \"...\"}, \"B\": {...}}。不要输出其他内容。" },
      { role: "user", content: `--- 文档原文（截断）---\n${docs[i]!.text.slice(0, 12000)}\n\n--- 答案 A（直返）---\n${a[i]!.answer}\n\n--- 答案 B（子代理）---\n${b[i]!.answer}` },
    ]);
    let parsed: any = null;
    try {
      const m = r.content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch { }
    scores.push({ name: docs[i]!.name, raw: r.content, A: parsed?.A, B: parsed?.B });
    console.log(`[judge] ${docs[i]!.name} done`);
  }
  return scores;
}

console.log("=== 真实文档对比实验 ===");
console.log(`文档数: ${DOCS.length} | 截断上限: ${MAX_CHARS} chars | 模型: ${MODEL}`);

const docs = await prepareDocs();

console.log("\n--- 方案 A（直返）---");
const resultsA = await runDirect(docs);

console.log("\n--- 方案 B（子 agent）---");
const resultsB = await runSubagent(docs);

console.log("\n--- Judge 评分 ---");
const scores = await judge(docs, resultsA, resultsB);

// 汇总
const out = { docs, resultsA, resultsB, scores, question: QUESTION, timestamp: new Date().toISOString() };
writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify(out, null, 2));

console.log("\n===== 汇总 =====");
for (let i = 0; i < docs.length; i++) {
  const a = resultsA[i]!;
  const b = resultsB[i]!;
  const s = scores[i]!;
  const aScore = s.A ? (s.A.accuracy + s.A.completeness) / 2 : 0;
  const bScore = s.B ? (s.B.accuracy + s.B.completeness) / 2 : 0;
  console.log(`[${docs[i]!.name}] A=${aScore.toFixed(1)} B=${bScore.toFixed(1)} | A主ctx=${a.mainContextTokens} B主ctx=${b.mainContextTokens} | A=${(a.durationMs / 1000).toFixed(0)}s B=${(b.durationMs / 1000).toFixed(0)}s`);
}

const avgA = resultsA.reduce((s, r) => s + r.mainContextTokens, 0) / resultsA.length;
const avgB = resultsB.reduce((s, r) => s + r.mainContextTokens, 0) / resultsB.length;
const totA = resultsA.reduce((s, r) => s + r.totalTokens, 0) / resultsA.length;
const totB = resultsB.reduce((s, r) => s + r.totalTokens, 0) / resultsB.length;
const durA = resultsA.reduce((s, r) => s + r.durationMs, 0) / resultsA.length;
const durB = resultsB.reduce((s, r) => s + r.durationMs, 0) / resultsB.length;
const validScores = scores.filter((s) => s.A && s.B);
const scoreA = validScores.reduce((s, x) => s + (x.A.accuracy + x.A.completeness) / 2, 0) / validScores.length;
const scoreB = validScores.reduce((s, x) => s + (x.B.accuracy + x.B.completeness) / 2, 0) / validScores.length;

console.log(`\n===== 最终对比 =====`);
console.log(`主上下文输入: A=${avgA.toFixed(0)} tok, B=${avgB.toFixed(0)} tok (${((1 - avgB / avgA) * 100).toFixed(0)}%)`);
console.log(`总 token: A=${totA.toFixed(0)} tok, B=${totB.toFixed(0)} tok`);
console.log(`耗时: A=${(durA / 1000).toFixed(1)}s, B=${(durB / 1000).toFixed(1)}s`);
console.log(`Judge 均分(准确+完整): A=${scoreA.toFixed(2)}, B=${scoreB.toFixed(2)}`);
console.log(`\n结果已存: ${OUT_DIR}/results.json`);
