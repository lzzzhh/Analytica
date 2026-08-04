from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
WAREHOUSE = OUT / "warehouse"


def command(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


packages = {}
for name in (
    "pyarrow",
    "pyiceberg",
    "pyspark",
    "pytest",
    "pandas",
    "duckdb",
    "markitdown",
    "paddleocr",
):
    try:
        packages[name] = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        packages[name] = None

node = shutil.which("node")
manifest = {
    "capturedAt": datetime.now(timezone.utc).isoformat(),
    "repositoryRoot": str(ROOT),
    "commitSha": command("git", "rev-parse", "HEAD"),
    "gitStatusPorcelain": command("git", "status", "--porcelain"),
    "pythonExecutable": sys.executable,
    "pythonVersion": platform.python_version(),
    "nodeExecutable": node,
    "nodeVersion": command(node, "--version") if node else None,
    "platform": platform.platform(),
    "dependencies": packages,
    "packageLockSha256": sha256(ROOT / "package-lock.json"),
    "evaluationWarehouse": str(WAREHOUSE),
    "pipelineTestRoot": str(OUT / "native-pipeline"),
    "governanceBypassRoot": str(OUT / "governance-bypass"),
    "relevantEnvironment": {
        "PIPELINE_GOVERNANCE_PI_CLI": bool(os.environ.get("PIPELINE_GOVERNANCE_PI_CLI")),
        "REVIEWER_STORE_ROOT": bool(os.environ.get("REVIEWER_STORE_ROOT")),
        "LAKEHOUSE_GATEWAY_URL": bool(os.environ.get("LAKEHOUSE_GATEWAY_URL")),
        "OPENAI_API_KEY": bool(os.environ.get("OPENAI_API_KEY")),
        "DEEPSEEK_API_KEY": bool(os.environ.get("DEEPSEEK_API_KEY")),
    },
}

(OUT / "environment-manifest.json").write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
print(json.dumps(manifest, ensure_ascii=False, indent=2))
