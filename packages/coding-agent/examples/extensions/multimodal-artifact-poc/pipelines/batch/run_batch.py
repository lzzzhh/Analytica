"""Batch pipeline — deterministic source generation + ODS→DWD→DWS→ADS.

Run: python3 -m pipelines.run --mode batch --profile small [--reset]
"""
from __future__ import annotations

import random
from typing import Any

import pyarrow.parquet as pq

from pipelines.common.config import (
    PipelineConfig,
    ensure_namespaces,
    open_catalog,
    profile_params,
)
from pipelines.common.generators import (
    gen_feature_inputs,
    gen_loan_applications,
    gen_model_metric_inputs,
    gen_prediction_inputs,
    write_source_manifest,
)
from pipelines.common.manifests import ExecutionManifest, layer_record
from pipelines.batch.stages import build_ads, build_dwd, build_dws, load_ods, read_parquet_sources

SOURCE_NAMES = ["loan_applications", "feature_inputs", "prediction_inputs", "model_metric_inputs"]

TARGET_TABLES = (
    "ods.loan_applications_raw",
    "ods.feature_inputs_raw",
    "ods.prediction_inputs_raw",
    "ods.model_metric_inputs_raw",
    "dwd.loan_application_detail",
    "dws.feature_values",
    "dws.prediction_points",
    "ads.model_metrics",
)


def generate_batch_sources(cfg: PipelineConfig, days: int, entities: list[str], seed: int,
                           run_id: str) -> dict[str, dict]:
    """Generate immutable parquet inputs under source/batch/<name>/."""
    rng = random.Random(seed)
    gen = {
        "loan_applications": gen_loan_applications(rng, entities, days),
        "feature_inputs": gen_feature_inputs(rng, entities, days),
        "prediction_inputs": gen_prediction_inputs(rng, entities, days),
        "model_metric_inputs": gen_model_metric_inputs(rng, days, entities),
    }
    entries = []
    for name, rows in gen.items():
        dir_ = cfg.batch_source_dir / name
        dir_.mkdir(parents=True, exist_ok=True)
        path = dir_ / "data.parquet"
        # immutable: only write when absent (or --reset)
        if not path.exists() or cfg.reset:
            pq.write_table(_rows_to_table(rows, name), path)
            from pipelines.common.config import sha256_file
            entries.append({
                "name": name,
                "path": str(path.relative_to(cfg.root)),
                "rows": len(rows),
                "contentHash": sha256_file(path),
            })
    write_source_manifest(cfg.batch_source_dir, entries, run_id)
    return {e["name"]: e for e in entries}


def _rows_to_table(rows: list[dict], name: str):
    import pyarrow as pa
    return pa.Table.from_pylist(rows)


def run_batch(cfg: PipelineConfig, gate: Any) -> ExecutionManifest:
    """Run the batch pipeline. When a WriteGate is supplied every layer write
    is validated against the gate (sealed approval + controlled target + CDXR
    promotion for dws/ads) — governance-managed runs must pass a gate."""
    if gate is None:
        raise PermissionError("WriteGate authorization is required before pipeline execution")
    approvals = {target: gate.require_approved(target) for target in TARGET_TABLES}

    params = profile_params(cfg.profile)
    days = params["days"]
    entities = [f"ent_{i:03d}" for i in range(1, params["entities"] + 1)]
    seed = 42
    batch_id = f"batch_{cfg.run_id}"

    manifest = ExecutionManifest(
        run_id=cfg.run_id,
        mode=cfg.mode,
        profile=cfg.profile,
        warehouse=str(cfg.warehouse),
        config={"days": days, "entities": len(entities), "seed": seed, "batchId": batch_id},
    )

    try:
        cfg.ensure_dirs()
        # 1. generate sources (immutable)
        sources_meta = generate_batch_sources(cfg, days, entities, seed, cfg.run_id)
        manifest.config["sources"] = sources_meta

        # 2. open catalog (test warehouse only)
        catalog = open_catalog(cfg.warehouse)
        ensure_namespaces(catalog)

        if cfg.reset:
            # reset rebuilds the pipeline tables (idempotent clean start)
            for table in list(TARGET_TABLES):
                try:
                    catalog.drop_table(table)
                except Exception:
                    pass

        # 3. read sources → ODS → DWD → DWS → ADS
        sources = read_parquet_sources(cfg, SOURCE_NAMES)
        ods = load_ods(cfg, catalog, sources, batch_id, gate, approvals)
        for table, rec in ods.items():
            manifest.layers[f"ods:{table}"] = layer_record(table, rec["inputRows"], rec["outputRows"], rec["snapshotId"])

        dwd = build_dwd(cfg, catalog, sources, batch_id, gate, approvals)
        for table, rec in dwd.items():
            manifest.layers[f"dwd:{table}"] = layer_record(table, rec["inputRows"], rec["outputRows"], rec["snapshotId"])

        dws = build_dws(cfg, catalog, sources, batch_id, gate, approvals)
        for table, rec in dws.items():
            manifest.layers[f"dws:{table}"] = layer_record(table, rec["inputRows"], rec["outputRows"], rec["snapshotId"])

        ads = build_ads(cfg, catalog, sources, batch_id, gate, approvals)
        for table, rec in ads.items():
            manifest.layers[f"ads:{table}"] = layer_record(table, rec["inputRows"], rec["outputRows"], rec["snapshotId"])

        manifest.success = True
    except Exception as e:  # noqa: BLE001
        manifest.success = False
        manifest.error = f"{type(e).__name__}: {e}"
        raise

    manifest.write(cfg)
    return manifest
