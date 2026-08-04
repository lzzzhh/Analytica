#!/usr/bin/env python3
"""
Persistent parser HTTP server for multimodal-artifact-poc.

Preloads PaddleOCR model at startup to eliminate cold start.
Tesseract and markitdown are stateless and load on first use.

Usage:
  python3 parser_server_http.py [--port 8765] [--no-paddle]
"""

import sys
import json
import os
import time
import argparse
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any

VERSION = "0.2.1"

MAX_FILE_SIZE = 50 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".webp"}
ALLOWED_DOC_TYPES = {".pdf", ".docx", ".pptx", ".xlsx", ".html", ".csv", ".md", ".txt", ".zip"}

MIME_MAP = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".bmp": "image/bmp", ".tiff": "image/tiff", ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".html": "text/html", ".csv": "text/csv", ".md": "text/markdown", ".txt": "text/plain",
}

# ---- Global state ----
paddle_ocr = None
tesseract_available = True
markitdown_available = True
paddle_enabled = True


def get_mime(path: str) -> str:
    return MIME_MAP.get(Path(path).suffix.lower(), "application/octet-stream")


def validate(path: str, allowed: set[str]) -> list[str]:
    w: list[str] = []
    if not os.path.isfile(path):
        raise FileNotFoundError(f"File not found: {path}")
    sz = os.path.getsize(path)
    if sz == 0:
        raise ValueError("Empty file")
    if sz > MAX_FILE_SIZE:
        raise ValueError(f"Too large: {sz} bytes (max {MAX_FILE_SIZE})")
    if Path(path).suffix.lower() not in allowed:
        raise ValueError(f"Unsupported type: {Path(path).suffix}")
    return w


# ---- PaddleOCR ----

def init_paddle():
    global paddle_ocr, paddle_enabled
    try:
        from paddleocr import PaddleOCR
        t0 = time.time()
        paddle_ocr = PaddleOCR(lang="ch")
        elapsed = time.time() - t0
        print(f"[init] PaddleOCR ready ({elapsed:.1f}s)", flush=True)
    except Exception as e:
        print(f"[init] PaddleOCR failed: {e}", flush=True)
        paddle_enabled = False


def parse_paddle(image_path: str) -> dict[str, Any]:
    from PIL import Image
    img = Image.open(image_path)
    w, h = img.size
    mime = get_mime(image_path)
    aid = f"img_{abs(hash(image_path)) % (10**12):012d}"
    warnings = validate(image_path, ALLOWED_IMAGE_TYPES)

    result = paddle_ocr.predict(image_path)
    page = result[0]

    texts = page.get("rec_texts", [])
    scores = page.get("rec_scores", [])
    polys = page.get("rec_polys", [])

    blocks = []
    for i in range(len(texts)):
        text = texts[i].strip() if isinstance(texts[i], str) else str(texts[i])
        if not text:
            continue
        score = float(scores[i]) if i < len(scores) else -1.0
        bbox = []
        if i < len(polys) and len(polys[i]) >= 4:
            pts = polys[i][:4]
            xs = [int(p[0]) for p in pts]
            ys = [int(p[1]) for p in pts]
            bbox = [min(xs), min(ys), max(xs), max(ys)]
        blocks.append({"text": text, "confidence": round(score, 4), "boundingBox": bbox})

    return {
        "artifactId": aid, "sourceType": "image", "mimeType": mime,
        "width": w, "height": h,
        "parser": {"name": "paddleocr", "version": "3.x"},
        "textBlocks": blocks,
        "fullText": " ".join(b["text"] for b in blocks),
        "warnings": warnings,
    }


# ---- Tesseract ----

