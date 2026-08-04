/**
 * Requirement analyzer — turns a raw business request into a structured
 * BusinessRequirementCard plus ambiguity/questions/assumptions.
 *
 * Pure deterministic core: no advisor LLM calls here (advisor is injected
 * as an optional interface); no tool names; no business data.
 */
import { createHash } from "node:crypto";
import type {
  Ambiguity,
  Assumption,
  BusinessRequirementCard,
  ClarificationAnswer,
  ClarificationQuestion,
  Metric,
  TimeRange,
} from "./contracts.ts";
import type { DomainPack } from "./domain-packs/contracts.ts";
import { detectAmbiguities, answeredFields } from "./ambiguity.ts";
import { assumptionsFromAnswers, mergeAssumptions } from "./assumptions.ts";

export interface AnalyzeInput {
  rawRequest: string;
  domainHint?: string;
  answers?: ClarificationAnswer[];
  domainPack: DomainPack;
  domainPackAdopted: boolean;
}

export interface AnalyzeOutput {
  card: BusinessRequirementCard;
  ambiguities: Ambiguity[];
  blockingAmbiguities: Ambiguity[];
  questions: ClarificationQuestion[];
  assumptions: Assumption[];
  domainPack: DomainPack;
}

let requestSeq = 0;

export function newRequestId(raw: string): string {
  requestSeq += 1;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `req_${hash}_${requestSeq}`;
}

/** Simple deterministic summary: first 120 chars, single line. */
export function summarizeRequest(raw: string): string {
  const single = raw.replace(/\s+/g, " ").trim();
  return single.length <= 120 ? single : `${single.slice(0, 120)}…`;
}

