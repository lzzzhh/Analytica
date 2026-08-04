/**
 * multimodal-artifact-poc extension for Pi.
 *
 * Tools:
 *   parse_image    — OCR an image via PaddleOCR (default) or Tesseract
 *   parse_document — Convert a document (PDF/DOCX/PPTX/MD/etc.) to Markdown via markitdown
 *
 * The raw image/document content is never sent to the LLM;
 * only structured text results are.
 *
 * Registration is feature-driven (round1.* features): disabled tools never
 * reach the agent tool registry. Heavy optional components are loaded via
 * dynamic import so a disabled feature does not load its dependencies.
 */

import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "../../../src/core/extensions/types.ts";
import { parseFile } from "./src/image-parser.ts";
import type { ParseResult } from "./src/schemas.ts";
import { storeArtifact } from "./src/artifact-store.ts";
import type { VisualParseResult } from "./src/visual-parser.ts";
import type { OrchestratedResult } from "./src/orchestrator.ts";
import type { FeatureId, FeatureResolver } from "./src/features/types.ts";
import { getDefaultFeatureResolver } from "./src/features/resolver.ts";
import { featureSummaryLine } from "./src/features/snapshot.ts";
import { DATA_TOOLS, DATA_TOOL_FEATURES } from "./src/data-tools/tools.ts";
import { REVIEW_DATA_ANALYSIS_TOOL } from "./src/reviewer/adapters/review-data-analysis-tool.ts";
import {
  PIPELINE_INGEST_TOOL,
  PROMOTE_ANALYSIS_TOOL,
  WRITE_GATE_CHECK_TOOL,
} from "./src/pipelines/delivery-tools.ts";
import { INSPECT_GRAPH_RUN_TOOL, RUN_ANALYSIS_GRAPH_TOOL } from "./src/graph-engine/tool.ts";
import { setGraphToolHost, type GraphToolConfig } from "./src/graph-engine/tool-runner.ts";
import { graphCapabilityMap } from "./src/graph-engine/capability-registry.ts";
import { dataAnalysisAdapter } from "./src/graph-engine/adapters/data-analysis.ts";
import { preflightGovernanceAdapter, fanInAdapter, resolveEvidenceFromStore } from "./src/graph-engine/adapters/production.ts";
import { reviewGateAdapter, reviewerAdapter, promotionAdapter } from "./src/graph-engine/adapters/reviewer.ts";
import { analysisReportSkillAdapter, deliverableVerifierAdapter } from "./src/graph-engine/adapters/report.ts";
import { createDataAnalysisSubagentCaller } from "./src/data-analysis/subagent.ts";
import { ArtifactStore } from "./src/data-analysis/artifact-store.ts";
import { GraphEventStore } from "./src/graph-engine/event-store.ts";
import { buildPrepareBusinessTaskTool } from "./src/requirement-planning/tool.ts";
import { createPiAdvisorCaller } from "./src/requirement-planning/adapters/pi-planning-advisor.ts";
import { buildDataAnalysisTool } from "./src/data-analysis/tool.ts";
import { buildGovernanceStatusTool } from "./src/governance/tool.ts";

// ---- Path resolution ----

function getScriptPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, "src", "parser_server.py");
}

// ---- Helper ----

