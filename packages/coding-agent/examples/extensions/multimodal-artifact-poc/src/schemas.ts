/**
 * JSON Schemas for multimodal artifact PoC.
 * These define the structured output format for parse tools.
 */

export interface TextBlock {
  text: string;
  confidence: number;
  boundingBox: [number, number, number, number] | [];
}

export interface ParserInfo {
  name: "paddleocr" | "tesseract-ocr" | "markitdown" | "none";
  version: string;
}

export interface ParseResult {
  artifactId: string;
  sourceType: "image" | "document";
  mimeType: string;
  width: number;
  height: number;
  parser: ParserInfo;
  textBlocks: TextBlock[];
  fullText: string;
  warnings: string[];
  error?: string;
}

export type ParseMode = "ocr" | "ocr_tesseract" | "document";

export interface ParseInput {
  path: string;
  mode: ParseMode;
}
