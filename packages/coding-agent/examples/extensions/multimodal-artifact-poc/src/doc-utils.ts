/**
 * Small shared helpers for document tools.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".html": "text/html",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

export function resolveDocumentPath(input: string, cwd: string): string {
  return isAbsolute(input) ? input : resolve(cwd, input);
}

export function getMimeTypeOf(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop();
  return ext ? (MIME_BY_EXT[`.${ext}`] ?? "application/octet-stream") : "application/octet-stream";
}

export function validateDocumentFile(filePath: string): void {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const stat = statSync(filePath);
  if (stat.size === 0) throw new Error("File is empty");
  if (stat.size > 50 * 1024 * 1024) {
    throw new Error(`File too large: ${stat.size} bytes (max ${50 * 1024 * 1024})`);
  }
}
