"""Schema Discovery — deterministic profiling of a source dataset.

Produces SourceSchemaProfile with candidate keys that carry EVIDENCE and
CONFIDENCE — a sampled uniqueness ratio never auto-promotes a key to the
primary key. The primary key is chosen by the agent + approved by a human.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

SENSITIVE_HINTS = (
    "id_number", "id_card", "passport", "password", "secret", "token",
    "ssn", "phone", "mobile", "address", "account_no", "card_no", "bank",
)


def sha256_str(text: str) -> str:
    import hashlib
    return f"sha256:{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


def _field_type(pa_type: Any) -> str:
    import pyarrow as pa
    if pa.types.is_string(pa_type):
        return "string"
    if pa.types.is_integer(pa_type):
        return "long"
    if pa.types.is_floating(pa_type):
        return "double"
    if pa.types.is_boolean(pa_type):
        return "boolean"
    if pa.types.is_timestamp(pa_type) or pa.types.is_date(pa_type):
        return "timestamp"
    return "string"


def _field_names_lower(name: str) -> str:
    return name.lower().replace("_", "").replace("-", "")


def detect_sensitive(name: str) -> bool:
    n = _field_names_lower(name)
    return any(h in n for h in SENSITIVE_HINTS)


def detect_event_time(name: str) -> bool:
    n = _field_names_lower(name)
    return any(k in n for k in ("eventtime", "timestamp", "date", "time", "createdat", "updatedat"))


def profile_parquet(path: Path, sample_limit: int = 100_000) -> dict:
    """Deterministic profile of a parquet file (bounded sample).

    The profile always records sampleInfo so consumers know whether candidate
    key evidence is full-scan or sampled. Empty tables and tiny samples are
    handled safely: no division by zero, and sampled candidates never carry
    high confidence.
    """
    table = pq.read_table(path)
    schema = table.schema
    total_rows = table.num_rows
    sampled = table.slice(0, sample_limit) if table.num_rows > sample_limit else table
    sampled_rows = sampled.num_rows
    full_scan = sampled_rows == total_rows

    fields = []
    null_rates: dict[str, float] = {}
    cardinality: dict[str, int] = {}
    candidate_event_times: list[str] = []
    sensitive_candidates: list[str] = []

    for field in schema:
        name = field.name
        col = sampled.column(name)
        nulls = col.null_count or 0
        null_rates[name] = round(nulls / sampled_rows, 4) if sampled_rows else 0.0
        # cardinality via unique count on the sample (bounded)
        try:
            cardinality[name] = len(col.unique())
        except Exception:
            cardinality[name] = 0
        fields.append({
            "name": name,
            "type": _field_type(field.type),
            "nullability": "NULLABLE" if nulls > 0 else "NOT_NULL",
        })
        if detect_event_time(name):
            candidate_event_times.append(name)
        if detect_sensitive(name):
            sensitive_candidates.append(name)

    # candidate keys: single-field, sampled uniqueness + non-null + cardinality.
    # Small samples get a confidence discount; full-scan evidence is flagged.
    candidate_keys = []
    for name in schema.names:
        col = sampled.column(name)
        n = sampled_rows
        if n == 0:
            continue
        nulls = col.null_count or 0
        non_null = n - nulls
        non_null_ratio = non_null / n
        uniq = cardinality.get(name, 0)
        uniqueness_ratio = uniq / non_null if non_null else 0.0
        if non_null_ratio >= 0.95 and uniqueness_ratio >= 0.95 and uniq >= 2:
            confidence = round((non_null_ratio + uniqueness_ratio) / 2, 4)
            # sample discount: sampled evidence is weaker than full-scan
            if not full_scan:
                confidence = round(confidence * 0.9, 4)
            candidate_keys.append({
                "fields": [name],
                "confidence": confidence,
                "evidence": {
                    "uniquenessRatio": round(uniqueness_ratio, 4),
                    "nonNullRatio": round(non_null_ratio, 4),
                    "cardinality": uniq,
                },
                "sampleRows": n,
                "fullScanVerified": full_scan,
                "evidenceRefs": [f"sample:{path.name}"],
            })

    profile = {
        "datasetId": str(path.parent.name),
        # schemaHash covers the FULL physical schema (name + type + nullability
        # in field order) — two schemas differing in type/nullability/order
        # produce different hashes.
        "schemaHash": sha256_str(json.dumps(fields, sort_keys=True, ensure_ascii=False)),
        "fields": fields,
        "candidateKeys": candidate_keys,
        "candidateEventTimes": candidate_event_times,
        "rowCount": total_rows,
        "nullRates": null_rates,
        "cardinality": cardinality,
        "sensitiveFieldCandidates": sensitive_candidates,
        "partitionStats": {},
        "sampleInfo": {
            "totalRows": total_rows,
            "sampledRows": sampled_rows,
            "sampleLimit": sample_limit,
            "fullScan": full_scan,
            "samplingMethod": "head" if not full_scan else "full",
        },
        "profiledAt": datetime.now(timezone.utc).isoformat(),
    }
    return profile
