/**
 * L1 (standard) and L2 (expert) document analysis agents.
 *
 * Both produce EvidencePackets. L1 may return `status: "partial"` with an
 * escalation request when it hits context/complexity/confidence limits.
 * L2 is invoked by the orchestrator with a NARROW scope (pages/sections),
 * never the whole document.
 */

import type { EvidencePacket, EvidenceFact, EscalationReasonCode } from "./evidence.ts";

const LLM_URL = "https://api.deepseek.com/v1/chat/completions";
const L1_MODEL = "deepseek-v4-flash";
const L2_MODEL = "deepseek-v4-pro";

export interface LlmCallResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export async function callLlm(
  messages: { role: string; content: string }[],
  model: string,
  maxTokens = 1000,
  temperature?: number,
): Promise<LlmCallResult> {
  const started = Date.now();
  // Retry on empty content (observed intermittent empty responses from the API)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, ...(temperature !== undefined ? { temperature } : {}) }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (attempt < 3 && resp.status >= 500) continue;
      throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (content.trim()) {
      return {
        content,
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        durationMs: Date.now() - started,
      };
    }
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error("LLM returned empty content after 3 attempts");
}

// ============================================================
// JSON extraction (tolerant of markdown fences / extra text)
// ============================================================

export function extractJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidate = fenced?.[1] ?? raw;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    }
    throw new Error(`No JSON in response: ${raw.slice(0, 200)}`);
  }
}

// ============================================================
// Shared packet prompt
// ============================================================

const PACKET_SCHEMA_DOC = `{
  "facts": [{"claim": "简短标签", "value": "精确值(数字或字符串)", "evidence": "来源(页码/表格/段落)", "confidence": 0-1, "kind": "cited|inferred"}],
  "inferences": [{"claim": "定性结论", "confidence": 0-1}],
  "unknowns": ["无法确定的内容"],
  "confidence": 0-1,
  "status": "complete|partial|insufficient|failed",
  "failureReason": "仅当 status 非 complete 时填写，如 CONTEXT_EXCEEDED / GENERATION_FAILED",
  "escalationRecommended": true
}`;

const L1_PROMPT = `你是标准档文档分析 agent。基于提供的文档段落，回答用户问题。
规则：
- facts 只放文档中明确出现的值，标注来源和 confidence。
- kind="cited" 表示文档原文可见；kind="inferred" 表示基于内容的推断（如趋势）。
- 无法从段落确定的内容放入 unknowns，不要编造。
- 输出严格 JSON（无 markdown 围栏），结构如下：
${PACKET_SCHEMA_DOC}
- 如果无法完成分析（上下文溢出、内容不足等），不要返回空摘要或泛化总结；
  必须返回 status="insufficient" 并填写 failureReason，必要时 escalationRecommended: true。
当满足以下任一条件时，status 必须为 "partial"，并在末尾追加 escalation JSON：
{
  "escalation": {
    "required": true,
    "reasonCodes": ["CONTEXT_BUDGET_EXCEEDED" | "INPUT_TRUNCATED" | "REQUIRED_PAGES_MISSING" | "CROSS_DOCUMENT_REASONING" | "LOW_CONFIDENCE" | "CONFLICTING_CLAIMS" | "UNRESOLVED_QUESTIONS" | "HIGH_COMPLEXITY"],
    "scope": {"documentId": "...", "pages": [], "sections": []},
    "question": "需要专家处理的具体问题",
    "knownFacts": ["已确认的事实"],
    "unresolvedQuestions": ["未解决问题"],
    "estimatedInputTokens": 估算值
  }
}
升级条件（触发即 partial）：
1. 段落被截断或上下文预算不足（CONTEXT_BUDGET_EXCEEDED / INPUT_TRUNCATED）
2. 答案依赖不在当前段落中的章节/页（REQUIRED_PAGES_MISSING / CROSS_DOCUMENT_REASONING）
3. 关键信息置信度 < 0.5（LOW_CONFIDENCE）
4. 文档内存在相互矛盾的信息（CONFLICTING_CLAIMS）
5. 需要跨章节推理、财务重算、条款冲突判断等复杂任务（HIGH_COMPLEXITY）
6. 存在无法解决的问题（UNRESOLVED_QUESTIONS）
不满足升级条件时，escalation 为 null。`;

