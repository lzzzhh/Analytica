"""Engine backend tests — real PySpark / PyFlink execution vs local baseline.

Spark runs for real (local[2]) in this interpreter (pyspark).
Flink runs only when pyflink is importable (Python <= 3.12); otherwise the
flink tests are skipped (engine_available probe) — the flink smoke is run
separately with the 3.11 interpreter.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pyarrow as pa
import pytest

from pipelines.batch.engine import (
    ENGINE_FLINK,
    ENGINE_LOCAL,
    ENGINE_SPARK,
    engine_available,
    flink_compute_layers,
    spark_compute_layers,
)
from pipelines.batch.run_batch import generate_batch_sources
from pipelines.batch.stages import read_parquet_sources
from pipelines.common.config import PipelineConfig, new_batch_id, profile_params
from pipelines.common.manifests import ExecutionManifest
from pipelines.tests.helpers import TestOnlyWriteGate


@pytest.fixture(scope="module")
def sources(tmp_path_factory) -> dict[str, pa.Table]:
    root = tmp_path_factory.mktemp("engine-src")
    cfg = PipelineConfig(root=root, mode="batch", profile="small")
    params = profile_params("small")
    entities = [f"ent_{i:03d}" for i in range(1, params["entities"] + 1)]
    cfg.ensure_dirs()
    generate_batch_sources(cfg, params["days"], entities, 42, "engine-test-run")
    return read_parquet_sources(cfg, list(
        __import__("pipelines.batch.stages", fromlist=["SOURCE_TO_RAW"]).SOURCE_TO_RAW))


def _rows(layers: dict) -> dict[str, int]:
    return {name: rec["outputRows"] for name, rec in layers.items()}


def _local_baseline_layers(sources) -> dict[str, int]:
    """The local engine defines the layer contract (via run_batch manifest)."""
    import pyarrow.parquet as pq
    from pipelines.batch.run_batch import run_batch
    from pipelines.common.config import open_catalog

    root = Path(__import__("tempfile").mkdtemp(prefix="engine-local-"))
    cfg = PipelineConfig(root=root, mode="batch", profile="small")
    manifest = run_batch(cfg, TestOnlyWriteGate())
    assert manifest.success
    rows = {}
    for key, rec in manifest.layers.items():
        table = rec["table"].split(".")[-1]
        rows[rec["table"]] = rec["outputRows"]
    # every target table present
    assert set(rows) >= {
        "ods.loan_applications_raw", "dwd.loan_application_detail",
        "dws.feature_values", "dws.prediction_points", "ads.model_metrics",
    }
    shutil.rmtree(root, ignore_errors=True)
    return rows


def test_local_baseline_layers(sources) -> None:
    assert _local_baseline_layers(sources)


@pytest.mark.skipif(not engine_available(ENGINE_SPARK), reason="pyspark not available")
def test_spark_layers_match_local(sources) -> None:
    local_rows = _local_baseline_layers(sources)
    layers = spark_compute_layers(sources, new_batch_id())
    spark_rows = _rows(layers)
    assert set(spark_rows) == set(local_rows)
    for name in local_rows:
        assert spark_rows[name] == local_rows[name], (
            f"spark row count for {name}: {spark_rows[name]} != {local_rows[name]}")
    # spark output keeps the same column sets as local
    assert sorted(layers["dwd.loan_application_detail"]["table"].column_names) == sorted(
        ["application_id", "entity_id", "event_time", "loan_amount",
         "borrower_score", "channel", "status", "batch_id"])


@pytest.mark.skipif(not engine_available(ENGINE_FLINK), reason="pyflink not available (needs Python <= 3.12)")
def test_flink_layers_match_local(sources, tmp_path) -> None:
    local_rows = _local_baseline_layers(sources)
    layers = flink_compute_layers(sources, new_batch_id(), tmp_path)
    flink_rows = _rows(layers)
    assert set(flink_rows) == set(local_rows)
    for name in local_rows:
        assert flink_rows[name] == local_rows[name], (
            f"flink row count for {name}: {flink_rows[name]} != {local_rows[name]}")


def test_engine_available_probe() -> None:
    assert engine_available(ENGINE_LOCAL)
    assert isinstance(engine_available(ENGINE_SPARK), bool)
    assert isinstance(engine_available(ENGINE_FLINK), bool)
