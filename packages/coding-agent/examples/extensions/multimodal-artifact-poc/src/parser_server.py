#!/usr/bin/env python3
"""
Unified local parser for multimodal-artifact-poc.

Modes:
  ocr           PaddleOCR (image → structured text, best for Chinese)
  ocr_tesseract Tesseract (image → structured text, legacy fallback)
  document      markitdown (PDF/DOCX/PPTX/XLSX/HTML → Markdown)

Usage:
  echo '{"path": "/path/to/file.png", "mode": "ocr"}' | python3 parser_server.py
"""

import json
import sys
import os
from pathlib import Path
from typing import Any

VERSION = "0.2.0"

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB

ALLOWED_IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".webp"}
ALLOWED_DOC_TYPES = {".pdf", ".docx", ".pptx", ".xlsx", ".html", ".csv", ".xml", ".zip", ".md", ".txt"}

MIME_MAP = {
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
}


def get_mime_type(path: str) -> str:
    ext = Path(path).suffix.lower()
    return MIME_MAP.get(ext, "application/octet-stream")


def validate_file(path: str, allowed_extensions: set[str]) -> list[str]:
    warnings: list[str] = []
    if not os.path.isfile(path):
        raise FileNotFoundError(f"File not found: {path}")
    file_size = os.path.getsize(path)
    if file_size > MAX_FILE_SIZE:
        raise ValueError(f"File too large: {file_size} bytes (max {MAX_FILE_SIZE})")
    if file_size == 0:
        raise ValueError("File is empty")
    ext = Path(path).suffix.lower()
    if ext not in allowed_extensions:
        raise ValueError(f"Unsupported file type: {ext}. Allowed: {allowed_extensions}")
    return warnings


# ============================================================
# PaddleOCR backend
# ============================================================

def parse_image_paddleocr(image_path: str) -> dict[str, Any]:
    try:
        from paddleocr import PaddleOCR
    except ImportError:
        return {"error": "PaddleOCR not installed. Run: pip3 install paddleocr"}

    try:
        from PIL import Image
    except ImportError:
        return {"error": "Pillow required. Run: pip3 install Pillow"}

    img = Image.open(image_path)
    width, height = img.size
    mime = get_mime_type(image_path)
    artifact_id = f"img_{abs(hash(image_path)) % (10**12):012d}"
    warnings = validate_file(image_path, ALLOWED_IMAGE_TYPES)

    try:
        ocr = PaddleOCR(lang="ch")
        result = ocr.predict(image_path)
        page = result[0]
    except Exception as e:
        return {
            "artifactId": artifact_id,
            "sourceType": "image",
            "mimeType": mime,
            "width": width,
            "height": height,
            "parser": {"name": "paddleocr", "version": "3.x"},
            "textBlocks": [],
            "fullText": "",
            "warnings": warnings + [f"PaddleOCR failed: {str(e)}"],
            "error": str(e),
        }

    texts = page.get("rec_texts", [])
    scores = page.get("rec_scores", [])
    polys = page.get("rec_polys", [])

    text_blocks: list[dict[str, Any]] = []
    for i in range(len(texts)):
        text = texts[i].strip() if isinstance(texts[i], str) else str(texts[i])
        if not text:
            continue
        score = float(scores[i]) if i < len(scores) else -1.0
        bbox: list[int] = []
        if i < len(polys) and len(polys[i]) >= 4:
            pts = polys[i][:4]
            xs = [int(p[0]) for p in pts]
            ys = [int(p[1]) for p in pts]
            bbox = [min(xs), min(ys), max(xs), max(ys)]
        text_blocks.append({
            "text": text,
            "confidence": round(score, 4),
            "boundingBox": bbox,
        })

    full_text = " ".join(b["text"] for b in text_blocks)

    return {
        "artifactId": artifact_id,
        "sourceType": "image",
        "mimeType": mime,
        "width": width,
        "height": height,
        "parser": {"name": "paddleocr", "version": "3.x"},
        "textBlocks": text_blocks,
        "fullText": full_text,
        "warnings": warnings,
    }


# ============================================================
# Tesseract backend (legacy)
# ============================================================

