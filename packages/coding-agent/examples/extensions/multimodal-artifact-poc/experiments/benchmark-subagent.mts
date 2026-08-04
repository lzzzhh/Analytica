/**
 * 对比实验：文档解析 直返 vs 子 agent
 *
 * 方案 A (baseline 直返)：文档全文 + 问题 → Qwen3-8B 单次调用
 * 方案 B (子 agent)：文档全文 → 子 agent 独立上下文回答 → 答案进主上下文 → Qwen3-8B 汇报
 *
 * 指标：
 *  1. 主上下文输入 tokens（方案 A = 全文+问题；方案 B = 子agent答案+问题）
 *  2. 总 token 消耗（含子 agent）
 *  3. 答案质量（规则评分：ground truth 数字/关键词是否在答案中）
 *  4. 端到端耗时
 */
import { readFileSync } from "node:fs";
import { runDocumentSubagent } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/subagent.ts";

const LLM_URL = "http://127.0.0.1:8080/v1/chat/completions";
const MODEL = "Qwen3-8B-Q4_K_M";

const DOC = readFileSync("/tmp/bench-doc.md", "utf8");

const QUESTIONS = [
  { q: "2024 年云智科技的总收入是多少亿元？", truth: ["8.72"], label: "事实-总收入" },
  { q: "2024 年客户续约率和净收入留存率分别是多少？", truth: ["88.6", "106.2"], label: "事实-客户指标" },
  { q: "哪个产品线的收入占比最高？", truth: ["云计算", "39.6"], label: "事实-产品线" },
  { q: "公司预计 2025 年总收入达到多少亿元？", truth: ["10.5", "10.9"], label: "事实-展望" },
  { q: "文档中提到了 2025 年的融资计划吗？", truth: ["B 轮"], label: "综合-融资" },
];

async function callLlm(messages: { role: string; content: string }[]): Promise<{ content: string; promptTokens: number; completionTokens: number; durationMs: number }> {
  const started = Date.now();
  const resp = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 300 }),
  });
  const data = await resp.json() as any;
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - started,
  };
}

function scoreAnswer(answer: string, truths: string[]): number {
  const normalized = answer.toLowerCase().replace(/\s+/g, "");
  const hits = truths.filter((t) => normalized.includes(t.toLowerCase().replace(/\s+/g, "")));
  return hits.length / truths.length;
}

// ============ 方案 A：直返 ============
async function runDirect(): Promise<any[]> {
  const results = [];
  for (const item of QUESTIONS) {
    const { content, promptTokens, completionTokens, durationMs } = await callLlm([
      { role: "system", content: "你是文档分析师。基于提供的文档内容回答。不要猜测文档中不存在的信息。" },
      { role: "user", content: `--- 文档内容 ---\n${DOC}\n\n--- 问题 ---\n${item.q}` },
    ]);
    results.push({
      label: item.label,
      answer: content,
      mainContextTokens: promptTokens,
      totalTokens: promptTokens + completionTokens,
      durationMs,
      quality: scoreAnswer(content, item.truth),
    });
  }
  return results;
}

// ============ 方案 B：子 agent ============
async function runSubagent(): Promise<any[]> {
  const results = [];
  for (const item of QUESTIONS) {
    const started = Date.now();
    const sub = await runDocumentSubagent({
      markdownPath: "/tmp/bench-doc.md",
      artifactId: "doc_benchmark",
      question: item.q,
    });

    if (sub.error) {
      results.push({ label: item.label, answer: `ERROR: ${sub.error}`, mainContextTokens: 0, totalTokens: 0, durationMs: Date.now() - started, quality: 0 });
      continue;
    }

    // 子 agent 答案进主上下文，主 agent 汇报（模拟真实链路）
    const main = await callLlm([
      { role: "system", content: "你是对话助手。基于工具返回的分析结果，直接向用户汇报。" },
      { role: "user", content: `子代理对文档问题的分析结果如下：\n${sub.answer}\n\n原始问题：${item.q}` },
    ]);

    results.push({
      label: item.label,
      answer: sub.answer,
      mainContextTokens: main.promptTokens,
      totalTokens: sub.subagentTokens + main.promptTokens + main.completionTokens,
      durationMs: Date.now() - started,
      quality: scoreAnswer(sub.answer, item.truth),
    });
  }
  return results;
}

// ============ 汇总 ============
function summarize(name: string, results: any[]): void {
  const avgMain = results.reduce((s, r) => s + r.mainContextTokens, 0) / results.length;
  const avgTotal = results.reduce((s, r) => s + r.totalTokens, 0) / results.length;
  const avgDur = results.reduce((s, r) => s + r.durationMs, 0) / results.length;
  const avgQuality = results.reduce((s, r) => s + r.quality, 0) / results.length;
  console.log(`\n===== ${name} =====`);
  for (const r of results) {
    console.log(`  [${r.label}] 质量: ${(r.quality * 100).toFixed(0)}% | 主上下文: ${r.mainContextTokens} tok | 总: ${r.totalTokens} tok | ${(r.durationMs / 1000).toFixed(1)}s`);
    console.log(`      答案: ${r.answer.slice(0, 120)}...`);
  }
  console.log(`  平均主上下文: ${avgMain.toFixed(0)} tok | 平均总消耗: ${avgTotal.toFixed(0)} tok | 平均耗时: ${(avgDur / 1000).toFixed(1)}s | 平均质量: ${(avgQuality * 100).toFixed(0)}%`);
}

console.log("=== 实验开始 ===");
console.log(`文档大小: ${DOC.length} chars`);

console.log("\n--- 运行方案 A（直返）---");
const direct = await runDirect();
summarize("方案 A: 直返", direct);

console.log("\n--- 运行方案 B（子 agent）---");
const subagent = await runSubagent();
summarize("方案 B: 子 agent", subagent);

// 最终对比
const a = direct;
const b = subagent;
console.log("\n===== 最终对比 =====");
console.log(`主上下文输入（越小越好）: A=${(a.reduce((s, r) => s + r.mainContextTokens, 0) / a.length).toFixed(0)} tok, B=${(b.reduce((s, r) => s + r.mainContextTokens, 0) / b.length).toFixed(0)} tok`);
console.log(`总 token 消耗（含子代理）: A=${(a.reduce((s, r) => s + r.totalTokens, 0) / a.length).toFixed(0)} tok, B=${(b.reduce((s, r) => s + r.totalTokens, 0) / b.length).toFixed(0)} tok`);
console.log(`端到端耗时: A=${(a.reduce((s, r) => s + r.durationMs, 0) / a.length / 1000).toFixed(1)}s, B=${(b.reduce((s, r) => s + r.durationMs, 0) / b.length / 1000).toFixed(1)}s`);
console.log(`答案质量: A=${(a.reduce((s, r) => s + r.quality, 0) / a.length * 100).toFixed(0)}%, B=${(b.reduce((s, r) => s + r.quality, 0) / b.length * 100).toFixed(0)}%`);
