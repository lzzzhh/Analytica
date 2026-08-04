#!/usr/bin/env python3
"""validate_script.py — static pre-execution checks on an analysis script.

Usage: python3 validate_script.py <script-path>

Checks (before the script ever runs):
  - forbidden statements: import of os/subprocess/socket/requests/etc,
    os.system / subprocess.* / eval / exec / __import__ / compile,
    network module imports, pip/curl/wget subprocesses, open() on absolute
    paths, database connection strings.
Exits 0 when clean, 1 with a single-line reason otherwise.
"""
import re
import sys
from pathlib import Path

FORBIDDEN_PATTERNS = [
    (r"^\s*(import|from)\s+(os|subprocess|socket|requests|urllib|http\.client|ftplib|paramiko|shutil|pickle|ctypes)\b", "forbidden import"),
    (r"\bos\.system\s*\(", "os.system"),
    (r"\bsubprocess\s*\.", "subprocess call"),
    (r"\beval\s*\(|\bexec\s*\(|__import__\s*\(|compile\s*\(", "dynamic code"),
    (r"\bpip\b|\bcurl\b|\bwget\b|\bnc\b", "network/install tool"),
    (r"\bopen\s*\(\s*['\"](/|~|[a-zA-Z]:\\)", "absolute path open"),
    (r"(jdbc|postgresql|mysql|sqlite|mongodb|redshift|bigquery)://", "connection string"),
    (r"\binput\s*\(|breakpoint\s*\(|pdb\b", "interactive/debug"),
]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_script.py <script-path>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"script not found: {path}", file=sys.stderr)
        return 1
    if path.stat().st_size > 200_000:
        print("script exceeds size limit", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8", errors="replace")
    for pattern, label in FORBIDDEN_PATTERNS:
        for lineno, line in enumerate(text.splitlines(), 1):
            if re.search(pattern, line):
                print(f"{label} at line {lineno}", file=sys.stderr)
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
