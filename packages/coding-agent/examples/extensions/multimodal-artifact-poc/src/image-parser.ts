/**
 * Unified parser for multimodal artifact PoC.
 *
 * Calls a local Python parser (parser_server.py) via child_process.spawn.
 * Uses a fixed program path and argument array — never executes arbitrary shell strings.
 *
 * Modes:
 *   ocr           - PaddleOCR (best for Chinese text)
 *   ocr_tesseract - Tesseract (legacy fallback)
 *   document      - markitdown (PDF, DOCX, PPTX, XLSX, etc.)
 */

import { spawn } from "node:child_process";
import { statSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { ParseResult, ParseInput, ParseMode } from "./schemas.ts";

/** Maximum file size in bytes (50 MB) */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** MIME type map by extension */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".html": "text/html",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".webp"]);

function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop();
  return ext ? (MIME_BY_EXT[`.${ext}`] ?? "application/octet-stream") : "application/octet-stream";
}

function isImageExt(filePath: string): boolean {
  const ext = filePath.toLowerCase().split(".").pop();
  return ext ? IMAGE_EXTS.has(`.${ext}`) : false;
}

export function resolvePath(input: string, cwd: string): string {
  if (isAbsolute(input)) return input;
  return resolve(cwd, input);
}

function validateFile(filePath: string, mode: ParseMode): string[] {
  const warnings: string[] = [];

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = statSync(filePath);
  if (stat.size === 0) throw new Error("File is empty");
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`);
  }

  if ((mode === "ocr" || mode === "ocr_tesseract") && !isImageExt(filePath)) {
    throw new Error(`Image mode requires PNG/JPG/BMP/TIFF/WEBP, got: ${getMimeType(filePath)}`);
  }

  return warnings;
}

function isValidResult(value: unknown): value is ParseResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.artifactId !== "string") return false;
  if (r.sourceType !== "image" && r.sourceType !== "document") return false;
  if (typeof r.mimeType !== "string") return false;
  if (typeof r.fullText !== "string") return false;
  if (!Array.isArray(r.textBlocks)) return false;
  if (!Array.isArray(r.warnings)) return false;
  return true;
}

/**
 * Call the Python parser server with the given input.
 * Uses spawn with a fixed program path and argument array.
 */
function callParserServer(
  input: ParseInput,
  scriptPath: string,
  signal?: AbortSignal,
): Promise<ParseResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Parser process exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) {
          reject(new Error(`Parser error: ${parsed.error}`));
          return;
        }
        if (!isValidResult(parsed)) {
          reject(new Error(`Parser returned invalid JSON structure: ${stdout.slice(0, 200)}`));
          return;
        }
        resolvePromise(parsed);
      } catch (err) {
        if (err instanceof SyntaxError) {
          reject(new Error(`Failed to parse parser output as JSON: ${stdout.slice(0, 200)}`));
        } else {
          reject(err);
        }
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start parser process: ${err.message}`));
    });

    const inputJson = JSON.stringify(input);
    proc.stdin.write(inputJson);
    proc.stdin.end();
  });
}

/**
 * Parse a file and return structured results.
 * This is the main entry point called by the Pi tool handler.
 */
export async function parseFile(
  input: ParseInput,
  cwd: string,
  scriptPath: string,
  signal?: AbortSignal,
): Promise<ParseResult> {
  const resolvedPath = resolvePath(input.path, cwd);
  const preWarnings = validateFile(resolvedPath, input.mode);
  const result = await callParserServer(
    { path: resolvedPath, mode: input.mode },
    scriptPath,
    signal,
  );
  result.warnings = [...preWarnings, ...result.warnings];
  return result;
}
