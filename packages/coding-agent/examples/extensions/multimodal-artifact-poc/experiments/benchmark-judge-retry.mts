/**
 * 补跑 judge：v2 运行中 6/10 judge 因 API 空响应失败。
 * 只对缺失分数的文档重新评分，每篇最多 4 轮（每轮 callLlm 内 3 次重试）。
 * 重点覆盖 4 篇升级文档（L2 专家参与的答案）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { callLlm } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/doc-agents.ts";

const exp = JSON.parse(readFileSync("/tmp/orchestrator-exp/results.json", "utf8"));
const resultsA: any[] = exp.resultsA;
const resultsB: any[] = exp.resultsB;
const existing = new Map(exp.scores.map((s: any) => [s.name, s]));

// 缺失分数的文档（v2 中 ERROR 或 PARSE FAIL 的）
const MISSING = resultsA.filter((_, i) => !existing.get(resultsA[i]!.name)?.A || !existing.get(resultsB[i]!.name)?.B);

const DOC_NAMES = [
  "简历-悉尼大学", "面经-RAG", "对接说明", "编码面试", "财富Agent优化",
  "AI数据分析Agent交接", "RiskCloud任务书", "Spark知识总结", "论文-StructuralFeasibility", "论文-CDXR",
];
const DOC_PATH = (name: string) =>
  name === "简历-悉尼大学" ? "/Users/zhanhuilin/Documents/林展辉_悉尼大学_2027届毕业生(1).pdf"
  : name === "面经-RAG" ? "/Users/zhanhuilin/Downloads/大模型 RAG 检索增强生成面.pdf"
  : name === "对接说明" ? "/Users/zhanhuilin/Downloads/对接说明.docx"
  : name === "编码面试" ? "/Users/zhanhuilin/Downloads/vibe-coding-interviews.docx.docx"
  : name === "财富Agent优化" ? "/Users/zhanhuilin/Downloads/wealth_agent_optimization.docx"
  : name === "AI数据分析Agent交接" ? "/Users/zhanhuilin/Downloads/AI数据分析Agent_下一会话交接文档_v1.0.md"
  : name === "RiskCloud任务书" ? "/Users/zhanhuilin/Downloads/RiskCloud_多Agent数据治理架构_OpenCode实施任务书.md"
  : name === "Spark知识总结" ? "/Users/zhanhuilin/Downloads/Spark核心知识总结_完整版.md"
  : name === "论文-StructuralFeasibility" ? "/Users/zhanhuilin/Downloads/Structural_Feasibility_as_a_Compositional_Value__An_Execution_Algebra_for_Neural_Complex_Query_Answering.pdf"
  : "/Users/zhanhuilin/Downloads/CDXR_EDBT_2027.pdf";

const QUESTION = "总结这个文档的主要内容，并提取 3 个关键事实（尽量包含具体数字或名称）。";

const JUDGE_SYSTEM = `你是严格的文档答案评判员。对照文档原文，分别给两个答案评分（1-5 整数）：准确性（是否与文档一致、有无幻觉）、完整性（是否覆盖文档要点）。输出 JSON: {"A": {"accuracy": n, "completeness": n, "note": "..."}, "B": {"accuracy": n, "completeness": n, "note": "..."}}。不要输出其他内容。`;

async function judgeOne(name: string): Promise<{ A: any; B: any } | null> {
  const doc = readFileSync(`/tmp/real-docs-exp/${name}.md`, "utf8");
  const a = resultsA.find((r: any) => r.name === name);
  const b = resultsB.find((r: any) => r.name === name);
  for (let round = 1; round <= 4; round++) {
    try {
      const r = await callLlm(
        [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `--- 文档原文（截断）---\n${doc.slice(0, 8000)}\n\n--- 答案 A（直返）---\n${a.answer.slice(0, 1500)}\n\n--- 答案 B（两级编排）---\n${b.answer.slice(0, 1500)}` },
        ],
        "deepseek-v4-flash",
        800,
      );
      const m = r.content.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : null;
      if (parsed?.A && parsed?.B) return parsed;
      console.log(`  round ${round}: PARSE FAIL, retry`);
    } catch (e) {
      console.log(`  round ${round}: ${(e as Error).message.slice(0, 60)}, retry`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

console.log(`补跑 judge（${MISSING.length} 篇缺失分数，重点：4 篇升级文档）`);
const retried: any[] = [];
for (const r of MISSING) {
  const name: string = r.name;
  process.stdout.write(`[judge] ${name} ... `);
  const score = await judgeOne(name);
  if (score) {
    retried.push({ name, A: score.A, B: score.B });
    console.log(`A=${((score.A.accuracy + score.A.completeness) / 2).toFixed(1)} B=${((score.B.accuracy + score.B.completeness) / 2).toFixed(1)}`);
  } else {
    console.log("FAILED (4 rounds)");
  }
}

console.log("\n===== 补跑结果 =====");
const allScores = [...(exp.scores as any[]), ...retried];
writeFileSync("/tmp/orchestrator-exp/judge-retry.json", JSON.stringify({ retried, allScores }, null, 2));

// 汇总：每篇文档的最佳分数
console.log("\n合并后每篇文档分数：");
const merged = new Map<string, any>();
for (const s of exp.scores as any[]) if (s.A && s.B) merged.set(s.name, s);
for (const s of retried) merged.set(s.name, s);
for (const name of DOC_NAMES) {
  const s = merged.get(name);
  if (s) {
    const a = (s.A.accuracy + s.A.completeness) / 2;
    const b = (s.B.accuracy + s.B.completeness) / 2;
    console.log(`${name}: A=${a.toFixed(1)} B=${b.toFixed(1)} ${a > b ? "(A)" : b > a ? "(B)" : "(平)"}`);
  } else {
    console.log(`${name}: 无分数`);
  }
}
