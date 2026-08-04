"""Deterministic data quality checks — no LLM, no external services.

Quality statuses:
  PASS — data present, missing rates within thresholds
  WARN — mild issues (e.g. elevated missing rate on some columns)
  FAIL — data unusable (empty scan, catastrophic missing rates)

The profiler (app.quality.profile) supplies the raw statistics; this module
turns them into a decision.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pyarrow as pa

from app.config import LakehouseConfig

MISSING_WARN = 0.30   # column missing rate above this → WARN
MISSING_FAIL = 0.60   # column missing rate above this → FAIL


@dataclass(frozen=True)
class QualityCheck:
    check: str
    status: str        # PASS | WARN | FAIL
    detail: str = ""


@dataclass(frozen=True)
class QualityResult:
    status: str
    checks: list[QualityCheck] = field(default_factory=list)
    generatedAt: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "checks": [{"check": c.check, "status": c.status, "detail": c.detail} for c in self.checks],
            "generatedAt": self.generatedAt,
        }


def assess_scan_quality(scanned: pa.Table, config: LakehouseConfig) -> str:
    return assess_quality(scanned, config).status


def assess_quality(scanned: pa.Table, config: LakehouseConfig) -> QualityResult:
    from datetime import datetime, timezone
    checks: list[QualityCheck] = []

    if scanned is None or scanned.num_rows == 0:
        return QualityResult(
            status="FAIL",
            checks=[QualityCheck("row_count", "FAIL", "scan returned 0 rows")],
            generatedAt=datetime.now(timezone.utc).isoformat(),
        )

    checks.append(QualityCheck("row_count", "PASS", f"{scanned.num_rows} rows"))
    if scanned.num_rows < 2:
        checks.append(QualityCheck("sample_size", "WARN", "very few rows; statistics unstable"))

    for col in scanned.column_names:
        non_null = scanned.column(col).null_count
        total = len(scanned.column(col))
        if total == 0:
            continue
        missing = non_null / total
        if missing >= MISSING_FAIL:
            checks.append(QualityCheck(f"missing_rate.{col}", "FAIL", f"{missing:.1%} missing"))
        elif missing >= MISSING_WARN:
            checks.append(QualityCheck(f"missing_rate.{col}", "WARN", f"{missing:.1%} missing"))

    statuses = {c.status for c in checks}
    status = "FAIL" if "FAIL" in statuses else ("WARN" if "WARN" in statuses else "PASS")
    return QualityResult(
        status=status,
        checks=checks,
        generatedAt=datetime.now(timezone.utc).isoformat(),
    )