def parse_image_tesseract(image_path: str) -> dict[str, Any]:
    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        return {"error": "pytesseract/Pillow required. Run: pip3 install pytesseract Pillow"}

    img = Image.open(image_path)
    width, height = img.size
    mime = get_mime_type(image_path)
    artifact_id = f"img_{abs(hash(image_path)) % (10**12):012d}"
    warnings = validate_file(image_path, ALLOWED_IMAGE_TYPES)

    try:
        ocr_data = pytesseract.image_to_data(img, lang="chi_sim+eng", output_type=pytesseract.Output.DICT)
    except Exception as e:
        return {
            "artifactId": artifact_id,
            "sourceType": "image",
            "mimeType": mime,
            "width": width,
            "height": height,
            "parser": {"name": "tesseract-ocr", "version": str(getattr(pytesseract, "get_tesseract_version", lambda: "?")())},
            "textBlocks": [],
            "fullText": "",
            "warnings": warnings + [f"Tesseract failed: {str(e)}"],
            "error": str(e),
        }

    text_blocks: list[dict[str, Any]] = []
    for i in range(len(ocr_data["text"])):
        text = ocr_data["text"][i].strip()
        if not text:
            continue
        conf = ocr_data["conf"][i]
        conf_val = float(conf) if isinstance(conf, (int, float)) and conf != -1 else -1.0
        if isinstance(conf, str):
            try:
                conf_val = float(conf)
            except ValueError:
                conf_val = -1.0
        text_blocks.append({
            "text": text,
            "confidence": round(conf_val / 100.0, 4) if conf_val > 0 else -1.0,
            "boundingBox": [
                ocr_data["left"][i],
                ocr_data["top"][i],
                ocr_data["left"][i] + ocr_data["width"][i],
                ocr_data["top"][i] + ocr_data["height"][i],
            ],
        })

    full_text = " ".join(b["text"] for b in text_blocks)

    return {
        "artifactId": artifact_id,
        "sourceType": "image",
        "mimeType": mime,
        "width": width,
        "height": height,
        "parser": {"name": "tesseract-ocr", "version": str(getattr(pytesseract, "get_tesseract_version", lambda: "?")())},
        "textBlocks": text_blocks,
        "fullText": full_text,
        "warnings": warnings,
    }


# ============================================================
# markitdown backend (documents)
# ============================================================

def parse_document_markitdown(file_path: str) -> dict[str, Any]:
    try:
        from markitdown import MarkItDown
    except ImportError:
        return {"error": "markitdown not installed. Run: pip3 install markitdown"}

    mime = get_mime_type(file_path)
    ext = Path(file_path).suffix.lower()
    artifact_id = f"doc_{abs(hash(file_path)) % (10**12):012d}"
    # markitdown is document-only — images should go through parse_image/parse_visual
    warnings = validate_file(file_path, ALLOWED_DOC_TYPES)
    try:
        md = MarkItDown()
        result = md.convert(file_path)
        text_content = result.text_content
    except Exception as e:
        return {
            "artifactId": artifact_id,
            "sourceType": "document",
            "mimeType": mime,
            "width": 0,
            "height": 0,
            "parser": {"name": "markitdown", "version": "0.1.x"},
            "textBlocks": [],
            "fullText": "",
            "warnings": warnings + [f"markitdown failed: {str(e)}"],
            "error": str(e),
        }

    # Split into logical blocks (paragraphs)
    paragraphs = [p.strip() for p in text_content.split("\n\n") if p.strip()]
    text_blocks: list[dict[str, Any]] = []
    for p in paragraphs:
        text_blocks.append({
            "text": p[:500],  # Truncate very long blocks
            "confidence": 1.0,  # MarkItDown doesn't provide confidence scores
            "boundingBox": [],
        })

    return {
        "artifactId": artifact_id,
        "sourceType": "document",
        "mimeType": mime,
        "width": 0,
        "height": 0,
        "parser": {"name": "markitdown", "version": "0.1.x"},
        "textBlocks": text_blocks,
        "fullText": text_content,
        "warnings": warnings,
    }


# ============================================================
# Main dispatch
# ============================================================

def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            print(json.dumps({"error": "No input. Send JSON with 'path' and 'mode'."}))
            sys.exit(1)
        request = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {str(e)}"}))
        sys.exit(1)

    image_path = request.get("path", "")
    mode = request.get("mode", "ocr")

    if not image_path:
        print(json.dumps({"error": "Missing required field: 'path'"}))
        sys.exit(1)

    try:
        if mode == "ocr":
            result = parse_image_paddleocr(image_path)
        elif mode == "ocr_tesseract":
            result = parse_image_tesseract(image_path)
        elif mode == "document":
            result = parse_document_markitdown(image_path)
        else:
            print(json.dumps({"error": f"Unknown mode: {mode}. Use 'ocr', 'ocr_tesseract', or 'document'."}))
            sys.exit(1)

        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
