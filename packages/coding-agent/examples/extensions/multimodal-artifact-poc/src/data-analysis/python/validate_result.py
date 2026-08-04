#!/usr/bin/env python3
"""validate_result.py — structural checks on analysis-result.json.

Usage: python3 validate_result.py <result-path>

Checks:
  - valid JSON object;
  - schemaVersion/artifactId/runId/status/title present;
  - status in {COMPLETED, PARTIAL, FAILED};
  - reviewStatus == NOT_REVIEWED;
  - sections is a list; each section has a known type and shape;
  - no HTML/script content inside values.
Exits 0 when valid, 1 with a single-line reason otherwise.
"""
import json
import sys
from pathlib import Path

SECTION_KINDS = {"METRIC_CARDS", "TABLE", "LINE_CHART", "BAR_CHART", "SCATTER", "HISTOGRAM"}
VALUE_TYPES = {"NUMBER", "PERCENT", "CURRENCY", "INTEGER", "DURATION", "TEXT"}
MAX_SECTIONS = 50
MAX_ROWS = 500
MAX_POINTS = 2000


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_result.py <result-path>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print("result file not found", file=sys.stderr)
        return 1
    if path.stat().st_size > 1_000_000:
        print("result file exceeds size limit", file=sys.stderr)
        return 1
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"invalid JSON: {e}", file=sys.stderr)
        return 1
    if not isinstance(data, dict):
        print("result is not an object", file=sys.stderr)
        return 1
    for field in ("schemaVersion", "artifactId", "runId", "title"):
        if not isinstance(data.get(field), str) or not data[field]:
            print(f"missing field: {field}", file=sys.stderr)
            return 1
    if data.get("status") not in ("COMPLETED", "PARTIAL", "FAILED"):
        print("bad status", file=sys.stderr)
        return 1
    if data.get("reviewStatus") != "NOT_REVIEWED":
        print("reviewStatus must be NOT_REVIEWED", file=sys.stderr)
        return 1
    sections = data.get("sections")
    if not isinstance(sections, list) or len(sections) > MAX_SECTIONS:
        print("bad sections", file=sys.stderr)
        return 1
    for i, s in enumerate(sections):
        if not isinstance(s, dict) or s.get("type") not in SECTION_KINDS:
            print(f"section {i}: bad type", file=sys.stderr)
            return 1
        stype = s["type"]
        if stype == "METRIC_CARDS":
            metrics = s.get("metrics")
            if not isinstance(metrics, list) or not metrics:
                print(f"section {i}: no metrics", file=sys.stderr)
                return 1
            for m in metrics:
                if not isinstance(m, dict) or "value" not in m:
                    print(f"section {i}: metric missing value", file=sys.stderr)
                    return 1
                if m.get("valueType") not in VALUE_TYPES:
                    print(f"section {i}: bad valueType", file=sys.stderr)
                    return 1
                if isinstance(m.get("value"), str) and ("<" in m["value"] or ">" in m["value"]):
                    print(f"section {i}: HTML in metric value", file=sys.stderr)
                    return 1
        elif stype == "TABLE":
            rows = s.get("rows")
            if not isinstance(rows, list):
                print(f"section {i}: rows not list", file=sys.stderr)
                return 1
            if len(rows) > MAX_ROWS:
                print(f"section {i}: too many rows", file=sys.stderr)
                return 1
        else:
            series = s.get("series")
            if not isinstance(series, list):
                print(f"section {i}: series not list", file=sys.stderr)
                return 1
            total = sum(len(ser.get("points") or []) for ser in series if isinstance(ser, dict))
            if total > MAX_POINTS:
                print(f"section {i}: too many points", file=sys.stderr)
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
