"""Pipeline common — source generation helpers and contracts.

Deterministic input generation (fixed seed, fixed date range, configurable
days/scale, known anomalies). Input files are immutable once written; source
manifests record content hashes.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

from pipelines.common.config import sha256_file, write_json

START_DATE = date(2026, 5, 1)
ANOMALY_DAY = 15  # index into the day range where anomalies start

DEFAULT_ENTITIES = 100


def day_date(day: int, start: date = START_DATE) -> date:
    return start + timedelta(days=day - 1)


def date_str(d: date) -> str:
    return d.isoformat()


@dataclass
class GeneratedSource:
    name: str  # e.g. loan_applications
    path: Path  # parquet file
    rows: int
    content_hash: str
    columns: list[str]
    manifest: dict


def write_source_manifest(source_dir: Path, entries: list[dict], run_id: str) -> dict:
    manifest = {
        "runId": run_id,
        "generatedAt": None,  # filled by caller if needed
        "entries": entries,
    }
    path = source_dir / "source-manifest.json"
    write_json(path, manifest)
    return manifest


def _hash_rows(rows: list[dict]) -> str:
    import hashlib
    return hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()


def write_parquet(path: Path, rows: list[dict], schema_columns: list[str]) -> GeneratedSource:
    """Write rows as a pyarrow parquet file; returns source metadata."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    path.parent.mkdir(parents=True, exist_ok=True)
    arrays = {}
    for col in schema_columns:
        values = [r.get(col) for r in rows]
        arrays[col] = pa.array(values)
    table = pa.Table.from_pydict(arrays)
    pq.write_table(table, path)
    return GeneratedSource(
        name=path.stem,
        path=path,
        rows=len(rows),
        content_hash=_hash_rows(rows),
        columns=schema_columns,
        manifest={},
    )


# ---------------------------------------------------------------------------
# Batch source generators (deterministic)
# ---------------------------------------------------------------------------

def gen_loan_applications(rng: random.Random, entities: list[str], days: int) -> list[dict]:
    """Loan application raw inputs. Includes: normal rows, a duplicated
    application_id (dedup scenario), and a null borrower_score row."""
    rows: list[dict] = []
    dup_id = "app_dup_001"
    dup_written = False
    for day in range(1, days + 1):
        d = date_str(day_date(day))
        for i, ent in enumerate(entities):
            app_id = f"app_{ent}_{day:03d}_{i % 7:02d}"
            row = {
                "application_id": app_id,
                "entity_id": ent,
                "event_time": d,
                "loan_amount": rng.randint(5000, 200000),
                "borrower_score": rng.randint(300, 850),
                "channel": rng.choice(("app", "web", "branch")),
                "status": rng.choice(("approved", "rejected", "pending")),
            }
            rows.append(row)
            # duplicate: the same application_id delivered twice (dedup scenario)
            if not dup_written and len(rows) % 97 == 0:
                rows.append({**row})
                dup_written = True
        if day == ANOMALY_DAY + 3:
            # anomaly: a batch of null borrower_score rows (missingness)
            for _ in range(5):
                rows.append({
                    "application_id": f"app_null_{day}_{_}_{rng.randint(0, 99)}",
                    "entity_id": f"ent_{rng.randint(1, min(len(entities), 10)):03d}",
                    "event_time": d,
                    "loan_amount": rng.randint(5000, 200000),
                    "borrower_score": None,
                    "channel": "branch",
                    "status": "pending",
                })
    return rows


def gen_feature_inputs(rng: random.Random, entities: list[str], days: int) -> list[dict]:
    """Feature inputs: 4 features per entity per day. After ANOMALY_DAY the
    debt_ratio feature drifts (distribution shift) and missingness rises."""
    features = ["feature_debt_ratio", "feature_income", "feature_credit_util", "feature_loan_age"]
    rows: list[dict] = []
    for day in range(1, days + 1):
        d = date_str(day_date(day))
        for ent in entities:
            for fid in features:
                if day >= ANOMALY_DAY:
                    if fid == "feature_debt_ratio":
                        # drift: +0.2 after anomaly day
                        base = 0.5 + rng.uniform(-0.1, 0.1) + 0.2
                    else:
                        base = 0.5 + rng.uniform(-0.15, 0.15)
                    missing = rng.random() < 0.08  # missingness rises
                else:
                    base = 0.5 + rng.uniform(-0.1, 0.1)
                    missing = rng.random() < 0.01
                rows.append({
                    "entity_id": ent,
                    "feature_id": fid,
                    "event_time": d,
                    "feature_value": None if missing else round(max(0.0, base), 4),
                    "source": "batch",
                })
    return rows


