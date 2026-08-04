"""Deterministic Data Profiler — no LLM calls.

MIGRATED from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/profiling/schema_profiler.py). GENERALIZATION changes:
  - Profile models extracted to app.quality.models (see its header); import updated.
  - No logic changes.

Reads structured data, PDF JSON, OCR JSON and produces DatasetProfileV1.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from app.quality.models import (
    ColumnProfileV1,
    DatasetProfileV1,
    TableProfileV1,
)


def profile_structured(table_id: str, rows: list[dict[str, Any]], max_samples: int = 5) -> TableProfileV1:
    """Profile a structured table from a list of dict rows."""
    if not rows:
        return TableProfileV1(table_id=table_id, row_count=0)

    columns: dict[str, list[Any]] = {}
    for row in rows:
        for key, val in row.items():
            columns.setdefault(key, []).append(val)

    col_profiles = []
    for col_name, values in columns.items():
        non_null = [v for v in values if v is not None]
        n = len(values)
        missing = (n - len(non_null)) / max(1, n)
        unique = len(set(str(v) for v in non_null)) / max(1, len(non_null))
        logical_types = _infer_logical_types(non_null)
        patterns = _detect_value_patterns(non_null)
        masked = _mask_samples(non_null[:max_samples])

        col_profiles.append(ColumnProfileV1(
            column_name=col_name,
            physical_type=_py_type(values[0]),
            logical_type_candidates=logical_types,
            missing_rate=round(missing, 4),
            unique_rate=round(unique, 4),
            value_patterns=patterns,
            masked_samples=masked,
            distinct_count=len(set(str(v) for v in non_null)),
        ))

    # Candidate keys
    candidate_keys = []
    for cp in col_profiles:
        if cp.unique_rate > 0.99 and cp.missing_rate < 0.01:
            candidate_keys.append([cp.column_name])

    # Candidate time columns
    time_cols = [cp.column_name for cp in col_profiles
                 if "datetime" in cp.logical_type_candidates or "date" in cp.logical_type_candidates]

    # Sample rows (masked)
    sample_rows = []
    for row in rows[:max_samples]:
        masked_row = {}
        for k, v in row.items():
            masked_row[k] = _mask_value(v)
        sample_rows.append(masked_row)

    return TableProfileV1(
        table_id=table_id,
        row_count=len(rows),
        columns=col_profiles,
        candidate_keys=candidate_keys,
        candidate_time_columns=time_cols,
        sample_rows_json=sample_rows,
    )


def profile_all(tables: dict[str, list[dict[str, Any]]], dataset_id: str = "",
                user_hints: dict | None = None) -> DatasetProfileV1:
    """Profile all tables and detect cross-table relations."""
    table_profiles = {}
    for tid, rows in tables.items():
        table_profiles[tid] = profile_structured(tid, rows)

    # Cross-table relation candidates
    relations = _detect_relations(table_profiles)

    # Content hash
    content = json.dumps({tid: [str(r) for r in rows[:3]] for tid, rows in tables.items()}, sort_keys=True)
    content_hash = "sha256:" + hashlib.sha256(content.encode()).hexdigest()

    return DatasetProfileV1(
        dataset_id=dataset_id or "auto_profiled",
        source_type="structured",
        content_hash=content_hash,
        tables=list(table_profiles.values()),
        relation_candidates=relations,
        user_hints=user_hints or {},
    )


def _infer_logical_types(values: list[Any]) -> list[str]:
    types = []
    sample = [v for v in values[:100] if v is not None]
    if not sample:
        return ["unknown"]

    if all(isinstance(v, (int, float)) or (isinstance(v, str) and v.replace(".", "").replace("-", "").isdigit())
           for v in sample):
        if all(isinstance(v, int) or (isinstance(v, float) and float(v) == int(float(v))) for v in sample if isinstance(v, (int, float))):
            types.append("integer")
        else:
            types.append("float")

    if all(isinstance(v, str) for v in sample):
        types.append("string")
        if all(re.match(r'^\d{4}-\d{2}-\d{2}', str(v)) for v in sample):
            types.append("date")
        if all(re.match(r'^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}', str(v)) for v in sample):
            types.append("datetime")
        if all(re.match(r'^[01]$', str(v)) for v in sample):
            types.append("boolean")
        if all(re.match(r'^[A-Z]{2,5}$', str(v)) for v in sample):
            types.append("categorical_code")

    return types or ["unknown"]


def _detect_value_patterns(values: list[Any]) -> list[str]:
    patterns = set()
    for v in values[:50]:
        s = str(v)
        if re.match(r'^\d{4}-\d{2}-\d{2}', s):
            patterns.add("YYYY-MM-DD")
        if re.match(r'^\d+\.\d{2}$', s):
            patterns.add("decimal.2")
        if re.match(r'^[A-Z]{2,5}$', s):
            patterns.add("UPPER_CODE")
        if "@" in s:
            patterns.add("email")
    return sorted(patterns)


def _mask_value(val: Any) -> str:
    s = str(val)
    if len(s) > 30:
        return s[:15] + "..." + s[-10:]
    return s


def _mask_samples(values: list[Any]) -> list[str]:
    return [_mask_value(v) for v in values[:5]]


def _py_type(val: Any) -> str:
    if val is None:
        return "null"
    return type(val).__name__


def _detect_relations(tables: dict[str, TableProfileV1]) -> list[dict]:
    relations = []
    table_ids = list(tables.keys())
    for i, t1 in enumerate(table_ids):
        cols1 = {c.column_name for c in tables[t1].columns}
        for t2 in table_ids[i + 1:]:
            cols2 = {c.column_name for c in tables[t2].columns}
            common = cols1 & cols2
            if common:
                # Check value overlap
                relations.append({
                    "table_a": t1, "table_b": t2,
                    "common_columns": list(common),
                    "relation_type": "potential_fk",
                })
    return relations
