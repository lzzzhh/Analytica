/**
 * Visual parser for multimodal artifact PoC.
 *
 * Calls the PaddleOCR-VL-1.6 model served by llama-server (router mode)
 * via its OpenAI-compatible API. The image is sent as base64 to the VL
 * model ONLY — it never enters the text LLM's context.
 *
 * Output distinguishes:
 *   facts           — exact values the model could read (with confidence if provided)
 *   inferences      — qualitative claims (trends, shapes, relationships)
 *   unverifiedClaims — anything the model is unsure about — must NOT be presented as fact
 */

import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface VisualFact {
  name: string;
  /** Stable canonical field id so free-text labels (中/英) map to one key. */
  canonicalId?: string;
  value: string | number;
  confidence: number | null;
}

/** Canonical field aliases — free-text labels (Chinese/English, spacing,
 *  punctuation variants) all map to ONE stable id. Unknown labels fall back
 *  to a slug of the normalized name. */
const CANONICAL_FIELD_ALIASES: Array<{ id: string; aliases: string[] }> = [
  { id: "avg_quality", aliases: ["总体平均质量", "平均质量", "平均quality", "average quality", "avg quality", "quality average"] },
  { id: "total_revenue", aliases: ["总销售额", "销售总额", "总收入", "total sales", "total revenue"] },
  { id: "order_count", aliases: ["订单数", "订单数量", "total orders", "order count"] },
  { id: "avg_price", aliases: ["平均价格", "均价", "average price", "avg price"] },
  { id: "conversion_rate", aliases: ["转化率", "conversion rate"] },
];

/** Normalize a free-text label to a stable canonical field id (P2 regression:
 *  "总体平均质量" and "平均quality" must compare equal in golden checks). */
export function canonicalizeFactName(name: string): { canonicalId: string; displayName: string } {
  const key = name.trim().replace(/[\s\u00a0]+/gu, " ").toLowerCase();
  for (const alias of CANONICAL_FIELD_ALIASES) {
    const hit = alias.aliases.some((a) => {
      const aKey = a.toLowerCase();
      return key.includes(aKey) || aKey.includes(key);
    });
    if (hit) return { canonicalId: alias.id, displayName: name.trim() };
  }
  const slug = key.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return { canonicalId: slug || "unnamed", displayName: name.trim() };
}

export interface VisualInference {
  claim: string;
}

export interface VisualUnverifiedClaim {
  claim: string;
}

export interface VisualParseResult {
  artifactId: string;
  sourceType: "image";
  mimeType: string;
  width: number;
  height: number;
  parser: { name: "paddleocr-vl"; version: string };
  chartType: string | null;
  facts: VisualFact[];
  inferences: VisualInference[];
  unverifiedClaims: VisualUnverifiedClaim[];
  rawDescription: string;
  warnings: string[];
  error?: string;
}

export interface VisualParseInput {
  path: string;
  intent?: string;
}

/** llama-server endpoint (same server as the text model, router mode) */
const LLAMA_SERVER_URL = process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080";
const VL_MODEL_ID = process.env.VL_MODEL_ID ?? "PaddleOCR-VL-1.6";

/** Max image size for VL input: 20 MB (VL uses base64, keep payload small) */
const MAX_VL_IMAGE_SIZE = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
};

/**
 * PaddleOCR-VL-1.6 is a specialized OCR model: it ignores system prompts,
 * cannot produce JSON, and produces garbage when given complex instructions.
 * It reliably extracts data as `Label | Value` rows when prompted minimally.
 * We use a fixed minimal prompt and parse the rows deterministically here.
 */
const VL_EXTRACT_PROMPT = "Extract data.";


function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop();
  return ext ? (MIME_BY_EXT[`.${ext}`] ?? "application/octet-stream") : "application/octet-stream";
}

export function resolveVisualPath(input: string, cwd: string): string {
  return isAbsolute(input) ? input : resolve(cwd, input);
}

function validateVisualFile(filePath: string): string[] {
  const warnings: string[] = [];
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const stat = readFileSync(filePath);
  if (stat.length === 0) throw new Error("File is empty");
  if (stat.length > MAX_VL_IMAGE_SIZE) {
    throw new Error(`Image too large for VL: ${stat.length} bytes (max ${MAX_VL_IMAGE_SIZE})`);
  }
  if (getMimeType(filePath) === "application/octet-stream") {
    warnings.push("Unrecognized image extension; VL may reject the request");
  }
  return warnings;
}

/**
 * Parse the VL model's deterministic output into facts.
 *
 * Supports two shapes observed from PaddleOCR-VL:
 *   vertical:   "Jan | 380"  (Label | Value per line)
 *   horizontal: "Month | Jan | Feb | Mar ..."  then  "January | 380 | 420 | ..."
 *               (header row aligned with data rows)
 * Anything unparseable goes into unverifiedClaims.
 */