function formatResultForModel(result: ParseResult, modeName: string): string[] {
  const lines: string[] = [];

  if (result.sourceType === "image") {
    lines.push(`Parsed image: ${result.width}x${result.height}, ${result.mimeType}`);
    lines.push(`Engine: ${result.parser.name} ${result.parser.version}`);
    lines.push(`Text blocks: ${result.textBlocks.length}`);
  } else {
    lines.push(`Parsed document: ${result.mimeType}`);
    lines.push(`Engine: ${result.parser.name} ${result.parser.version}`);
    lines.push(`Blocks: ${result.textBlocks.length}, ${result.fullText.length} chars`);
  }

  lines.push(`Full text: "${result.fullText.slice(0, 500)}${result.fullText.length > 500 ? "..." : ""}"`);

  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.join("; ")}`);
  }

  // Add detailed text blocks for confidence analysis
  if (result.textBlocks.length > 0 && result.sourceType === "image") {
    const detailLines = result.textBlocks.map(
      (b) => `  "${b.text.slice(0, 80)}${b.text.length > 80 ? "..." : ""}" (conf: ${b.confidence})`,
    );
    lines.push(`\n--- Detailed text blocks (${modeName}) ---\n${detailLines.join("\n")}`);
  }

  return lines;
}

// ============================================================
// Tool 1: parse_image (OCR)
// ============================================================

const parseImageSchema = Type.Object({
  path: Type.String({
    description: "Path to the image file (PNG, JPG, BMP, TIFF, WEBP). Absolute or project-relative.",
  }),
});

type ParseImageParams = Static<typeof parseImageSchema>;

const PARSE_IMAGE_TOOL: ToolDefinition<typeof parseImageSchema, ParseResult> = {
  name: "parse_image",
  label: "Parse Image (OCR)",
  description:
    "Extract text from an image using PaddleOCR (local). " +
    "Returns structured JSON with text blocks, positions, and confidence scores. " +
    "Note: first call takes ~8s (model loading), subsequent calls are faster. " +
    "Use this when the current model cannot view images directly.",
  promptSnippet: "parse_image(path) — run local PaddleOCR on an image (~8s cold start)",
  promptGuidelines: [
    "When analyzing images, call parse_image first. Do not claim to have seen the image.",
    "Only reason from the structured text returned by parse_image.",
    "If OCR confidence is low (< 0.5), clearly state the limitation.",
    "Do not guess numbers, labels, or graphics not in the OCR output.",
    "Note: parse_image has an ~8 second cold start for the first call in a session.",
  ],
  parameters: parseImageSchema,

  async execute(
    _toolCallId: string,
    params: ParseImageParams,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<ParseResult> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<ParseResult>> {
    const scriptPath = getScriptPath();
    const cwd = ctx.cwd;
    try {
      const result = await parseFile({ path: params.path, mode: "ocr" }, cwd, scriptPath, signal);
      storeArtifact(result);
      const textualSummary = formatResultForModel(result, "paddleocr");
      return { content: textualSummary.map((t) => ({ type: "text" as const, text: t })), details: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `parse_image failed: ${message}` }],
        details: {
          artifactId: "", sourceType: "image", mimeType: "unknown",
          width: 0, height: 0, parser: { name: "none", version: "0" },
          textBlocks: [], fullText: "", warnings: [], error: message,
        },
      };
    }
  },
};

// ============================================================
// Tool 2: parse_visual (PaddleOCR-VL)
// ============================================================

const parseVisualSchema = Type.Object({
  path: Type.String({
    description: "Path to the image file (PNG, JPG, BMP, WEBP). Absolute or project-relative.",
  }),
  intent: Type.Optional(
    Type.String({
      description: "Optional focus: what to look for (e.g. 'trend of the line chart', 'pie slice sizes').",
    }),
  ),
});

type ParseVisualParams = Static<typeof parseVisualSchema>;

const PARSE_VISUAL_TOOL: ToolDefinition<typeof parseVisualSchema, VisualParseResult> = {
  name: "parse_visual",
  label: "Parse Visual (Vision Model)",
  description:
    "Analyze an image with a local vision model (PaddleOCR-VL). " +
    "For charts (bar/line/pie), diagrams, photos, and complex layouts. " +
    "Returns structured JSON with facts (exact readable values), inferences (trends/qualitative), " +
    "and unverifiedClaims (estimated/uncertain — treat as NOT reliable). " +
    "Slower than parse_image (~12-35s) — prefer parse_image for plain text extraction.",
  promptSnippet: "parse_visual(path, intent?) — vision-model analysis for charts/photos/complex images",
  promptGuidelines: [
    "For charts, diagrams, photos, and complex visuals, call parse_visual.",
    "facts = exact values the vision model could read; trust them like OCR.",
    "inferences = qualitative trends/relationships; use for narrative but never invent numbers.",
    "unverifiedClaims = uncertain/estimated; do NOT present these as facts.",
    "Do not claim to have seen the image — always route through parse_visual.",
  ],
  parameters: parseVisualSchema,

  async execute(
    _toolCallId: string,
    params: ParseVisualParams,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<VisualParseResult> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<VisualParseResult>> {
    const cwd = ctx.cwd;

    try {
      const { parseVisual } = await import("./src/visual-parser.ts");
      const result = await parseVisual(
        { path: params.path, intent: params.intent },
        cwd,
        signal,
      );

      if (result.error) {
        return {
          content: [{ type: "text", text: `parse_visual failed: ${result.error}` }],
          details: result,
        };
      }

      storeArtifact(result as unknown as ParseResult);

      const lines: string[] = [
        `Parsed image: ${result.width}x${result.height}, ${result.mimeType}`,
        `Engine: ${result.parser.name} ${result.parser.version}`,
        `Chart type: ${result.chartType ?? "unknown"}`,
      ];

      if (result.facts.length > 0) {
        lines.push(`\n--- Facts (exact readable values) ---`);
        for (const f of result.facts) {
          lines.push(`  ${f.name}: ${f.value}${f.confidence !== null ? ` (conf: ${f.confidence})` : ""}`);
        }
      }

      if (result.inferences.length > 0) {
        lines.push(`\n--- Inferences (qualitative) ---`);
        for (const inf of result.inferences) lines.push(`  - ${inf.claim}`);
      }

      if (result.unverifiedClaims.length > 0) {
        lines.push(`\n--- Unverified claims (DO NOT treat as fact) ---`);
        for (const u of result.unverifiedClaims) lines.push(`  ! ${u.claim}`);
      }

      lines.push(`\n--- Description ---\n${result.rawDescription}`);

      if (result.warnings.length > 0) lines.push(`\nWarnings: ${result.warnings.join("; ")}`);

      return { content: lines.map((l) => ({ type: "text" as const, text: l })), details: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `parse_visual failed: ${message}` }],
        details: {
          artifactId: "", sourceType: "image", mimeType: "unknown", width: 0, height: 0,
          parser: { name: "paddleocr-vl", version: "1.6" }, chartType: null,
          facts: [], inferences: [], unverifiedClaims: [], rawDescription: "", warnings: [],
          error: message,
        },
      };
    }
  },
};

// ============================================================
// Tool 3: analyze_document (sub-agent)
// ============================================================

import { getOrCreateDocument } from "./src/doc-artifact-store.ts";
import { getMimeTypeOf, resolveDocumentPath } from "./src/doc-utils.ts";

const analyzeDocumentSchema = Type.Object({
  path: Type.String({
    description: "Path to the document file (PDF, DOCX, PPTX, XLSX, HTML, CSV, MD, TXT).",
  }),
  question: Type.String({
    description: "What the user wants to know about the document.",
  }),
});

type AnalyzeDocumentParams = Static<typeof analyzeDocumentSchema>;

interface AnalyzeDocumentDetails {
  artifactId: string;
  cached: boolean;
  markdownLength: number;
  subagentTokens: number;
  durationMs: number;
  answer: string;
  error?: string;
}

const ANALYZE_DOCUMENT_TOOL: ToolDefinition<typeof analyzeDocumentSchema, AnalyzeDocumentDetails> = {
  name: "analyze_document",
  label: "Analyze Document (Sub-agent)",
  description:
    "Analyze a document in an isolated sub-agent. The document is parsed locally (markitdown), " +
    "persisted to disk, and a separate agent with its own context answers the question about it. " +
    "Only the answer is returned here — the document body never enters the main context. " +
    "Best for long documents. For small/quick text extraction prefer parse_document.",
  promptSnippet: "analyze_document(path, question) — answer a question about a document via an isolated sub-agent",
  promptGuidelines: [
    "For questions about long documents, use analyze_document instead of parse_document.",
    "The answer returned is the sub-agent's final response — quote it faithfully.",
    "If the sub-agent reports the information is missing from the document, say so rather than guessing.",
  ],
  parameters: analyzeDocumentSchema,

  async execute(
    _toolCallId: string,
    params: AnalyzeDocumentParams,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<AnalyzeDocumentDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<AnalyzeDocumentDetails>> {
    const cwd = ctx.cwd;

    try {
      // 1. Resolve + parse the document (markitdown), persisted with caching
      const resolved = resolveDocumentPath(params.path, cwd);
      const mimeType = getMimeTypeOf(resolved);
      const stored = await getOrCreateDocument(resolved, mimeType, async () => {
        const scriptPath = getScriptPath();
        const result = await parseFile({ path: resolved, mode: "document" }, cwd, scriptPath, signal);
        return result.fullText;
      });

      if (!stored.markdown.trim()) {
        return {
          content: [{ type: "text", text: `analyze_document: 文档解析结果为空（${resolved}）` }],
          details: {
            artifactId: stored.artifactId, cached: stored.cached, markdownLength: 0,
            subagentTokens: 0, durationMs: 0, answer: "", error: "Empty document content",
          },
        };
      }

      // 2. Run the sub-agent with the persisted markdown
      const { runDocumentSubagent } = await import("./src/subagent.ts");
      const result = await runDocumentSubagent({
        markdownPath: `${stored.dir}/raw.md`,
        artifactId: stored.artifactId,
        question: params.question,
      });

      if (result.error) {
        return {
          content: [{ type: "text", text: `analyze_document 子代理失败: ${result.error}` }],
          details: {
            artifactId: stored.artifactId, cached: stored.cached,
            markdownLength: stored.markdown.length, subagentTokens: result.subagentTokens,
            durationMs: result.durationMs, answer: "", error: result.error,
          },
        };
      }

      return {
        content: [
          { type: "text", text: `文档（${stored.artifactId}）已由子代理分析完毕（${result.durationMs}ms, ${result.subagentTokens} tokens）：\n\n${result.answer}` },
        ],
        details: {
          artifactId: stored.artifactId, cached: stored.cached,
          markdownLength: stored.markdown.length, subagentTokens: result.subagentTokens,
          durationMs: result.durationMs, answer: result.answer,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `analyze_document failed: ${message}` }],
        details: {
          artifactId: "", cached: false, markdownLength: 0, subagentTokens: 0, durationMs: 0,
          answer: "", error: message,
        },
      };
    }
  },
};

// ============================================================
// Tool 4: analyze_document_v2 (two-tier orchestrator)
// ============================================================

const analyzeDocV2Schema = Type.Object({
  path: Type.String({
    description: "Path to the document file (PDF, DOCX, PPTX, XLSX, HTML, CSV, MD, TXT).",
  }),
  question: Type.String({
    description: "What the user wants to know about the document.",
  }),
});

type AnalyzeDocV2Params = Static<typeof analyzeDocV2Schema>;

const ANALYZE_DOCUMENT_V2_TOOL: ToolDefinition<typeof analyzeDocV2Schema, OrchestratedResult> = {
  name: "analyze_document_v2",
  label: "Analyze Document V2 (Two-tier Agents)",
  description:
    "Analyze a document with a two-tier agent pipeline: a standard agent (flash) handles the document, " +
    "escalates to an expert agent (pro) only for the flagged scope, and results are merged deterministically. " +
    "Returns merged evidence (facts/inferences/unknowns/conflicts). Use for long or complex documents.",
  promptSnippet: "analyze_document_v2(path, question) — two-tier document analysis with escalation",
  promptGuidelines: [
    "For complex/long documents use analyze_document_v2 — it routes and escalates automatically.",
    "merged.facts are verified values; merged.conflicts need verification — present both sides.",
    "merged.unknowns are things the agents could not determine — say so rather than guessing.",
  ],
  parameters: analyzeDocV2Schema,

  async execute(
    _toolCallId: string,
    params: AnalyzeDocV2Params,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<OrchestratedResult> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<OrchestratedResult>> {
    const cwd = ctx.cwd;

    try {
      const resolved = resolveDocumentPath(params.path, cwd);
      const scriptPath = getScriptPath();
      const parsed = await parseFile({ path: resolved, mode: "document" }, cwd, scriptPath, signal);
      if (!parsed.fullText.trim()) {
        throw new Error("文档解析结果为空");
      }

      const result = await (await import("./src/orchestrator.ts"))
        .orchestrateDocumentAnalysis({
          // content hash, not length: two different documents with the same
          // length must not share a document id (review #15)
          documentId: `doc_${createHash("sha256").update(parsed.fullText).digest("hex").slice(0, 16)}`,
          documentText: parsed.fullText,
          question: params.question,
        });

      if (result.error) {
        return {
          content: [{ type: "text", text: `analyze_document_v2 失败: ${result.error}` }],
          details: result,
        };
      }

      const lines: string[] = [
        `文档分析完成（${result.durationMs}ms）`,
        `路由: ${result.route.route} (风险分 ${result.route.riskScore})`,
        `升级: ${result.escalation ? "是" : "否"}${result.escalation && result.expertPacket ? "（专家已处理局部 scope）" : ""}`,
        `预估 tokens: ${result.route.estimatedTokens}, 章节: ${result.route.chapterCount}, 表格行: ${result.route.tableCount}`,
      ];

      if (result.merged.facts.length > 0) {
        lines.push(`\n--- Facts（已核实）---`);
        for (const f of result.merged.facts) {
          lines.push(`  ${f.claim}: ${f.value}${f.evidence ? ` [${f.evidence}]` : ""} (${f.kind}, conf=${f.confidence})`);
        }
      }

      if (result.merged.inferences.length > 0) {
        lines.push(`\n--- Inferences（推断）---`);
        for (const i of result.merged.inferences) lines.push(`  - ${i.claim} (conf=${i.confidence})`);
      }

      if (result.merged.conflicts.length > 0) {
        lines.push(`\n--- Conflicts（需人工核验）---`);
        for (const c of result.merged.conflicts) {
          lines.push(`  ! ${c.claim}: ${c.candidates.map((x) => `${x.value}(${x.producer})`).join(" vs ")}`);
        }
      }

      if (result.merged.unknowns.length > 0) {
        lines.push(`\n--- Unknowns（无法确定）---`);
        for (const u of result.merged.unknowns) lines.push(`  ? ${u}`);
      }

      return { content: lines.map((l) => ({ type: "text" as const, text: l })), details: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `analyze_document_v2 failed: ${message}` }],
        details: {
          documentId: "", route: { route: "standard", riskScore: 0, estimatedTokens: 0, chapterCount: 0, tableCount: 0, pageCount: 0, reasons: [] },
          merged: { facts: [], inferences: [], unknowns: [], conflicts: [], confidence: 0 },
          escalation: false,
          decision: {
            documentId: "", documentChars: 0, estimatedTokens: 0, shortDocument: false,
            attempt1: { passed: false, qualityScore: 0, gateReason: "orchestrator_error" },
            bestAttempt: "attempt1", selectionReason: "orchestrator_error",
            expertTriggered: false, expertUsed: false,
          },
          durationMs: 0, tokens: { l1: 0, l2: 0 }, error: message,
        },
      };
    }
  },
};

// ============================================================
// Tool 5: parse_document (markitdown)
// ============================================================

const parseDocumentSchema = Type.Object({
  path: Type.String({
    description: "Path to the document file. Supports PDF, DOCX, PPTX, XLSX, HTML, CSV, MD, TXT.",
  }),
});

type ParseDocumentParams = Static<typeof parseDocumentSchema>;

const PARSE_DOCUMENT_TOOL: ToolDefinition<typeof parseDocumentSchema, ParseResult> = {
  name: "parse_document",
  label: "Parse Document (markitdown)",
  description:
    "Convert a document (PDF, DOCX, PPTX, XLSX, HTML, CSV, MD, TXT) to Markdown text using markitdown. " +
    "Returns structured JSON with the full text content.",
  promptSnippet: "parse_document(path) — convert a document to Markdown text",
  promptGuidelines: [
    "When analyzing documents, call parse_document to extract text content.",
    "Only reason from the extracted text, not from assumptions about the document.",
  ],
  parameters: parseDocumentSchema,

  async execute(
    _toolCallId: string,
    params: ParseDocumentParams,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<ParseResult> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<ParseResult>> {
    const scriptPath = getScriptPath();
    const cwd = ctx.cwd;

    try {
      const result = await parseFile({ path: params.path, mode: "document" }, cwd, scriptPath, signal);
      storeArtifact(result);
      const textualSummary = formatResultForModel(result, "document");
      return { content: textualSummary.map((t) => ({ type: "text" as const, text: t })), details: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `parse_document failed: ${message}` }],
        details: {
          artifactId: "", sourceType: "document", mimeType: "unknown",
          width: 0, height: 0, parser: { name: "none", version: "0" },
          textBlocks: [], fullText: "", warnings: [], error: message,
        },
      };
    }
  },
};

// ============================================================
// Extension entry point (feature-driven registration)
// ============================================================

/** Tool → round1 feature mapping (the only place deciding which feature
 *  gates which round-1 tool). Disabled tools never reach the registry. */
/** Reviewer tools — feature-gated under round5.review_tools (parent
 *  round5.reviewer). Disabled tools never reach the registry. */
const REVIEW_TOOL_FEATURES: Array<[ToolDefinition<any, any, any>, FeatureId]> = [
  // inspect_review_gate stays registered via DATA_TOOL_FEATURES
  // (round5.deterministic_review_gates) — never duplicate registration
  [REVIEW_DATA_ANALYSIS_TOOL, "round5.review_tools"],
  [PROMOTE_ANALYSIS_TOOL, "round5.review_tools"],
];

/** Delivery-chain tools — governed pipeline write + write-gate query. */
const DELIVERY_TOOL_FEATURES: Array<[ToolDefinition<any, any, any>, FeatureId]> = [
  [PIPELINE_INGEST_TOOL, "round2.pipeline"],
  [WRITE_GATE_CHECK_TOOL, "round2.pipeline_governance"],
];

/** Graph Engine tools — feature-gated round6.graph_tool. */
const GRAPH_TOOL_FEATURES: Array<[ToolDefinition<any, any, any>, FeatureId]> = [
  [RUN_ANALYSIS_GRAPH_TOOL, "round6.graph_tool"],
  [INSPECT_GRAPH_RUN_TOOL, "round6.graph_tool"],
];

const ROUND1_TOOL_FEATURES: Array<[ToolDefinition<any, any, any>, FeatureId]> = [
  [PARSE_IMAGE_TOOL, "round1.image_ocr"],
  [PARSE_VISUAL_TOOL, "round1.visual_parser"],
  [PARSE_DOCUMENT_TOOL, "round1.document_parser"],
  [ANALYZE_DOCUMENT_TOOL, "round1.document_subagent"],
  [ANALYZE_DOCUMENT_V2_TOOL, "round1.document_orchestrator_v2"],
];

/**
 * Register everything according to the effective feature set. Exported for
 * tests: build a resolver with any configuration and assert the resulting
 * registry. The default export uses the process-wide resolver (startup env).
 */
/** Build the PRODUCTION graph host (real adapters) when graph_tool is on. */
/**
 * P0-5: a human-approval authorization may ONLY trust a VERIFIED event
 * chain: integrity scan (hash chain / sequence / genesis / terminal
 * immutability) first — any damage refuses the authorization.
 */
async function readVerifiedEventChain(
  runId: string,
  store?: import("./src/graph-engine/event-store.ts").GraphEventStore,
): Promise<Array<{
  eventType: string;
  nodeId?: string;
  refs: Array<import("./src/graph-engine/contracts.ts").ArtifactRef>;
  meta: Record<string, string>;
  errorCode?: string;
}>> {
  const events = store ?? new GraphEventStore(process.env.GRAPH_STORE_ROOT ?? `${process.env.HOME ?? ""}/.pi/artifacts/graph-engine`);
  const issues = events.scan(runId);
  if (issues.length > 0) {
    throw new Error(`EVENT_CHAIN_DAMAGED: refusing human-approval authorization (${issues.slice(0, 3).join("; ")})`);
  }
  return events.allEvents(runId);
}

/** The REAL host graph config from a REAL feature snapshot. Testable: the
 *  executor recomputes the effective hash from enabled+disabled sets, so a
 *  config missing disabledFeatures would fail every real run. */
export function buildGraphToolConfig(
  snapshot: {
    effectiveFeatureHash: string;
    effectiveFeatures: string[];
    disabledFeatures: string[];
  },
  artifactStore: ArtifactStore,
  storeRoot: string,
): GraphToolConfig {
  return {
    storeRoot,
    featureSnapshotHash: snapshot.effectiveFeatureHash,
    effectiveFeatures: snapshot.effectiveFeatures,
    disabledFeatures: snapshot.disabledFeatures,
    artifactResolver: async (artifactId: string) => {
      const rec = await artifactStore.resolveArtifact(artifactId);
      if (!rec) return null;
      const meta = rec.meta as { contentHash?: unknown };
      const contentHash = typeof meta.contentHash === "string" && /^[a-f0-9]{64}$/.test(meta.contentHash)
        ? meta.contentHash
        : null;
      if (!contentHash) return null; // unverifiable -> refuse
      return {
        artifactId,
        artifactType: "dataset",
        contentHash,
        schemaVersion: "1.0",
        createdByNodeId: "materialize",
      };
    },
  };
}

async function wireGraphToolHost(features: FeatureResolver): Promise<void> {
  const snapshot = features.getEffectiveFeatureSnapshot();
  const storeRoot = process.env.REVIEWER_STORE_ROOT ?? `${process.env.HOME ?? ""}/.pi/artifacts/reviewer-store`;
  const artifactStore = new ArtifactStore();
  // ONE event store instance: the executor, the promotion human-approval
  // verification, and inspect all read the SAME chain (never re-derived
  // paths — a second store at a different root would see an empty chain)
  const eventStore = new GraphEventStore(storeRoot);
  const config = buildGraphToolConfig(snapshot, artifactStore, storeRoot);
  config.eventStore = eventStore;
  const resolveEvidence = (artifactId: string) => resolveEvidenceFromStore(artifactId, artifactStore);
  const readVerifiedEventChainBound = (runId: string) => readVerifiedEventChain(runId, eventStore);
  setGraphToolHost({
    adapters: new Map([
      [preflightGovernanceAdapter({ resolveArtifact: async (id) => artifactStore.resolveArtifact(id) as never }).capabilityId,
       preflightGovernanceAdapter({ resolveArtifact: async (id) => artifactStore.resolveArtifact(id) as never })],
      [fanInAdapter().capabilityId, fanInAdapter()],
      [dataAnalysisAdapter({
        store: artifactStore,
        subagent: createDataAnalysisSubagentCaller({ timeoutMs: 300_000 }),
        featureSnapshot: { effectiveFeatures: snapshot.effectiveFeatures },
        readFindings: async (refs) => {
          const { ReviewerStore } = await import("./src/reviewer/store.ts");
          const { readdirSync, readFileSync, existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          const reviewsRoot = join(storeRoot, "reviews");
          const out: Array<{ category: string; claim: string; suggestedAction: string }> = [];
          for (const keyDir of readdirSync(reviewsRoot)) {
            const pointerPath = join(reviewsRoot, keyDir, "terminal-pointer.json");
            if (!existsSync(pointerPath)) continue;
            const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { attemptId?: string };
            const decisionPath = join(reviewsRoot, keyDir, "attempts", pointer.attemptId ?? "", "decision.json");
            if (!existsSync(decisionPath)) continue;
            const d = JSON.parse(readFileSync(decisionPath, "utf8")) as {
              reviewId?: string;
              blockingFindings?: Array<{ category?: string; claim?: string; suggestedAction?: string }>;
            };
            const prefix = `finding:${d.reviewId}:`;
            const matched = refs.filter((r) => r.artifactId.startsWith(prefix));
            if (matched.length === 0) continue;
            for (const f of (d.blockingFindings ?? [])) {
              out.push({ category: f.category ?? "", claim: f.claim ?? "", suggestedAction: f.suggestedAction ?? "" });
            }
          }
          void ReviewerStore;
          return out;
        },
      }).capabilityId, dataAnalysisAdapter({
        store: artifactStore,
        subagent: createDataAnalysisSubagentCaller({ timeoutMs: 300_000 }),
        featureSnapshot: { effectiveFeatures: snapshot.effectiveFeatures },
        readFindings: async (refs) => {
          const { readdirSync, readFileSync, existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          const reviewsRoot = join(storeRoot, "reviews");
          const out: Array<{ category: string; claim: string; suggestedAction: string }> = [];
          for (const keyDir of readdirSync(reviewsRoot)) {
            const pointerPath = join(reviewsRoot, keyDir, "terminal-pointer.json");
            if (!existsSync(pointerPath)) continue;
            const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { attemptId?: string };
            const decisionPath = join(reviewsRoot, keyDir, "attempts", pointer.attemptId ?? "", "decision.json");
            if (!existsSync(decisionPath)) continue;
            const d = JSON.parse(readFileSync(decisionPath, "utf8")) as {
              reviewId?: string;
              blockingFindings?: Array<{ category?: string; claim?: string; suggestedAction?: string }>;
            };
            const prefix = `finding:${d.reviewId}:`;
            const matched = refs.filter((r) => r.artifactId.startsWith(prefix));
            if (matched.length === 0) continue;
            for (const f of (d.blockingFindings ?? [])) {
              out.push({ category: f.category ?? "", claim: f.claim ?? "", suggestedAction: f.suggestedAction ?? "" });
            }
          }
          return out;
        },
      })],
      [reviewGateAdapter({ storeRoot, resolveEvidence, artifactStore }).capabilityId, reviewGateAdapter({ storeRoot, resolveEvidence, artifactStore })],
      [reviewerAdapter({ storeRoot, resolveEvidence, artifactStore }).capabilityId, reviewerAdapter({ storeRoot, resolveEvidence, artifactStore })],
      [promotionAdapter({ storeRoot, readEventChain: readVerifiedEventChainBound }).capabilityId,
       promotionAdapter({ storeRoot, readEventChain: readVerifiedEventChainBound })],
      [analysisReportSkillAdapter().capabilityId, analysisReportSkillAdapter()],
      [deliverableVerifierAdapter().capabilityId, deliverableVerifierAdapter()],
    ]),
    capabilities: graphCapabilityMap(),
    principal: { source: "SYSTEM", actorId: "extension", authenticated: true },
  }, config);
}

export function buildExtensionRegistrations(pi: ExtensionAPI, features: FeatureResolver): void {
  // Feature summary in the startup log (reproducibility; spec §10).
  // eslint-disable-next-line no-console
  console.log(featureSummaryLine(features));

  for (const [tool, featureId] of ROUND1_TOOL_FEATURES) {
    if (features.isEffective(featureId)) {
      pi.registerTool(tool as ToolDefinition<any, any, any>);
    }
  }

  // Lakehouse + CDXR tools (round2.* / round3.cdxr_training) — the tool list
  // is already feature-filtered at module load (src/data-tools/tools.ts);
  // register only the effective subset (never a disabled tool).
  for (const [tool, featureId] of DATA_TOOL_FEATURES) {
    if (features.isEffective(featureId)) {
      pi.registerTool(tool as ToolDefinition<any, any, any>);
    }
  }

  // Reviewer tools (round5.*) — public entry points for governed review
  for (const [tool, featureId] of REVIEW_TOOL_FEATURES) {
    if (features.isEffective(featureId)) {
      pi.registerTool(tool as ToolDefinition<any, any, any>);
    }
  }

  // Delivery-chain tools — governed ingestion + authorization queries
  for (const [tool, featureId] of DELIVERY_TOOL_FEATURES) {
    if (features.isEffective(featureId)) {
      pi.registerTool(tool as ToolDefinition<any, any, any>);
    }
  }

  // Graph Engine tools (round6.*) — off by default; never registered when off.
  // When ON, the PRODUCTION host is wired: real adapters (preflight, fan-in,
  // data analysis with the real subagent, reviewer with real evidence
  // resolution, promotion, report) + host-configured store/snapshot.
  if (features.isEffective("round6.graph_tool")) {
    for (const [tool, featureId] of GRAPH_TOOL_FEATURES) {
      if (features.isEffective(featureId)) {
        pi.registerTool(tool as ToolDefinition<any, any, any>);
      }
    }
    void wireGraphToolHost(features);
  }

  // /image command — deterministic fallback for image OCR
  if (features.isEffective("round1.image_ocr")) {
    pi.registerCommand("image", {
      description: "Parse an image using local OCR (PaddleOCR) and display results",
      handler: async (args, ctx) => {
        const imagePath = args.trim();
        if (!imagePath) {
          ctx.ui.notify("Usage: /image <path-to-image>", "warning");
          return;
        }
        const scriptPath = getScriptPath();
        const cwd = ctx.cwd;
        try {
          const result = await parseFile({ path: imagePath, mode: "ocr" }, cwd, scriptPath);
          storeArtifact(result);
          ctx.ui.notify(
            `Parsed "${imagePath}": ${result.width}x${result.height}, ${result.textBlocks.length} text blocks`,
            "info",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Parse failed: ${message}`, "error");
        }
      },
    });
  }

  // /visual command — deterministic fallback for vision-model analysis
  if (features.isEffective("round1.visual_parser")) {
    pi.registerCommand("visual", {
      description: "Analyze an image with the vision model (PaddleOCR-VL) and display results",
      handler: async (args, ctx) => {
        const [pathArg, ...rest] = args.trim().split(/\s+/u);
        if (!pathArg) {
          ctx.ui.notify("Usage: /visual <path-to-image> [intent]", "warning");
          return;
        }
        const cwd = ctx.cwd;
        try {
          const { parseVisual } = await import("./src/visual-parser.ts");
          const result = await parseVisual(
            { path: pathArg, intent: rest.join(" ") || undefined },
            cwd,
          );
          const factCount = result.facts.length;
          const inferenceCount = result.inferences.length;
          ctx.ui.notify(
            `Analyzed "${pathArg}": chart=${result.chartType ?? "?"}, ${factCount} facts, ${inferenceCount} inferences`,
            "info",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Visual parse failed: ${message}`, "error");
        }
      },
    });
  }

  // /document command — deterministic fallback for document parsing
  if (features.isEffective("round1.document_parser")) {
    pi.registerCommand("document", {
      description: "Parse a document (PDF/DOCX/etc.) via markitdown and display results",
      handler: async (args, ctx) => {
        const docPath = args.trim();
        if (!docPath) {
          ctx.ui.notify("Usage: /document <path-to-document>", "warning");
          return;
        }
        const scriptPath = getScriptPath();
        const cwd = ctx.cwd;
        try {
          const result = await parseFile({ path: docPath, mode: "document" }, cwd, scriptPath);
          storeArtifact(result);
          ctx.ui.notify(
            `Parsed "${docPath}": ${result.mimeType}, ${result.fullText.length} chars`,
            "info",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Parse failed: ${message}`, "error");
        }
      },
    });
  }

  // ------------------------------------------------------------------
  // Round-4: Requirement Planning plugin (default OFF).
  //   - prepare_business_task registered only when
  //     round4.requirement_planning AND round4.task_plan_generation are effective
  //   - native Pi skill registration via resources_discover when
  //     round4.requirement_skill is effective
  //   - advisor caller only built when round4.planning_advisor is effective
  // ------------------------------------------------------------------
  if (features.isEffective("round4.requirement_planning")) {
    if (features.isEffective("round4.task_plan_generation")) {
      const snapshot = features.getEffectiveFeatureSnapshot();
      const advisorEnabled = features.isEffective("round4.planning_advisor");
      const tool = buildPrepareBusinessTaskTool({
        snapshot,
        modelId: process.env.REQUIREMENT_PLANNER_MODEL_ID ??
          process.env.MODEL_ID ?? "default-planner-model",
        enabled: {
          advisor: advisorEnabled,
          clarification: features.isEffective("round4.clarification"),
          planGate: features.isEffective("round4.plan_gate"),
          validation: features.isEffective("round4.plan_validation"),
          parallel: features.isEffective("round4.parallel_scheduling"),
          replanning: features.isEffective("round4.dynamic_replanning"),
          domainPack: features.isEffective("round4.domain_pack"),
        },
        advisorCaller: advisorEnabled ? createPiAdvisorCaller({
          modelId: process.env.REQUIREMENT_PLANNER_MODEL_ID ?? "default-planner-model",
        }) : undefined,
      });
      pi.registerTool(tool as ToolDefinition<any, any, any>);
    }

    // Native Pi skill registration: resources_discover → skillPaths.
    // The skill directory (skill/SKILL.md) is loaded by Pi and injected
    // into the system prompt; gated by round4.requirement_skill.
    if (features.isEffective("round4.requirement_skill")) {
      const skillDir = join(dirname(fileURLToPath(import.meta.url)), "src", "requirement-planning", "skill");
      pi.on("resources_discover", () => ({
        skillPaths: [skillDir],
      }));
    }
  }

  // ------------------------------------------------------------------
  // Round-4: Data Analysis Subagent (default OFF; fourth product round).
  //   - run_data_analysis registered only when ALL of:
  //     round4.data_analysis, round4.data_analysis_tool,
  //     round4.analysis_subagent, round4.analysis_script_execution,
  //     round4.analysis_artifacts, round4.analysis_frontend_render
  //   - when analysis_frontend_render is off the tool is NOT registered;
  //     there is no fallback to model recitation (hard boundary)
  //   - subagent caller is only built when round4.analysis_subagent is on
  // ------------------------------------------------------------------
  if (
    features.isEffective("round4.data_analysis") &&
    features.isEffective("round4.data_analysis_tool") &&
    features.isEffective("round4.analysis_subagent") &&
    features.isEffective("round4.analysis_script_execution") &&
    features.isEffective("round4.analysis_artifacts") &&
    features.isEffective("round4.analysis_frontend_render")
  ) {
    const snapshot = features.getEffectiveFeatureSnapshot();
    const store = new ArtifactStore();
    const tool = buildDataAnalysisTool({
      snapshot,
      store,
      subagent: createDataAnalysisSubagentCaller({
        modelId: process.env.ANALYSIS_SUBAGENT_MODEL_ID ??
          process.env.MODEL_ID ?? "default-subagent-model",
      }),
    });
    pi.registerTool(tool as ToolDefinition<any, any, any>);
  }

  // ------------------------------------------------------------------
  // Round-2: Pipeline Governance status dashboard (Phase 6; default OFF).
  //   - governance_dashboard registered only when the dashboard feature AND
  //     its state-reducer dependency are effective (the parent
  //     round2.pipeline_governance is implied by the resolver dependency
  //     chain — a child cannot be effective with the parent off)
  //   - off state: the tool is NOT registered; no python package is touched
  // ------------------------------------------------------------------
  if (features.isEffective("round2.pipeline_status_dashboard")) {
    const snapshot = features.getEffectiveFeatureSnapshot();
    const tool = buildGovernanceStatusTool({
      repoRoot: join(dirname(fileURLToPath(import.meta.url))),
    });
    void snapshot;
    pi.registerTool(tool as ToolDefinition<any, any, any>);
  }
}

export default function multimodalArtifactPoc(pi: ExtensionAPI): void {
  buildExtensionRegistrations(pi, getDefaultFeatureResolver());
}