const EXPLICIT_FIELD_PATTERNS: Array<[string, RegExp]> = [
  ["subject", /个人贷款|企业贷款|信用卡|loan|credit|portfolio|客户|用户/i],
  ["dataset", /[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+/i],
  ["metrics", /通过率|逾期率|坏账率|AUC|KS|PSI|申请量|放款额|revenue|收入|利润|转化率/i],
  ["timeRange", /\d+\s*(天|日|周|月|年)|最近\s*\d+|近\s*\d+|last\s*\d+\s*(day|week|month|year)|7\s*days|30\s*days/i],
  ["comparisonBaseline", /对比|比较|环比|同比|vs\.?|compared/i],
  ["model", /模型|model|score|评分/i],
];

/** Direct query pattern: explicit "查询…" with a concrete target. */
const DIRECT_QUERY_PATTERN = /^(查询|查一下|查|看看|统计|汇总|select|query|算一下|计算)[\s:：.]?.*(AUC|KS|PSI|指标|数据|表|dataset|model|销售|销量|收入|申请量|放款额|记录数|总额|平均|逾期率|通过率|毛利|转化率|活跃|留存|数仓)/i;

/** Detect which fields the user already stated in the raw request. */
export function explicitFieldsFromRequest(raw: string): Set<string> {
  const out = new Set<string>();
  for (const [field, pattern] of EXPLICIT_FIELD_PATTERNS) {
    if (pattern.test(raw)) out.add(field);
  }
  // A direct query names the subject/dataset explicitly — subject is known.
  if (DIRECT_QUERY_PATTERN.test(raw)) {
    out.add("subject");
    out.add("businessObjective");
  }
  return out;
}

/** Deterministic extraction of structured requirement fields from the raw
 *  request: constraints (不得/必须/只读/禁止…), output requirements (表格/
 *  柱状图/折线图/正式报告…), success criteria (Top N 降序/不排除/必须一致…)
 *  and dimensions (按月/按国家/按渠道…). Never inferred — only what the
 *  request states. */
export interface StructuredRequestFields {
  dimensions: string[];
  outputRequirements: string[];
  constraints: string[];
  successCriteria: string[];
}

const STRUCTURED_FIELD_RULES: Array<{
  field: keyof StructuredRequestFields;
  patterns: RegExp[];
}> = [
  {
    field: "constraints",
    patterns: [
      /(?:不得|不能|不允许|禁止|必须|只读|请勿|不要|固定)[^，。；,;\n]{1,40}/g,
    ],
  },
  {
    field: "outputRequirements",
    patterns: [
      /(?:输出|展示|呈现|给出|做成)?(表格|柱状图|折线图|饼图|散点图|正式报告|报告|PPT|markdown|json|csv)/gi,
    ],
  },
  {
    field: "successCriteria",
    patterns: [
      /(?:Top\s*\d+|前\s*\d+)[^，。；,;\n]{0,24}(?:降序|升序|排序)/gi,
      /(?:不得|不能|不允许)[^，。；,;\n]{1,32}(?:排除|遗漏|跳过)/gi,
      /(?:保持|确保|必须)[^，。；,;\n]{1,32}(?:一致|正确|完整|可复现)/gi,
    ],
  },
  {
    field: "dimensions",
    patterns: [
      /(?:按|依据|根据|分)(?:月份?|季度|周|日|年|国家|地区|城市|产品|渠道|客户|类型|行业|部门|区域|性别|年龄)[^，。；,;\n]{0,12}/g,
    ],
  },
];

export function structuredFieldsFromRequest(raw: string): StructuredRequestFields {
  const out: StructuredRequestFields = {
    dimensions: [], outputRequirements: [], constraints: [], successCriteria: [],
  };
  for (const rule of STRUCTURED_FIELD_RULES) {
    const seen = new Set<string>();
    for (const pattern of rule.patterns) {
      for (const match of raw.matchAll(pattern)) {
        const value = match[0].trim();
        if (value.length >= 2 && !seen.has(value)) {
          seen.add(value);
          out[rule.field].push(value);
        }
      }
    }
  }
  return out;
}

/** Infer a time range from explicit mentions, else null (never fabricate). */
export function timeRangeFromRequest(raw: string): TimeRange | null {
  const m = raw.match(/(最近|近|last)\s*(\d+)\s*(天|日|周|月|年|day|days|week|weeks|month|months|year|years)/i);
  if (!m) return null;
  const n = Number(m[2]);
  const unit = m[3];
  const relative = `recent_${n}_${unit.replace(/s$/i, "").toLowerCase() === "day" ? "days" : unit.replace(/s$/i, "").toLowerCase()}`;
  return { relative, source: "USER" };
}

/**
 * Build a requirement card. Blocking ambiguities that cannot be defaulted
 * leave the card in CLARIFYING and produce questions; non-blocking ones are
 * resolved via explicit assumptions.
 */
export function analyzeRequirement(input: AnalyzeInput): AnalyzeOutput {
  const raw = input.rawRequest.trim();
  const answered = answeredFields(input.answers);
  const explicit = explicitFieldsFromRequest(raw);

  // Merge explicit + answered into "known" so detection never re-asks.
  const knownFields = new Set([...answered, ...explicit]);

  const detected = detectAmbiguities({
    rawRequest: raw,
    domainHint: input.domainHint,
    answeredFields: answered,
    explicitFields: explicit,
    domainPack: input.domainPack,
  });

  // User answers become USER assumptions; defaults become DOMAIN/SYSTEM.
  const userAssumptions = assumptionsFromAnswers(input.answers);
  const assumptions = mergeAssumptions(userAssumptions, detected.assumptions);

  const timeRange = timeRangeFromRequest(raw) ??
    assumptions.find((a) => a.field === "timeRange")?.value ??
    null;

  const metrics = metricsFromRequest(raw, input.domainPack, assumptions);
  const structured = structuredFieldsFromRequest(raw);

  const card: BusinessRequirementCard = {
    requestId: `req_${createHash("sha1").update(raw).digest("hex").slice(0, 8)}`,
    rawRequestSummary: summarizeRequest(raw),
    domain: input.domainPack.domainName,
    businessObjective: explicit.has("businessObjective") ? raw : "",
    decisionToSupport: "",
    subject: explicit.has("subject") ? raw.match(EXPLICIT_FIELD_PATTERNS[0][1])?.[0] ?? "" : "",
    scope: "",
    timeRange: timeRange
      ? typeof timeRange === "string"
        ? { relative: timeRange, source: "DOMAIN_DEFAULT" }
        : timeRange
      : { source: "UNKNOWN" },
    metrics,
    dimensions: structured.dimensions,
    comparisonBaselines:
      assumptions.find((a) => a.field === "comparisonBaseline")?.value
        ? [assumptions.find((a) => a.field === "comparisonBaseline")!.value]
        : [],
    successCriteria: structured.successCriteria,
    outputRequirements: structured.outputRequirements,
    constraints: structured.constraints,
    assumptions,
    ambiguities: detected.ambiguities,
    confidence: confidenceFor(detected.blocking, metrics),
    status: detected.blocking.length > 0 ? "CLARIFYING" : "READY",
  };

  return {
    card,
    ambiguities: detected.ambiguities,
    blockingAmbiguities: detected.blocking,
    questions: detected.questions,
    assumptions,
    domainPack: input.domainPack,
  };
}

function metricsFromRequest(raw: string, pack: DomainPack, assumptions: Assumption[]): Metric[] {
  const out: Metric[] = [];
  const packMetrics = new Map(pack.metrics.map((m) => [m.name, m]));
  const added = new Set<string>();
  for (const m of pack.metrics) {
    if (raw.includes(m.name)) {
      out.push({ name: m.name, definition: m.definition, source: "USER", confirmed: true });
      added.add(m.name);
    }
  }
  // domain defaults: metrics the user explicitly chose via answers
  const metricAnswer = assumptions.find((a) => a.field === "metrics");
  if (metricAnswer) {
    for (const name of metricAnswer.value.split(",").map((s) => s.trim())) {
      const def = packMetrics.get(name);
      if (def && !added.has(name)) {
        out.push({ name, definition: def.definition, source: "DOMAIN_PACK", confirmed: true });
        added.add(name);
      }
    }
  }
  return out;
}

/** Confidence: penalized by blocking ambiguities; boosted by confirmed metrics. */
function confidenceFor(blocking: Ambiguity[], metrics: Metric[]): number {
  let c = 0.5;
  c -= blocking.length * 0.15;
  c += Math.min(metrics.filter((m) => m.confirmed).length, 3) * 0.1;
  return Math.max(0.1, Math.min(0.95, c));
}
