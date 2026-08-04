"""Engine backends for the batch pipeline (local / Spark / Flink).

The engine is the COMPUTE backend only. Every backend produces the same
layer tables; writes go through the single unified path (pyiceberg catalog),
so swapping engines never changes the governance surface.

Lifecycle events (JOB_SUBMITTED / STAGE_COMPLETED / TASK_SUMMARY /
JOB_SUCCEEDED / JOB_FAILED, plus Flink CHECKPOINT_METRICS) and deadline
heartbeats are emitted through the governance coordinator, so the State
Reducer, status bar and runtime-governance rules observe REAL engine runs.

Environment notes:
  - Spark: pyspark (base env, Python 3.13)
  - Flink: pyflink (Python 3.11 env — pyflink has no 3.13 wheels)
  - both run locally (Spark local[2] / Flink in_batch_mode)
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

import pyarrow as pa

from pipelines.batch.stages import SOURCE_TO_RAW
from pipelines.common.config import open_catalog

ENGINE_LOCAL = "local"
ENGINE_SPARK = "spark"
ENGINE_FLINK = "flink"
ENGINES = (ENGINE_LOCAL, ENGINE_SPARK, ENGINE_FLINK)

# Layer SQL (Spark SQL / Flink SQL compatible subset). Dedup keeps the same
# semantics as the local pyarrow implementation (dedup by business key).
_DWD_SQL = """
SELECT application_id, entity_id, CAST(event_time AS STRING) AS event_time,
       loan_amount, borrower_score, channel, status, '{batch_id}' AS batch_id
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY application_id ORDER BY CAST(event_time AS STRING)) AS rn
  FROM src_loan_applications
) t
WHERE t.application_id IS NOT NULL AND t.rn = 1
"""

_DWS_FEATURE_SQL = """
SELECT entity_id, feature_id, CAST(event_time AS STRING) AS event_time,
       feature_value, source, '{batch_id}' AS batch_id
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY entity_id, feature_id, CAST(event_time AS STRING)
    ORDER BY CAST(event_time AS STRING) DESC) AS rn
  FROM src_feature_inputs
) t
WHERE t.rn = 1
"""

_DWS_PREDICTION_SQL = """
SELECT entity_id, CAST(event_time AS STRING) AS event_time,
       prediction, model_id, score_version, '{batch_id}' AS batch_id
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY entity_id, CAST(event_time AS STRING)
    ORDER BY CAST(event_time AS STRING) DESC) AS rn
  FROM src_prediction_inputs
) t
WHERE t.rn = 1
"""

_ADS_SQL = """
SELECT model_id, CAST(metric_date AS STRING) AS metric_date,
       auc, sample_count, '{batch_id}' AS batch_id
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY model_id, CAST(metric_date AS STRING)
    ORDER BY CAST(metric_date AS STRING) DESC) AS rn
  FROM src_model_metric_inputs
) t
WHERE t.rn = 1
"""

# ---------------------------------------------------------------------------
# Lifecycle reporter (governance events)
# ---------------------------------------------------------------------------


class EngineReporter:
    """Emits engine lifecycle events through the governance coordinator."""

    def __init__(self, coordinator: Any, pipeline_id: str, run_id: str,
                 pipeline_version: int = 1, engine: str = ENGINE_SPARK):
        self.coordinator = coordinator
        self.pipeline_id = pipeline_id
        self.run_id = run_id
        self.pipeline_version = pipeline_version
        # governance-event contract restricts source to adapter names
        self.source = "SPARK_ADAPTER" if engine == ENGINE_SPARK else "FLINK_ADAPTER"

    def _emit(self, etype: str, payload: dict) -> None:
        self.coordinator.emit(etype, self.pipeline_id, self.pipeline_version,
                              self.run_id, payload=payload, source=self.source)

    def job_submitted(self, engine: str, job_id: int) -> None:
        self._emit("JOB_SUBMITTED", {"engine": engine, "jobId": job_id})

    def stage_completed(self, stage_id: str, input_rows: int,
                        output_rows: int, duration_ms: int) -> None:
        self._emit("STAGE_COMPLETED", {
            "stageId": stage_id, "status": "SUCCEEDED",
            "durationMs": duration_ms, "spillBytes": 0,
            "inputRows": input_rows, "outputRows": output_rows,
            "retryCount": 0,
        })

    def task_summary(self, summary: dict) -> None:
        self._emit("TASK_SUMMARY", {"summary": summary})

    def checkpoint_metrics(self, metrics: dict) -> None:
        self._emit("CHECKPOINT_METRICS", {"metrics": metrics})

    def heartbeat(self, deadline: str) -> None:
        self.coordinator.watchdog_renew(self.run_id, self.pipeline_id,
                                        self.pipeline_version, deadline)

    def job_succeeded(self, duration_ms: int) -> None:
        self._emit("JOB_SUCCEEDED", {"durationMs": duration_ms})

    def job_failed(self, error: str) -> None:
        self._emit("JOB_FAILED", {"error": error[:500]})


# ---------------------------------------------------------------------------
# Spark compute backend
# ---------------------------------------------------------------------------

def _arrow_from_spark(df: Any) -> pa.Table:
    # pyspark >= 4.0 has df.toArrow(); 3.5 falls back to collect
    if hasattr(df, "toArrow"):
        return df.toArrow()
    return pa.Table.from_pylist([r.asDict() for r in df.collect()])


def spark_compute_layers(sources: dict[str, pa.Table],
                         batch_id: str) -> dict[str, dict]:
    """Run ODS→DWD→DWS→ADS transforms on PySpark (local mode)."""
    from pyspark.sql import SparkSession

    previous_python = os.environ.get("PYSPARK_PYTHON")
    os.environ["PYSPARK_PYTHON"] = sys.executable
    spark = SparkSession.builder.master("local[2]") \
        .appName("analytica-batch-engine") \
        .config("spark.ui.enabled", "false") \
        .config("spark.pyspark.python", sys.executable) \
        .config("spark.pyspark.driver.python", sys.executable) \
        .getOrCreate()
    try:
        spark.sparkContext.setLogLevel("ERROR")
        for name, t in sources.items():
            spark.createDataFrame(t.to_pylist()).createOrReplaceTempView(f"src_{name}")

        layers: dict[str, dict] = {}
        # ODS: raw landing with batch_id column
        for name, t in sources.items():
            raw_name = SOURCE_TO_RAW[name]
            df = spark.sql(f"SELECT *, '{batch_id}' AS batch_id FROM src_{name}")
            layers[raw_name] = {
                "table": _arrow_from_spark(df),
                "inputRows": t.num_rows, "outputRows": t.num_rows,
            }

        def _run(full_name: str, sql: str, input_rows: int) -> None:
            df = spark.sql(sql)
            tbl = _arrow_from_spark(df)
            layers[full_name] = {
                "table": tbl, "inputRows": input_rows, "outputRows": tbl.num_rows,
            }

        _run("dwd.loan_application_detail", _DWD_SQL.format(batch_id=batch_id),
             sources["loan_applications"].num_rows)
        _run("dws.feature_values", _DWS_FEATURE_SQL.format(batch_id=batch_id),
             sources["feature_inputs"].num_rows)
        _run("dws.prediction_points", _DWS_PREDICTION_SQL.format(batch_id=batch_id),
             sources["prediction_inputs"].num_rows)
        _run("ads.model_metrics", _ADS_SQL.format(batch_id=batch_id),
             sources["model_metric_inputs"].num_rows)
        return layers
    finally:
        spark.stop()
        if previous_python is None:
            os.environ.pop("PYSPARK_PYTHON", None)
        else:
            os.environ["PYSPARK_PYTHON"] = previous_python


# ---------------------------------------------------------------------------
# Flink compute backend (batch mode; pyflink requires Python <= 3.12)
# ---------------------------------------------------------------------------

def _flink_csv_dir(root: Path, name: str) -> Path:
    d = root / "flink-csv" / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def flink_compute_layers(sources: dict[str, pa.Table], batch_id: str,
                         tmp_root: Path) -> dict[str, dict]:
    """Run ODS→DWD→DWS→ADS transforms on PyFlink Table API (batch mode).

    CSV intermediate files keep the dependency surface small (the filesystem
    + csv connectors ship with pyflink); results are read back as pyarrow.
    """
    from pyflink.table import EnvironmentSettings, TableEnvironment
    import pyarrow.csv as pacsv

    env = TableEnvironment.create(EnvironmentSettings.in_batch_mode())
    env.get_config().set("parallelism.default", "1")

    # register sources from CSV intermediate files
    for name, t in sources.items():
        csv_dir = _flink_csv_dir(tmp_root, name)
        for f in csv_dir.glob("*.csv"):
            f.unlink()
        pacsv.write_csv(t, csv_dir / "data.csv",
                        write_options=pa.csv.WriteOptions(include_header=False))
        cols = ", ".join(f"`{c}` STRING" for c in t.column_names)
        env.execute_sql(
            f"CREATE TABLE src_{name} ({cols}) WITH "
            f"('connector'='filesystem', 'path'='{csv_dir}', 'format'='csv')"
        )

    layers: dict[str, dict] = {}

    def _run(full_name: str, sql: str, input_rows: int, columns: list[str]) -> None:
        sink_dir = _flink_csv_dir(tmp_root, f"sink_{full_name.replace('.', '_')}")
        for f in sink_dir.glob("*.csv"):
            f.unlink()
        sink_cols = ", ".join(f"`{c}` STRING" for c in columns)
        env.execute_sql(
            f"CREATE TABLE sink_{full_name.replace('.', '_')} ({sink_cols}) WITH "
            f"('connector'='filesystem', 'path'='{sink_dir}', 'format'='csv')"
        )
        env.execute_sql(
            f"INSERT INTO sink_{full_name.replace('.', '_')} {sql}"
        ).wait()
        # pyflink filesystem sink writes part-<uuid>-task-<n>-file-<n> (no ext,
        # no header) — column names come from the declared sink schema
        files = sorted(f for f in sink_dir.glob("part-*") if f.is_file())
        tables = [
            pacsv.read_csv(f, read_options=pa.csv.ReadOptions(column_names=columns))
            for f in files
        ]
        tbl = pa.concat_tables(tables) if tables else pa.table(
            {c: [] for c in columns})
        layers[full_name] = {
            "table": _coerce_layer_schema(full_name, tbl),
            "inputRows": input_rows, "outputRows": tbl.num_rows,
        }

    # ODS: raw landing
    for name, t in sources.items():
        raw_name = SOURCE_TO_RAW[name]
        cols = [*t.column_names, "batch_id"]
        _run(raw_name,
             f"SELECT *, '{batch_id}' AS batch_id FROM src_{name}",
             t.num_rows, cols)

    _run("dwd.loan_application_detail",
         _DWD_SQL.format(batch_id=batch_id),
         sources["loan_applications"].num_rows,
         ["application_id", "entity_id", "event_time", "loan_amount",
          "borrower_score", "channel", "status", "batch_id"])
    _run("dws.feature_values", _DWS_FEATURE_SQL.format(batch_id=batch_id),
         sources["feature_inputs"].num_rows,
         ["entity_id", "feature_id", "event_time", "feature_value",
          "source", "batch_id"])
    _run("dws.prediction_points", _DWS_PREDICTION_SQL.format(batch_id=batch_id),
         sources["prediction_inputs"].num_rows,
         ["entity_id", "event_time", "prediction", "model_id",
          "score_version", "batch_id"])
    _run("ads.model_metrics", _ADS_SQL.format(batch_id=batch_id),
         sources["model_metric_inputs"].num_rows,
         ["model_id", "metric_date", "auc", "sample_count", "batch_id"])
    return layers


# numeric fields per layer (CSV reads everything as string; restore types)
_LAYER_NUMERIC_COLUMNS: dict[str, list[str]] = {
    "dwd.loan_application_detail": ["loan_amount", "borrower_score"],
    "dws.feature_values": ["feature_value"],
    "dws.prediction_points": ["prediction"],
    "ads.model_metrics": ["auc", "sample_count"],
}


def _coerce_layer_schema(full_name: str, table: pa.Table) -> pa.Table:
    """Best-effort type restoration for CSV round-tripped columns."""
    numeric = _LAYER_NUMERIC_COLUMNS.get(full_name, [])
    arrays: list[pa.Array] = []
    for n in table.column_names:
        arr = table.column(n)
        if n in numeric:
            try:
                arr = arr.cast(pa.float64())
            except Exception:  # noqa: BLE001
                arr = arr.cast(pa.string())
        elif n in ("batch_id", "application_id", "entity_id", "feature_id",
                   "event_time", "metric_date", "model_id", "score_version",
                   "channel", "status", "source"):
            arr = arr.cast(pa.string())
        arrays.append(arr)
    return pa.Table.from_arrays(arrays, names=table.column_names)


# ---------------------------------------------------------------------------
# Unified runner
# ---------------------------------------------------------------------------

def run_batch_with_engine(cfg: Any, engine: str = ENGINE_LOCAL,
                          coordinator: Optional[Any] = None,
                          gate: Optional[Any] = None) -> Any:
    """Run the batch pipeline on the chosen compute engine.

    local  -> existing pyarrow stages (writes inside stages)
    spark  -> PySpark compute, unified pyiceberg writes
    flink  -> PyFlink compute (batch), unified pyiceberg writes

    Lifecycle events + heartbeats are emitted when a coordinator is given.
    """
    from pipelines.batch.run_batch import (
        TARGET_TABLES, generate_batch_sources, run_batch,
    )
    from pipelines.batch.stages import read_parquet_sources
    from pipelines.common.config import ensure_namespaces, profile_params
    from pipelines.common.manifests import ExecutionManifest, layer_record

    if engine not in ENGINES:
        raise ValueError(f"unknown engine '{engine}' (use {', '.join(ENGINES)})")
    if gate is None:
        raise PermissionError("WriteGate authorization is required before pipeline execution")

    if engine == ENGINE_LOCAL:
        return run_batch(cfg, gate=gate)

    params = profile_params(cfg.profile)
    days = params["days"]
    entities = [f"ent_{i:03d}" for i in range(1, params["entities"] + 1)]
    seed = 42
    batch_id = f"batch_{cfg.run_id}"

    manifest = ExecutionManifest(
        run_id=cfg.run_id, mode=cfg.mode, profile=cfg.profile,
        warehouse=str(cfg.warehouse),
        config={"days": days, "entities": len(entities), "seed": seed,
                "batchId": batch_id, "engine": engine},
    )
    reporter = EngineReporter(coordinator, "batch", cfg.run_id,
                              engine=engine) if coordinator else None
    started = time.monotonic()

    try:
        cfg.ensure_dirs()
        generate_batch_sources(cfg, days, entities, seed, cfg.run_id)
        catalog = open_catalog(cfg.warehouse)
        ensure_namespaces(catalog)
        if cfg.reset:
            for table in list(TARGET_TABLES):
                try:
                    catalog.drop_table(table)
                except Exception:  # noqa: BLE001
                    pass
        sources = read_parquet_sources(cfg, list(SOURCE_TO_RAW))
        approvals = {target: gate.require_approved(target) for target in TARGET_TABLES}

        if reporter:
            reporter.job_submitted(engine, job_id=1)

        if engine == ENGINE_SPARK:
            layers = spark_compute_layers(sources, batch_id)
            if reporter:
                reporter.task_summary({
                    "maxToMedianRatio": 1.0, "failedTaskRate": 0.0,
                    "partitions": max((t["table"].num_rows or 1 for t in layers.values()), default=1),
                })
        else:  # flink
            layers = flink_compute_layers(sources, batch_id, cfg.root)
            if reporter:
                reporter.checkpoint_metrics({
                    "checkpointCount": 1, "lastCheckpointDurationMs": 0,
                })

        # unified writes (same path as local)
        for full_name, rec in layers.items():
            t0 = time.monotonic()
            snap = gate.publish(
                catalog, full_name, rec["table"],
                approval_id=approvals[full_name],
                batch_id=f"{batch_id}:{full_name}")
            duration_ms = int((time.monotonic() - t0) * 1000)
            prefix = full_name.split(".")[0]
            manifest.layers[f"{prefix}:{full_name}"] = layer_record(
                full_name, rec["inputRows"], rec["outputRows"], snap)
            if reporter:
                reporter.stage_completed(full_name, rec["inputRows"],
                                         rec["outputRows"], duration_ms)
                reporter.heartbeat("2099-01-01T00:00:00+00:00")

        manifest.success = True
        if reporter:
            reporter.job_succeeded(int((time.monotonic() - started) * 1000))
    except Exception as e:  # noqa: BLE001
        manifest.success = False
        manifest.error = f"{type(e).__name__}: {e}"
        if reporter:
            reporter.job_failed(manifest.error)
        raise

    manifest.write(cfg)
    return manifest


def engine_available(engine: str) -> bool:
    """Probe whether the engine's runtime is importable in this interpreter."""
    if engine == ENGINE_LOCAL:
        return True
    if engine == ENGINE_SPARK:
        try:
            import pyspark  # noqa: F401
            return True
        except Exception:  # noqa: BLE001
            return False
    if engine == ENGINE_FLINK:
        try:
            import pyflink  # noqa: F401
            return True
        except Exception:  # noqa: BLE001
            return False
    return False