def gen_prediction_inputs(rng: random.Random, entities: list[str], days: int) -> list[dict]:
    """Prediction points: daily prediction per entity; stops 3 days early
    (freshness anomaly) and includes a model flag."""
    rows: list[dict] = []
    for day in range(1, days - 2 + 1):  # stops 2 days before the end
        d = date_str(day_date(day))
        for ent in entities:
            rows.append({
                "entity_id": ent,
                "event_time": d,
                "prediction": round(rng.uniform(0, 1), 4),
                "model_id": "lgb_v2" if day >= ANOMALY_DAY else "lgb_v1",
                "score_version": f"v{1 + (day // 20)}",
            })
    return rows


def gen_model_metric_inputs(rng: random.Random, days: int, entities: list[str]) -> list[dict]:
    """Model metric inputs: daily AUC per model. lgb_v2 AUC drops after
    ANOMALY_DAY (AUC decline scenario)."""
    rows: list[dict] = []
    for day in range(1, days + 1):
        d = date_str(day_date(day))
        for model_id, base_auc in (("lgb_v1", 0.82), ("lgb_v2", 0.85)):
            if model_id == "lgb_v2" and day >= ANOMALY_DAY:
                auc = base_auc - 0.03 - (day - ANOMALY_DAY) * 0.002  # steady decline
            else:
                auc = base_auc + rng.uniform(-0.01, 0.01)
            rows.append({
                "model_id": model_id,
                "metric_date": d,
                "auc": round(max(0.5, auc), 4),
                "sample_count": rng.randint(5000, 20000),
            })
    return rows


# ---------------------------------------------------------------------------
# Stream event generator (deterministic)
# ---------------------------------------------------------------------------

def gen_stream_events(rng: random.Random, n_normal: int = 60, n_dup: int = 6,
                      n_late: int = 4, n_too_late: int = 3, n_invalid: int = 2,
                      n_out_of_order: int = 3) -> list[dict]:
    """Event feed with known scenarios:
      - normal events (recent event_time)
      - duplicates (same event_id twice)
      - late events (within watermark, accepted)
      - too-late events (beyond watermark, dead letter)
      - invalid schema events (dead letter)
      - out-of-order events (event_time earlier than preceding, still within watermark)
    """
    events: list[dict] = []
    now = date(2026, 7, 30)

    def ev(event_id: str, days_back: int, **extra) -> dict:
        return {
            "event_id": event_id,
            "event_type": rng.choice(("application_submitted", "feature_updated", "prediction_requested")),
            "source_table": "dws.feature_values",
            "entity_id": f"ent_{rng.randint(1, 30):03d}",
            "event_time": date_str(now - timedelta(days=days_back)),
            "payload_json": json.dumps({"source": "stream"}),
            **extra,
        }

    # normal: last 5 days, grouped by day in ascending event_time (day-4
    # first, day-0 last) so the watermark advances monotonically; only the
    # implanted late/too-late events trigger those classifications.
    for i in range(n_normal):
        days_back = 4 - (i // (n_normal // 5) if n_normal % 5 == 0 else (i * 5) // n_normal)
        events.append(ev(f"evt_normal_{i:03d}", days_back))
    # duplicates: same event_id twice, 2 days back
    for i in range(n_dup):
        eid = f"evt_dup_{i:03d}"
        t = rng.randint(1, 3)
        events.append(ev(eid, t))
        events.append(ev(eid, t))
    # late (within watermark window): 3-4 days back — older than the max seen
    # (day 0) by more than the reordering tolerance but still inside the 5-day
    # watermark window, so it is accepted and counted as late.
    for i in range(n_late):
        events.append(ev(f"evt_late_{i:03d}", rng.randint(3, 4)))
    # too-late (beyond watermark): 12+ days back
    for i in range(n_too_late):
        events.append(ev(f"evt_too_late_{i:03d}", rng.randint(12, 20)))
    # out-of-order: emitted after a newer event, still within tolerance
    for i in range(n_out_of_order):
        events.append(ev(f"evt_ooo_{i:03d}", rng.randint(2, 6)))
    # invalid schema: missing event_id / bad event_time
    events.append({
        "event_id": None,
        "event_type": "application_submitted",
        "source_table": "x",
        "entity_id": "ent_001",
        "event_time": date_str(now - timedelta(days=1)),
        "payload_json": "{}",
    })
    events.append({
        "event_id": "evt_bad_time",
        "event_type": "feature_updated",
        "source_table": "x",
        "entity_id": "ent_002",
        "event_time": "not-a-date",
        "payload_json": "{}",
    })
    return events


def write_events_jsonl(path: Path, events: list[dict]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    return sha256_file(path)