def parse_tesseract(image_path: str) -> dict[str, Any]:
    import pytesseract
    from PIL import Image
    img = Image.open(image_path)
    w, h = img.size
    mime = get_mime(image_path)
    aid = f"img_{abs(hash(image_path)) % (10**12):012d}"
    warnings = validate(image_path, ALLOWED_IMAGE_TYPES)

    data = pytesseract.image_to_data(img, lang="chi_sim+eng", output_type=pytesseract.Output.DICT)
    blocks = []
    for i in range(len(data["text"])):
        text = data["text"][i].strip()
        if not text:
            continue
        conf = data["conf"][i]
        cv = float(conf) if isinstance(conf, (int, float)) and conf != -1 else -1.0
        if isinstance(conf, str):
            try: cv = float(conf)
            except ValueError: cv = -1.0
        blocks.append({
            "text": text,
            "confidence": round(cv / 100.0, 4) if cv > 0 else -1.0,
            "boundingBox": [data["left"][i], data["top"][i],
                            data["left"][i] + data["width"][i],
                            data["top"][i] + data["height"][i]],
        })

    return {
        "artifactId": aid, "sourceType": "image", "mimeType": mime,
        "width": w, "height": h,
        "parser": {"name": "tesseract-ocr", "version": str(pytesseract.get_tesseract_version())},
        "textBlocks": blocks,
        "fullText": " ".join(b["text"] for b in blocks),
        "warnings": warnings,
    }


# ---- markitdown ----

def parse_markitdown(file_path: str) -> dict[str, Any]:
    from markitdown import MarkItDown
    mime = get_mime(file_path)
    aid = f"doc_{abs(hash(file_path)) % (10**12):012d}"
    warnings = validate(file_path, ALLOWED_DOC_TYPES | ALLOWED_IMAGE_TYPES)

    md = MarkItDown()
    result = md.convert(file_path)
    text = result.text_content

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    blocks = [{"text": p[:500], "confidence": 1.0, "boundingBox": []} for p in paragraphs]

    return {
        "artifactId": aid, "sourceType": "document", "mimeType": mime,
        "width": 0, "height": 0,
        "parser": {"name": "markitdown", "version": "0.1.x"},
        "textBlocks": blocks, "fullText": text, "warnings": warnings,
    }


# ---- HTTP Handler ----

class ParserHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[http] {args[0]}", flush=True)

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/health", "/"):
            self._send_json({"status": "ok", "version": VERSION, "paddle": paddle_enabled})
        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        if self.path != "/parse":
            self._send_json({"error": "Not found"}, 404)
            return

        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self._send_json({"error": "Empty body"}, 400)
            return

        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON"}, 400)
            return

        path = body.get("path", "")
        mode = body.get("mode", "ocr")

        if not path:
            self._send_json({"error": "Missing 'path'"}, 400)
            return

        try:
            t0 = time.time()
            if mode == "ocr":
                if not paddle_enabled:
                    self._send_json({"error": "PaddleOCR not available"}, 503)
                    return
                result = parse_paddle(path)
            elif mode == "ocr_tesseract":
                result = parse_tesseract(path)
            elif mode == "document":
                result = parse_markitdown(path)
            else:
                self._send_json({"error": f"Unknown mode: {mode}"}, 400)
                return

            elapsed = time.time() - t0
            print(f"[parse] {mode} {Path(path).name} → {len(result['textBlocks'])} blocks ({elapsed:.2f}s)", flush=True)
            self._send_json(result)
        except Exception as e:
            self._send_json({"error": str(e)}, 500)


def main():
    global paddle_enabled

    parser = argparse.ArgumentParser(description="Parser HTTP Server")
    parser.add_argument("--port", type=int, default=8765, help="Listen port (default: 8765)")
    parser.add_argument("--no-paddle", action="store_true", help="Skip PaddleOCR loading")
    args = parser.parse_args()

    if not args.no_paddle:
        init_paddle()

    server = HTTPServer(("127.0.0.1", args.port), ParserHandler)
    modes = []
    if paddle_enabled: modes.append("paddleocr")
    modes.append("tesseract")
    modes.append("markitdown")
    print(f"[server] Listening on http://127.0.0.1:{args.port} (engines: {', '.join(modes)})", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] Shutting down", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
