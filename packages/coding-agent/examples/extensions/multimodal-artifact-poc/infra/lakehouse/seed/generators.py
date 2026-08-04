"""Deterministic seed-data generators for the local lakehouse.

Fixed random seed → identical output on every run. The generated world:

  - 60 consecutive days, START_DATE .. START_DATE+days-1 (default 2026-06-02)
  - 3 model versions: lr_v1 (baseline), lgb_v2 (impaired), xgb_v3 (strong)
  - N entities (default 10, scaled by --scale)
  - 4 features per entity per day

Implanted, verifiable anomalies (all reproducible from the seed):
  1. PSI > 0.25            — feature_debt_ratio distribution shifts on ANOMALY_DAY;
                             PSI computed deterministically (10 equal-width bins).
  2. AUC drop              — lgb_v2 auc 0.89±0.01 → 0.71±0.02 on ANOMALY_DAY.
  3. Feature missing rate  — feature_income rows missing from ANOMALY_DAY-2 (40%).
  4. Freshness anomaly     — prediction_points stops at FRESHNESS_CUTOFF (3 days stale).
  5. Distribution shift    — lgb_v2 oot label rate (bad rate) 0.35 → 0.55 on ANOMALY_DAY.

Causal story: upstream data-quality event (income feature missing) degrades the
income-dependent model (lgb_v2) → its AUC/KS drop and its score distribution
drifts (PSI > 0.25) → new-borrower bad rate rises.
"""
from __future__ import annotations

import math
import random
from datetime import date, timedelta
from typing import Any

import pyarrow as pa

START_DATE = date(2026, 6, 2)
DEFAULT_DAYS = 60
DEFAULT_ENTITIES = 10
DEFAULT_SEED = 42

# Anomaly timeline (relative to START_DATE)
ANOMALY_DAY = 32            # 2026-07-04: AUC drop / PSI shift / bad-rate shift
MISSING_START_DAY = 30      # 2026-07-02: feature_income starts going missing
FRESHNESS_CUTOFF_DAY = 56   # 2026-07-28: prediction_points stops (3 days stale)

MODELS = ("lr_v1", "lgb_v2", "xgb_v3")
FEATURES = ("feature_income", "feature_credit_score", "feature_debt_ratio", "feature_loan_amount")
LOAN_TYPES = ("mortgage", "personal", "auto", "credit_card")

# Baseline per-model metric levels (pre-anomaly)
MODEL_BASELINE = {
    "lr_v1":  {"auc": 0.845, "ks": 0.72, "lift_5": 1.9, "f1": 0.80},
    "lgb_v2": {"auc": 0.890, "ks": 0.78, "lift_5": 2.2, "f1": 0.85},
    "xgb_v3": {"auc": 0.920, "ks": 0.83, "lift_5": 2.4, "f1": 0.88},
}
# Impaired levels for lgb_v2 after ANOMALY_DAY
IMPAIRED = {"auc": 0.710, "ks": 0.55, "lift_5": 1.4, "f1": 0.72}


def day_date(day: int, start: date = START_DATE) -> date:
    return start + timedelta(days=day)


def date_str(d: date) -> str:
    return d.isoformat()


# ---------------------------------------------------------------------
# PSI (population stability index) — deterministic, 10 equal-width bins
# ---------------------------------------------------------------------

def psi(expected: list[float], actual: list[float], bins: int = 10) -> float:
    lo, hi = min(expected + actual), max(expected + actual)
    if hi == lo:
        return 0.0
    width = (hi - lo) / bins
    edges = [lo + width * i for i in range(bins + 1)]
    edges[-1] += 1e-9  # inclusive top edge

    def hist(vals: list[float]) -> list[int]:
        h = [0] * bins
        for v in vals:
            for i in range(bins):
                if edges[i] <= v < edges[i + 1]:
                    h[i] += 1
                    break
        return h

    e = hist(expected)
    a = hist(actual)
    total_e, total_a = len(expected), len(actual)
    out = 0.0
    for i in range(bins):
        pct_e = (e[i] / total_e) if total_e else 0.0
        pct_a = (a[i] / total_a) if total_a else 0.0
        if pct_e == 0.0 and pct_a == 0.0:
            continue
        if pct_e == 0.0:
            pct_e = 0.001
        if pct_a == 0.0:
            pct_a = 0.001
        out += (pct_a - pct_e) * math.log(pct_a / pct_e)
    return round(out, 4)


