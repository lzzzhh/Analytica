#!/usr/bin/env python3
"""Deterministic seed loader for the local lakehouse (demo + regression).

Loads the seeded world into .data/warehouse (pyiceberg SQL catalog):

    dwd.loan_application_detail   — 60d × N entities loan applications
    dws.feature_values            — 4 features × entity × day (anomalies inside)
    dws.prediction_points         — daily prediction points (stops 3d early)
    ads.model_metrics             — daily AUC/KS/lift/F1 per model (lgb_v2 impaired)
    ods.ocr_result / ods.pdf_parse_result — small EAV payloads (masking demo)
    ods.streaming_events          — normal + duplicate + late events

CLI:
    --reset   wipe .data/warehouse and re-migrate the original tables first
    --seed    random seed (default 42; fixed → reproducible)
    --days    number of days (default 60)
    --scale   entity multiplier (default 1 → 10 entities)

Writes expected_results.json next to this file with all ground truths.

Note: --reset re-runs the original-warehouse migration (read-only against the
source) so the migrated base tables are regenerated with ABSOLUTE paths.
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from datetime import date, timedelta
from pathlib import Path

SEED_DIR = Path(__file__).resolve().parent
POC_ROOT = SEED_DIR.parents[2]                    # .../multimodal-artifact-poc
GW_DIR = POC_ROOT / "services" / "lakehouse-gateway"
WAREHOUSE = POC_ROOT / ".data" / "warehouse"
EXPECTED_PATH = SEED_DIR / "expected_results.json"

sys.path.insert(0, str(GW_DIR))
sys.path.insert(0, str(SEED_DIR))

from pyiceberg.catalog import load_catalog  # noqa: E402

from generators import (  # noqa: E402
    ANOMALY_DAY, DEFAULT_DAYS, DEFAULT_ENTITIES, DEFAULT_SEED,
    FEATURES, FRESHNESS_CUTOFF_DAY, IMPAIRED, MISSING_START_DAY, MODELS,
    MODEL_BASELINE, START_DATE, day_date, date_str, gen_feature_values,
    gen_loan_applications, gen_model_metrics, gen_ocr_results, gen_pdf_parses,
    gen_prediction_points, gen_streaming_events, psi,
)


def open_catalog():
    WAREHOUSE.mkdir(parents=True, exist_ok=True)
    return load_catalog(
        "lakehouse", type="sql",
        uri=f"sqlite:///{WAREHOUSE / '.lakehouse-catalog.db'}",
        warehouse=str(WAREHOUSE),
    )


def append(catalog, full_name: str, table) -> int:
    t = catalog.load_table(full_name)
    t.append(table)
    snap = t.current_snapshot()
    return snap.snapshot_id if snap else 0


def load(catalog, days: int, scale: int, seed: int) -> dict:
    rng = random.Random(seed)
    entities = [f"ent_{i:03d}" for i in range(1, DEFAULT_ENTITIES * scale + 1)]

    # ---- target tables -------------------------------------------------
    loans, loan_stats = gen_loan_applications(rng, entities, days)
    snap_loans = append(catalog, "dwd.loan_application_detail", loans)

    features, feat_stats = gen_feature_values(rng, entities, days)
    snap_features = append(catalog, "dws.feature_values", features)

    preds, pred_stats = gen_prediction_points(rng, entities, days)
    snap_preds = append(catalog, "dws.prediction_points", preds)

    metrics, _ = gen_model_metrics(rng, days)
    snap_metrics = append(catalog, "ads.model_metrics", metrics)

    # ---- small payload tables ------------------------------------------
    ocr = gen_ocr_results(rng)
    snap_ocr = append(catalog, "ods.ocr_result", ocr)
    pdfs = gen_pdf_parses(rng)
    snap_pdfs = append(catalog, "ods.pdf_parse_result", pdfs)
    events = gen_streaming_events(rng)
    snap_events = append(catalog, "ods.streaming_events", events)

    # ---- anomaly metrics (ground truth, deterministic) -----------------
    # PSI on feature_debt_ratio: before vs after ANOMALY_DAY (10 bins)
    feat_rows = features.to_pylist()
    debt_before = [r["feature_value"] for r in feat_rows
                   if r["feature_id"] == "feature_debt_ratio"
                   and r["event_time"] < date_str(day_date(ANOMALY_DAY))]
    debt_after = [r["feature_value"] for r in feat_rows
                  if r["feature_id"] == "feature_debt_ratio"
                  and r["event_time"] >= date_str(day_date(ANOMALY_DAY))]
    psi_value = psi(debt_before, debt_after)

    # AUC before/after for lgb_v2 (deterministic from generated data)
    m_rows = metrics.to_pylist()
    lgb = [r for r in m_rows if r["model_name"] == "lgb_v2"]
    auc_before = [r["auc"] for r in lgb if r["created_at"] < date_str(day_date(ANOMALY_DAY))]
    auc_after = [r["auc"] for r in lgb if r["created_at"] >= date_str(day_date(ANOMALY_DAY))]

    # income missing rate before/after MISSING_START_DAY
    # expected rows if nothing missing: entity-days × the income feature
    income_expected_before = MISSING_START_DAY * len(entities)
    income_expected_after = (days - MISSING_START_DAY) * len(entities)
    income_present = [r["event_time"] for r in feat_rows if r["feature_id"] == "feature_income"]
    income_before = sum(1 for t in income_present if t < date_str(day_date(MISSING_START_DAY)))
    income_after = sum(1 for t in income_present if t >= date_str(day_date(MISSING_START_DAY)))
    missing_before = 1 - income_before / max(1, income_expected_before)
    missing_after = 1 - income_after / max(1, income_expected_after)

    return {
        "snapshots": {
            "dwd.loan_application_detail": snap_loans,
            "dws.feature_values": snap_features,
            "dws.prediction_points": snap_preds,
            "ads.model_metrics": snap_metrics,
            "ods.ocr_result": snap_ocr,
            "ods.pdf_parse_result": snap_pdfs,
            "ods.streaming_events": snap_events,
        },
        "rowCounts": {
            "dwd.loan_application_detail": loans.num_rows,
            "dws.feature_values": features.num_rows,
            "dws.prediction_points": preds.num_rows,
            "ads.model_metrics": metrics.num_rows,
            "ods.ocr_result": ocr.num_rows,
            "ods.pdf_parse_result": pdfs.num_rows,
            "ods.streaming_events": events.num_rows,
        },
        "anomalyMetrics": {
            "psi": psi_value,
            "aucBefore": {"min": round(min(auc_before), 4), "max": round(max(auc_before), 4),
                          "mean": round(sum(auc_before) / len(auc_before), 4)},
            "aucAfter": {"min": round(min(auc_after), 4), "max": round(max(auc_after), 4),
                         "mean": round(sum(auc_after) / len(auc_after), 4)},
            "incomeMissingRate": {"before": round(missing_before, 4), "after": round(missing_after, 4)},
            "ootBadRateBefore": pred_stats["ootBefore"]["badRate"],
            "ootBadRateAfter": pred_stats["ootAfter"]["badRate"],
        },
    }


def write_expected(metrics: dict, days: int, scale: int, seed: int) -> dict:
    anom = metrics["anomalyMetrics"]
    expected = {
        "generatedAt": date.today().isoformat(),
        "seed": seed,
        "days": days,
        "entities": DEFAULT_ENTITIES * scale,
        "dateRange": {"start": date_str(START_DATE), "end": date_str(day_date(days - 1))},
        "anomalyStartDate": date_str(day_date(ANOMALY_DAY)),
        "missingStartDate": date_str(day_date(MISSING_START_DAY)),
        "freshnessCutoffDate": date_str(day_date(FRESHNESS_CUTOFF_DAY)),
        "models": list(MODELS),
        "impairedModel": "lgb_v2",
        "features": list(FEATURES),
        "rowCounts": metrics["rowCounts"],
        "snapshots": metrics["snapshots"],
        "anomalies": {
            "psi_above_0.25": {
                "model": "lgb_v2",
                "startDate": date_str(day_date(ANOMALY_DAY)),
                "basis": "feature_debt_ratio distribution, 10 equal-width bins (deterministic)",
                "computedValue": anom["psi"],
                "threshold": 0.25,
                "expectation": "computedValue > 0.25",
            },
            "auc_drop": {
                "model": "lgb_v2",
                "startDate": date_str(day_date(ANOMALY_DAY)),
                "aucBefore": anom["aucBefore"],
                "aucAfter": anom["aucAfter"],
                "expectation": "aucAfter.mean < aucBefore.mean - 0.10",
            },
            "feature_missing_rate": {
                "feature": "feature_income",
                "startDate": date_str(day_date(MISSING_START_DAY)),
                "missingRateBefore": anom["incomeMissingRate"]["before"],
                "missingRateAfter": anom["incomeMissingRate"]["after"],
                "expectation": "missingRateAfter - missingRateBefore > 0.30",
            },
            "freshness": {
                "dataset": "dws.prediction_points",
                "lastDataDate": date_str(day_date(FRESHNESS_CUTOFF_DAY)),
                "expectedLatestDate": date_str(day_date(days - 1)),
                "staleDays": days - 1 - FRESHNESS_CUTOFF_DAY,
                "expectation": "lastDataDate < expectedLatestDate (stale >= 1 day)",
            },
            "prediction_distribution_shift": {
                "model": "lgb_v2",
                "startDate": date_str(day_date(ANOMALY_DAY)),
                "observation": "oot bad rate (label=1 share) rises after anomaly day",
                "ootBadRateBefore": anom["ootBadRateBefore"],
                "ootBadRateAfter": anom["ootBadRateAfter"],
                "expectation": "ootBadRateAfter - ootBadRateBefore >= 0.15",
            },
        },
        "quality": {
            "ads.model_metrics": "PASS",
            "dws.feature_values": "WARN (feature_income elevated missing rate after %s)" % date_str(day_date(MISSING_START_DAY)),
            "dws.prediction_points": "PASS",
            "dwd.loan_application_detail": "PASS",
        },
        "blockers": [
            {"table": "ads.model_metrics",
             "issue": "no psi column in schema; PSI provided as a derived metric from feature_debt_ratio distribution (see anomalies.psi_above_0.25). Adding a psi column requires a schema change (not done)."},
            {"table": "ods.ocr_result / ods.pdf_parse_result",
             "issue": "no parser_version / parse_status columns; only confidence (ocr_result) is expressible. parser version/status require a schema change (not done)."},
            {"table": "dws.prediction_points",
             "issue": "no prediction-score column; distribution shift observed via oot label (bad rate) and feature distributions."},
        ],
    }
    EXPECTED_PATH.write_text(json.dumps(expected, indent=2, ensure_ascii=False), encoding="utf-8")
    return expected


def reset_warehouse() -> None:
    """Wipe .data/warehouse and re-migrate the original tables (absolute paths)."""
    if WAREHOUSE.exists():
        shutil.rmtree(WAREHOUSE)
    WAREHOUSE.mkdir(parents=True, exist_ok=True)
    migrate = GW_DIR / "scripts" / "migrate_warehouse.py"
    source = Path("/Users/zhanhuilin/Documents/风控大数据/LeakBench-RiskCloud/data/warehouse")
    import subprocess
    r = subprocess.run(
        [sys.executable, str(migrate), "--source", str(source), "--target", str(WAREHOUSE)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"migration failed: {r.stderr[-500:]}")


def main() -> int:
    ap = argparse.ArgumentParser(description="deterministic lakehouse seed loader")
    ap.add_argument("--reset", action="store_true", help="wipe warehouse + re-migrate original tables first")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS)
    ap.add_argument("--scale", type=int, default=1, help="entity multiplier")
    args = ap.parse_args()

    if args.reset:
        print("--reset: wiping warehouse and re-migrating original tables...")
        reset_warehouse()

    catalog = open_catalog()
    metrics = load(catalog, days=args.days, scale=args.scale, seed=args.seed)
    expected = write_expected(metrics, days=args.days, scale=args.scale, seed=args.seed)

    print(f"seed={args.seed} days={args.days} scale={args.scale} entities={expected['entities']}")
    print(f"warehouse: {WAREHOUSE}")
    for t, n in expected["rowCounts"].items():
        print(f"  {t:<35} {n:>6} rows  snapshot={expected['snapshots'][t]}")
    a = expected["anomalies"]
    print(f"\nanomalies:")
    print(f"  PSI(lgb_v2)  = {a['psi_above_0.25']['computedValue']} (> 0.25? {a['psi_above_0.25']['computedValue'] > 0.25})")
    print(f"  AUC lgb_v2   = {a['auc_drop']['aucBefore']['mean']} -> {a['auc_drop']['aucAfter']['mean']}")
    print(f"  income miss  = {a['feature_missing_rate']['missingRateBefore']:.1%} -> {a['feature_missing_rate']['missingRateAfter']:.1%}")
    print(f"  freshness    = last data {a['freshness']['lastDataDate']} (stale {a['freshness']['staleDays']}d)")
    print(f"  oot bad rate = {a['prediction_distribution_shift']['ootBadRateBefore']} -> {a['prediction_distribution_shift']['ootBadRateAfter']}")
    print(f"\nexpected_results.json -> {EXPECTED_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