function parseVlRows(content: string): { facts: VisualFact[]; unverified: VisualUnverifiedClaim[]; description: string } {
  const facts: VisualFact[] = [];
  const unverified: VisualUnverifiedClaim[] = [];
  const descriptionLines: string[] = [];

  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Try horizontal table: consistent column count across rows
  if (lines.length >= 2) {
    const colCounts = lines.map((l) => l.split("|").length);
    const first = colCounts[0] ?? 0;
    if (first >= 2 && colCounts.every((c) => c === first)) {
      const header = lines[0]!.split("|").map((s) => s.trim());
      const headerNames = header.slice(1).map((h) => normalizeLabel(h));
      for (const row of lines.slice(1)) {
        const cells = row.split("|").map((s) => s.trim());
        const rowLabel = normalizeLabel(cells[0] ?? "");
        for (let i = 1; i < cells.length; i++) {
          const valueStr = cells[i]!;
          if (!valueStr) continue;
          const name = headerNames[i - 1] ? `${rowLabel} ${headerNames[i - 1]}`.trim() : rowLabel;
          facts.push(makeFact(name, valueStr));
        }
      }
      return { facts, unverified, description: descriptionLines.join(" ") };
    }
  }

  // Vertical: Label | Value per line
  for (const rawLine of lines) {
    const match = rawLine.match(/^(.*?)\s*\|\s*(.*)$/u);
    if (match) {
      const label = match[1].trim();
      const valueStr = match[2].trim();
      // Skip model-generated header rows
      if (/^(task\s*name|label|header|key|item)\s*$/iu.test(label) && /^(value|val|amount|data)$/iu.test(valueStr)) {
        continue;
      }
      if (label && valueStr) {
        facts.push(makeFact(normalizeLabel(label), valueStr));
        continue;
      }
    }
    // Not a Label | Value row → unverified claim
    unverified.push({ claim: rawLine.slice(0, 200) });
  }

  return { facts, unverified, description: descriptionLines.join(" ") };
}

function normalizeLabel(label: string): string {
  return label.trim();
}

function makeFact(name: string, valueStr: string): VisualFact {
  const { canonicalId, displayName } = canonicalizeFactName(name);
  const num = Number(valueStr.replace(/[,%\s ]/gu, "").replace(/\$|K$/gu, ""));
  if (Number.isFinite(num) && valueStr.replace(/[,%\s $K]/gu, "") !== "") {
    return { name: displayName, canonicalId, value: num, confidence: null };
  }
  return { name: displayName, canonicalId, value: valueStr, confidence: null };
}

/**
 * Call PaddleOCR-VL via llama-server's OpenAI-compatible endpoint.
 * Sends the image as base64 — only to the VL model, never to the text model.
 * The VL model returns deterministic `Label | Value` rows, parsed here.
 */
async function callVisualModel(
  imagePath: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<{
  facts: VisualFact[];
  unverifiedClaims: VisualUnverifiedClaim[];
  rawOutput: string;
}> {
  const b64 = readFileSync(imagePath).toString("base64");
  const mime = getMimeType(imagePath);

  const body = JSON.stringify({
    model: VL_MODEL_ID,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          { type: "text", text: VL_EXTRACT_PROMPT },
        ],
      },
    ],
    max_tokens: 800,
  });

  const response = await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`VL model returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("VL model returned empty response");

  const { facts, unverified, description } = parseVlRows(content);
  return {
    facts,
    unverifiedClaims: unverified,
    rawOutput: description || content.slice(0, 1000),
  };
}

/**
 * Parse an image with the vision model.
 * Main entry point called by the Pi tool handler.
 */
export async function parseVisual(
  input: VisualParseInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<VisualParseResult> {
  const resolvedPath = resolveVisualPath(input.path, cwd);
  const preWarnings = validateVisualFile(resolvedPath);

  // Width/height for the artifact record
  let width = 0;
  let height = 0;
  try {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((res, rej) => {
      execFile(
        "python3",
        ["-c", `from PIL import Image; i=Image.open('${resolvedPath}'); print(i.size[0], i.size[1])`],
        (err, stdout) => {
          if (!err) {
            const [w, h] = stdout.trim().split(" ").map(Number);
            width = w ?? 0;
            height = h ?? 0;
          }
          res();
        },
      );
    });
  } catch {
    // Non-fatal: dimensions unavailable
  }

  const userPrompt = input.intent
    ? `Focus on: ${input.intent}`
    : "Extract all data points from the chart or image.";

  try {
    const parsed = await callVisualModel(resolvedPath, userPrompt, signal);
    const artifactId = `vimg_${Math.abs(hashCode(resolvedPath)).toString(36)}`;

    // chartType is not reliably reported by this OCR-focused model; infer from output shape
    const chartType = parsed.facts.length > 0 ? "chart-data" : null;

    return {
      artifactId,
      sourceType: "image",
      mimeType: getMimeType(resolvedPath),
      width,
      height,
      parser: { name: "paddleocr-vl", version: "1.6" },
      chartType,
      facts: parsed.facts,
      inferences: [],
      unverifiedClaims: parsed.unverifiedClaims,
      rawDescription: parsed.rawOutput,
      warnings: preWarnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      artifactId: "",
      sourceType: "image",
      mimeType: getMimeType(resolvedPath),
      width,
      height,
      parser: { name: "paddleocr-vl", version: "1.6" },
      chartType: null,
      facts: [],
      inferences: [],
      unverifiedClaims: [],
      rawDescription: "",
      warnings: preWarnings,
      error: message,
    };
  }
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