# ---------------------------------------------------------------------
# Generators — each returns (pyarrow.Table, stats: dict)
# ---------------------------------------------------------------------

def gen_loan_applications(rng: random.Random, entities: list[str], days: int) -> tuple[pa.Table, dict]:
    rows: list[dict[str, Any]] = []
    for day in range(days):
        d = day_date(day)
        for ent in entities:
            if rng.random() < 0.7:  # ~70% of entity-days have an application
                income = round(rng.gauss(78000, 22000), 2)
                if day >= MISSING_START_DAY and rng.random() < 0.4:
                    income = None  # missing income (the upstream quality event)
                rows.append({
                    "entity_id": ent,
                    "loan_amount": round(rng.gauss(120000, 45000), 2),
                    "annual_income": income,
                    "credit_score": int(rng.gauss(640, 60)),
                    "property_address": f"{rng.randint(1, 999)} Sample St, City {rng.randint(1, 20)}",
                    "loan_type": rng.choice(LOAN_TYPES),
                })
    return (
        pa.table({
            "entity_id": pa.array([r["entity_id"] for r in rows], type=pa.string()),
            "loan_amount": pa.array([r["loan_amount"] for r in rows], type=pa.float64()),
            "annual_income": pa.array([r["annual_income"] for r in rows], type=pa.float64()),
            "credit_score": pa.array([r["credit_score"] for r in rows], type=pa.int32()),
            "property_address": pa.array([r["property_address"] for r in rows], type=pa.string()),
            "loan_type": pa.array([r["loan_type"] for r in rows], type=pa.string()),
        }),
        {"rows": len(rows), "missingIncome": sum(1 for r in rows if r["annual_income"] is None)},
    )


def gen_feature_values(rng: random.Random, entities: list[str], days: int) -> tuple[pa.Table, dict]:
    rows: list[dict[str, Any]] = []
    missing_income_days = 0
    total_income_days = 0
    for day in range(days):
        d = date_str(day_date(day))
        for ent in entities:
            # feature_income: missing 40% from MISSING_START_DAY (anomaly)
            if day >= MISSING_START_DAY and rng.random() < 0.4:
                missing_income_days += 1
            else:
                total_income_days += 1
                rows.append({
                    "entity_id": ent, "feature_id": "feature_income",
                    "feature_value": round(rng.gauss(78_000, 22_000), 2), "event_time": d,
                })
            rows.append({
                "entity_id": ent, "feature_id": "feature_credit_score",
                "feature_value": float(rng.gauss(640, 60)), "event_time": d,
            })
            # feature_debt_ratio: distribution shifts on ANOMALY_DAY (PSI basis)
            mu = 0.42 if day < ANOMALY_DAY else 0.46
            rows.append({
                "entity_id": ent, "feature_id": "feature_debt_ratio",
                "feature_value": round(max(0.0, min(1.0, rng.gauss(mu, 0.07))), 4), "event_time": d,
            })
            rows.append({
                "entity_id": ent, "feature_id": "feature_loan_amount",
                "feature_value": round(rng.gauss(120_000, 45_000), 2), "event_time": d,
            })
    return (
        pa.table({
            "entity_id": [r["entity_id"] for r in rows],
            "feature_id": [r["feature_id"] for r in rows],
            "feature_value": [r["feature_value"] for r in rows],
            "event_time": [r["event_time"] for r in rows],
        }),
        {"rows": len(rows), "incomeTotal": total_income_days, "incomeMissing": missing_income_days},
    )