const L2_PROMPT = `你是专家档文档分析 agent。基于提供的文档段落（可能是不完整片段），回答升级请求中的问题。
规则：
- 深入分析给定内容，包括跨段推理。
- facts 只放有依据的值；基于内容的推断放 inferences；不确定放 unknowns。
- 若给定内容不足以回答，明确写入 unknowns，不要猜测。
- 输出严格 JSON（无 markdown 围栏）：
${PACKET_SCHEMA_DOC}
（专家不返回 escalation 字段）`;

/**
 * Tolerantly normalize an L1 response into an EvidencePacket.
 * Handles: exact schema, key_facts-style arrays, markdown fences, non-JSON text.
 */
function normalizeL1Packet(
  content: string,
  documentId: string,
  truncated: boolean,
  question: string,
  documentText: string,
): EvidencePacket {
  const base = {
    producer: { agent: "document-worker", tier: "standard" as const, model: L1_MODEL },
    scope: { documentId, truncated },
  };

  let raw: unknown;
  try {
    raw = extractJson<unknown>(content);
  } catch {
    raw = undefined;
  }

  // Exact-ish schema
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.facts)) {
      return {
        ...base,
        facts: (r.facts as Record<string, unknown>[]).map((f) => ({
          claim: String(f.claim ?? f.name ?? "fact"),
          value: (f.value ?? f.text ?? "") as string | number,
          evidence: typeof f.evidence === "string" ? f.evidence : undefined,
          confidence: typeof f.confidence === "number" ? f.confidence : 0.5,
          kind: (f.kind === "parse" || f.kind === "inferred" ? f.kind : "cited") as EvidencePacket["facts"][number]["kind"],
        })),
        inferences: Array.isArray(r.inferences)
          ? (r.inferences as Record<string, unknown>[]).map((i) => ({
              claim: String(i.claim ?? i.text ?? ""),
              confidence: typeof i.confidence === "number" ? i.confidence : 0.5,
            }))
          : [],
        unknowns: Array.isArray(r.unknowns) ? (r.unknowns as unknown[]).map(String) : [],
        confidence: typeof r.confidence === "number" ? r.confidence : 0.5,
        status: (["complete", "partial", "insufficient", "failed"] as const).includes(r.status as never)
          ? (r.status as EvidencePacket["status"])
          : "complete",
        failureReason: typeof r.failureReason === "string" ? r.failureReason : undefined,
        escalationRecommended: r.escalationRecommended === true,
        escalation:
          r.escalation && typeof r.escalation === "object"
            ? (r.escalation as EvidencePacket["escalation"])
            : undefined,
      };
    }

    // key_facts-style: array of strings/objects → inferred facts
    if (Array.isArray(r.key_facts) || Array.isArray(r.facts_list) || Array.isArray(r.summary)) {
      const items = (Array.isArray(r.key_facts) ? r.key_facts : r.facts_list ?? r.summary) as unknown[];
      return {
        ...base,
        facts: [],
        inferences: items.map((item) => ({
          claim: typeof item === "string" ? item : String((item as Record<string, unknown>).text ?? JSON.stringify(item)),
          confidence: 0.5,
        })),
        unknowns: Array.isArray(r.unknowns) ? (r.unknowns as unknown[]).map(String) : [],
        confidence: 0.5,
        status: "complete",
      };
    }
  }

  // Truncated JSON (parse failed but looks like JSON) → salvage claim/value pairs
  if (content.trim().startsWith("{")) {
    const pairs: EvidenceFact[] = [];
    const re = /"claim"\s*:\s*"([^"]{1,200})"[\s\S]{0,400}?"value"\s*:\s*"([^"]{1,200})"/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      pairs.push({ claim: m[1]!, value: m[2]!, kind: "cited", confidence: 0.5 });
    }
    if (pairs.length > 0) {
      return { ...base, facts: pairs, inferences: [], unknowns: [], confidence: 0.5, status: "complete" };
    }
  }

  // Non-JSON free text → everything becomes an inference
  const cleaned = content.trim();
  if (cleaned) {
    return {
      ...base,
      facts: [],
      inferences: [{ claim: cleaned.slice(0, 500), confidence: 0.4 }],
      unknowns: [],
      confidence: 0.4,
      status: "complete",
    };
  }

  // Truly empty → failure packet with escalation
  return {
    ...base,
    facts: [],
    inferences: [],
    unknowns: ["L1 agent 返回了空响应"],
    confidence: 0,
    status: "partial",
    escalation: {
      required: true,
      reasonCodes: ["UNRESOLVED_QUESTIONS"],
      scope: { documentId },
      question,
      knownFacts: [],
      unresolvedQuestions: ["L1 agent 返回了空响应"],
      estimatedInputTokens: Math.ceil(documentText.length / 3.5),
    },
  };
}