def gen_prediction_points(rng: random.Random, entities: list[str], days: int) -> tuple[pa.Table, dict]:
    """One prediction point per entity-day. Stops at FRESHNESS_CUTOFF_DAY.

    The oot bad rate (label=1) shifts 0.35 → 0.55 on ANOMALY_DAY for the
    impaired window (distribution drift observable without a score column —
    the schema has no prediction-score column; see expected_results blockers)."""
    rows: list[dict[str, Any]] = []
    oot_before_t, oot_before_p = 0, 0
    oot_after_t, oot_after_p = 0, 0
    for day in range(min(days, FRESHNESS_CUTOFF_DAY + 1)):
        d = date_str(day_date(day))
        split = rng.choice(("train", "validation", "oot"))
        for ent in entities:
            if split == "oot":
                p_pos = 0.35 if day < ANOMALY_DAY else 0.60
                label = 1.0 if rng.random() < p_pos else 0.0
                if day < ANOMALY_DAY:
                    oot_before_t += 1
                    oot_before_p += int(label)
                else:
                    oot_after_t += 1
                    oot_after_p += int(label)
            else:
                label = 1.0 if rng.random() < 0.32 else 0.0
            rows.append({
                "prediction_id": f"pred_{day:03d}_{ent}",
                "entity_id": ent,
                "prediction_time": d,
                "split": split,
                "label": label,
            })
    return (
        pa.table({
            "prediction_id": [r["prediction_id"] for r in rows],
            "entity_id": [r["entity_id"] for r in rows],
            "prediction_time": [r["prediction_time"] for r in rows],
            "split": [r["split"] for r in rows],
            "label": [r["label"] for r in rows],
        }),
        {"rows": len(rows), "lastDay": min(days, FRESHNESS_CUTOFF_DAY),
         "ootBefore": {"total": oot_before_t, "positive": oot_before_p,
                       "badRate": round(oot_before_p / oot_before_t, 4) if oot_before_t else 0.0},
         "ootAfter": {"total": oot_after_t, "positive": oot_after_p,
                      "badRate": round(oot_after_p / oot_after_t, 4) if oot_after_t else 0.0}},
    )


def gen_model_metrics(rng: random.Random, days: int) -> tuple[pa.Table, dict]:
    """Daily metrics per model. lgb_v2 impaired after ANOMALY_DAY."""
    rows: list[dict[str, Any]] = []
    for day in range(days):
        d = date_str(day_date(day))
        for model in MODELS:
            base = MODEL_BASELINE[model]
            impaired = (model == "lgb_v2" and day >= ANOMALY_DAY)
            noise = lambda: rng.gauss(0, 0.008)  # noqa: E731
            lvl = IMPAIRED if impaired else base
            rows.append({
                "model_name": model,
                "auc": round(min(1.0, lvl["auc"] + noise()), 4),
                "ks": round(min(1.0, lvl["ks"] + noise()), 4),
                "lift_5": round(max(1.0, lvl["lift_5"] + rng.gauss(0, 0.02)), 3),
                "f1": round(min(1.0, lvl["f1"] + noise()), 4),
                "created_at": d,
            })
    return (
        pa.table({
            "model_name": [r["model_name"] for r in rows],
            "auc": [r["auc"] for r in rows],
            "ks": [r["ks"] for r in rows],
            "lift_5": [r["lift_5"] for r in rows],
            "f1": [r["f1"] for r in rows],
            "created_at": [r["created_at"] for r in rows],
        }),
        {"rows": len(rows)},
    )


def gen_ocr_results(rng: random.Random) -> pa.Table:
    """Small EAV OCR payloads: includes id_number / id_card values (masked on
    query) and confidence scores. No parser_version / parse_status columns in
    the schema — reported as blockers."""
    images = ["identity_document", "payslip", "bank_statement"]
    fields = {
        "identity_document": [("name", "John Doe"), ("id_number", "AB12345"),
                              ("date_of_birth", "1990-05-14"), ("nationality", "CN")],
        "payslip": [("employer", "ACME Corp"), ("monthly_income", "8200"),
                    ("account_number", "6222 8800 1234 5678")],
        "bank_statement": [("account_number", "6222 8800 5678 1234"),
                           ("avg_balance", "15400"), ("statement_month", "2026-06")],
    }
    rows: list[dict[str, Any]] = []
    for i in range(15):
        img = rng.choice(images)
        for (fname, fval) in fields[img]:
            rows.append({
                "image_id": f"img_{i:03d}",
                "image_type": img,
                "field_name": fname,
                "field_value": fval,
                "confidence": round(rng.uniform(0.82, 0.99), 3),
                "processed_at": date_str(day_date(rng.randint(20, 59))),
            })
    return pa.table({
        "image_id": [r["image_id"] for r in rows],
        "image_type": [r["image_type"] for r in rows],
        "field_name": [r["field_name"] for r in rows],
        "field_value": [r["field_value"] for r in rows],
        "confidence": [r["confidence"] for r in rows],
        "processed_at": [r["processed_at"] for r in rows],
    })