export interface L1AgentResult {
  packet: EvidencePacket;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  raw: string;
}

/**
 * Reduced retry prompt: only the minimum required fields, no long prose.
 * Used on the SECOND L1 attempt so a re-run differs from the collapsed one
 * (same input + same strategy tends to re-collapse).
 */
const L1_REDUCED_PROMPT = `你是标准档文档分析 agent（精简模式）。基于提供的文档段落回答用户问题。
只完成最低必要字段：
- facts: [{"claim": "简短标签", "value": "精确值", "evidence": "来源", "confidence": 0-1, "kind": "cited|inferred"}]
- unknowns: ["无法确定的内容"]
禁止长篇解释。输出严格 JSON（无 markdown 围栏）：
{ "facts": [...], "inferences": [], "unknowns": [...], "confidence": 0-1, "status": "complete|partial|insufficient", "failureReason": "仅当无法完成时填写" }
如果无法完成，不要返回空摘要或泛化总结；必须返回 status="insufficient" 并说明 failureReason。`;

/**
 * L1 standard agent: analyze document text, return packet + optional escalation.
 * `reduced` selects the differentiated retry strategy (minimum fields, low
 * temperature, larger output cap) — a retry must not repeat the original call.
 */
export async function runL1Agent(params: {
  documentId: string;
  documentText: string;
  question: string;
  truncated: boolean;
  /** Second-attempt mode: minimum fields only, temperature 0.1, max_tokens 3000 */
  reduced?: boolean;
}): Promise<L1AgentResult> {
  const { content, promptTokens, completionTokens, durationMs } = await callLlm(
    [
      { role: "system", content: params.reduced ? L1_REDUCED_PROMPT : L1_PROMPT },
      {
        role: "user",
        content: `--- 文档（${params.documentId}）段落（truncated=${params.truncated}）---\n${params.documentText}\n\n--- 用户问题 ---\n${params.question}`,
      },
    ],
    L1_MODEL,
    params.reduced ? 3000 : 2500,
    params.reduced ? 0.1 : undefined,
  );

  const packet = normalizeL1Packet(content, params.documentId, params.truncated, params.question, params.documentText);

  return { packet, promptTokens, completionTokens, durationMs, raw: content };
}

export interface L2AgentResult {
  packet: EvidencePacket;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  raw: string;
}

/**
 * L2 expert agent: analyze ONLY the escalated scope.
 */
export async function runL2Agent(params: {
  documentId: string;
  /** Narrow slice of the document the expert should look at */
  scopeText: string;
  question: string;
  knownFacts: string[];
}): Promise<L2AgentResult> {
  const { content, promptTokens, completionTokens, durationMs } = await callLlm(
    [
      { role: "system", content: L2_PROMPT },
      {
        role: "user",
        content: `--- 专家分析范围（${params.documentId} 局部）---\n${params.scopeText}\n\n--- 已确认事实（来自普通 agent）---\n${params.knownFacts.length ? params.knownFacts.join("\n") : "(无)"}\n\n--- 升级问题 ---\n${params.question}`,
      },
    ],
    L2_MODEL,
    3000,
  );

  let packet: EvidencePacket;
  try {
    packet = extractJson<EvidencePacket>(content);
  } catch {
    packet = {
      producer: { agent: "document-expert", tier: "expert", model: L2_MODEL },
      scope: { documentId: params.documentId },
      facts: [],
      inferences: [],
      unknowns: ["L2 agent 返回了非 JSON 响应"],
      confidence: 0,
      status: "partial",
    };
  }

  packet.producer = { agent: "document-expert", tier: "expert", model: L2_MODEL };
  packet.scope = { ...packet.scope, documentId: params.documentId };

  return { packet, promptTokens, completionTokens, durationMs, raw: content };
}