def gen_pdf_parses(rng: random.Random) -> pa.Table:
    """Small PDF parse payloads (schema has no parser_version/parse_status —
    blocker reported in expected_results)."""
    types = ["loan_application", "credit_report", "employment_contract"]
    rows: list[dict[str, Any]] = []
    for i in range(10):
        rows.append({
            "document_id": f"doc_{i:03d}",
            "document_type": rng.choice(types),
            "applicant_name": rng.choice(["Zhang Wei", "Li Na", "Wang Fang", "Chen Jing", "Liu Yang"]),
            "loan_amount": str(rng.randint(50_000, 900_000)),
            "annual_income": str(rng.randint(60_000, 300_000)),
            "credit_score": str(rng.randint(550, 760)),
            "property_address": f"{rng.randint(1, 999)} Sample St, City {rng.randint(1, 20)}",
            "processed_at": date_str(day_date(rng.randint(20, 59))),
        })
    return pa.table({
        "document_id": [r["document_id"] for r in rows],
        "document_type": [r["document_type"] for r in rows],
        "applicant_name": [r["applicant_name"] for r in rows],
        "loan_amount": [r["loan_amount"] for r in rows],
        "annual_income": [r["annual_income"] for r in rows],
        "credit_score": [r["credit_score"] for r in rows],
        "property_address": [r["property_address"] for r in rows],
        "processed_at": [r["processed_at"] for r in rows],
    })


def gen_streaming_events(rng: random.Random) -> pa.Table:
    """Small event feed: NORMAL (recent event_time), DUPLICATE (same event_id
    delivered twice), LATE (event_time long before the batch window)."""
    rows: list[dict[str, Any]] = []
    # normal: last 7 days
    for i in range(20):
        rows.append({
            "event_id": f"evt_normal_{i:03d}",
            "event_type": rng.choice(("application_submitted", "feature_updated", "prediction_requested")),
            "source_table": "dws.feature_values",
            "entity_id": f"ent_{rng.randint(1, 10):03d}",
            "event_time": date_str(day_date(rng.randint(53, 59))),
            "payload_json": '{"source": "batch"}',
        })
    # duplicates: same event_id twice (5 events × 2)
    for i in range(5):
        eid = f"evt_dup_{i:03d}"
        t = date_str(day_date(rng.randint(50, 57)))
        for _ in range(2):
            rows.append({
                "event_id": eid,
                "event_type": "feature_updated",
                "source_table": "dws.feature_values",
                "entity_id": f"ent_{rng.randint(1, 10):03d}",
                "event_time": t,
                "payload_json": '{"source": "stream", "dup": true}',
            })
    # late: event_time long before the batch window (day 8-15)
    for i in range(5):
        rows.append({
            "event_id": f"evt_late_{i:03d}",
            "event_type": "application_submitted",
            "source_table": "ods.pdf_parse_result",
            "entity_id": f"ent_{rng.randint(1, 10):03d}",
            "event_time": date_str(day_date(rng.randint(8, 15))),
            "payload_json": '{"source": "late_delivery"}',
        })
    return pa.table({
        "event_id": [r["event_id"] for r in rows],
        "event_type": [r["event_type"] for r in rows],
        "source_table": [r["source_table"] for r in rows],
        "entity_id": [r["entity_id"] for r in rows],
        "event_time": [r["event_time"] for r in rows],
        "payload_json": [r["payload_json"] for r in rows],
    })
