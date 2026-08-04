"""Batch pipeline stages — ODS load + DWD/DWS/ADS transforms.

Write path uses pyiceberg directly on the test warehouse (SQL catalog, same
protocol as the Gateway). Every stage is idempotent: re-running the same
batch overwrites its own partitions and never touches unrelated partitions.
"""
from __future__ import annotations

from typing import Any, Optional

import pyarrow as pa
import pyarrow.parquet as pq

from pipelines.common.config import PipelineConfig

# Source files per raw table (source name -> target raw table)
SOURCE_TO_RAW = {
    "loan_applications": "ods.loan_applications_raw",
    "feature_inputs": "ods.feature_inputs_raw",
    "prediction_inputs": "ods.prediction_inputs_raw",
    "model_metric_inputs": "ods.model_metric_inputs_raw",
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _table_exists(catalog, full_name: str) -> bool:
    try:
        catalog.load_table(full_name)
        return True
    except Exception:
        return False


def _create_table(catalog, full_name: str, schema: pa.Schema, partition_col: Optional[str] = None) -> None:
    from pyiceberg.schema import Schema as IcebergSchema
    from pyiceberg.types import (
        BooleanType,
        DateType,
        DoubleType,
        FloatType,
        IntegerType,
        LongType,
        NestedField,
        StringType,
        TimestampType,
        TimestamptzType,
    )

    # Build an exact Iceberg schema for the Arrow types supported by the
    # product contract. Unsupported types fail explicitly instead of being
    # silently persisted as strings.
    iceberg_fields = []
    for f in schema:
        if pa.types.is_string(f.type):
            t = StringType()
        elif pa.types.is_boolean(f.type):
            t = BooleanType()
        elif pa.types.is_int8(f.type) or pa.types.is_int16(f.type) or pa.types.is_int32(f.type):
            t = IntegerType()
        elif pa.types.is_int64(f.type):
            t = LongType()
        elif pa.types.is_float32(f.type):
            t = FloatType()
        elif pa.types.is_float64(f.type):
            t = DoubleType()
        elif pa.types.is_date32(f.type) or pa.types.is_date64(f.type):
            t = DateType()
        elif pa.types.is_timestamp(f.type):
            t = TimestamptzType() if f.type.tz is not None else TimestampType()
        else:
            raise ValueError(
                f"unsupported Arrow type for Iceberg table {full_name}: "
                f"{f.name}={f.type}")
        iceberg_fields.append(NestedField(field_id=len(iceberg_fields) + 1, name=f.name, field_type=t, required=False))
    iceberg_schema = IcebergSchema(*iceberg_fields)
    ns, name = full_name.split(".")
    catalog.create_table(full_name, schema=iceberg_schema)


def _upsert_overwrite(catalog, full_name: str, table: pa.Table, partition_expr: Optional[str] = None) -> Any:
    """Replace table content in ONE atomic Iceberg commit.

    PyIceberg's convenience `Table.overwrite()` deliberately commits delete
    and append as separate snapshots. Build one overwrite snapshot directly
    so readers cannot observe or time-travel to an intermediate empty table.
    """
    tbl = catalog.load_table(full_name)
    if partition_expr:
        raise ValueError("partition-scoped overwrite is not supported by the atomic writer")
    if any(pa.types.is_date64(field.type) for field in table.schema):
        fields = []
        arrays = []
        for field, column in zip(table.schema, table.columns):
            target_type = pa.date32() if pa.types.is_date64(field.type) else field.type
            fields.append(pa.field(
                field.name, target_type, nullable=field.nullable, metadata=field.metadata))
            arrays.append(column.cast(target_type) if target_type != field.type else column)
        table = pa.Table.from_arrays(
            arrays, schema=pa.schema(fields, metadata=table.schema.metadata))
    from pyiceberg.io.pyarrow import _check_pyarrow_schema_compatible, _dataframe_to_data_files

    _check_pyarrow_schema_compatible(
        tbl.schema(), provided_schema=table.schema,
        downcast_ns_timestamp_to_us=False,
        format_version=tbl.metadata.format_version,
    )
    transaction = tbl.transaction()
    with transaction.update_snapshot().overwrite() as overwrite:
        for task in tbl.scan().plan_files():
            overwrite.delete_data_file(task.file)
        for data_file in _dataframe_to_data_files(
            table_metadata=transaction.table_metadata,
            write_uuid=overwrite.commit_uuid,
            df=table,
            io=tbl.io,
        ):
            overwrite.append_data_file(data_file)
    transaction.commit_transaction()
    tbl.refresh()
    snap = tbl.current_snapshot()
    return snap.snapshot_id if snap else None


def read_parquet_sources(cfg: PipelineConfig, source_names: list[str]) -> dict[str, pa.Table]:
    out = {}
    for name in source_names:
        path = cfg.batch_source_dir / name / "data.parquet"
        if not path.exists():
            # fall back to any .parquet in the dir
            files = list((cfg.batch_source_dir / name).glob("*.parquet"))
            if not files:
                raise FileNotFoundError(f"no parquet source for {name} at {cfg.batch_source_dir / name}")
            path = files[0]
        out[name] = pq.read_table(path)
    return out


# ---------------------------------------------------------------------------
# ODS load
# ---------------------------------------------------------------------------

def load_ods(cfg: PipelineConfig, catalog, sources: dict[str, pa.Table], batch_id: str,
             gate, approvals: dict[str, str]) -> dict:
    """Land raw source files into ods.*_raw tables with batch_id + hash."""
    records = {}
    for name, table in sources.items():
        raw_name = SOURCE_TO_RAW[name]
        rows = table.to_pylist()
        # add batch metadata columns
        batch_col = pa.array([batch_id] * len(rows))
        table = table.append_column("batch_id", batch_col)
        snap = gate.publish(
            catalog, raw_name, table, approval_id=approvals[raw_name],
            batch_id=f"{batch_id}:{raw_name}")
        records[raw_name] = {"inputRows": len(rows), "outputRows": len(rows), "snapshotId": snap}
    return records


# ---------------------------------------------------------------------------
# DWD transform
# ---------------------------------------------------------------------------

def build_dwd(cfg: PipelineConfig, catalog, sources: dict[str, pa.Table], batch_id: str,
              gate, approvals: dict[str, str]) -> dict:
    """DWD.loan_application_detail: clean + dedup + time normalization.

    Rules:
      - drop rows with null application_id
      - dedup by application_id (keep first by input order)
      - normalize event_time to ISO date string
      - null borrower_score kept (missingness is a business signal, not an error)
    """
    loans = sources["loan_applications"]
    rows = loans.to_pylist()
    seen = set()
    cleaned = []
    for r in rows:
        if not r.get("application_id"):
            continue
        if r["application_id"] in seen:
            continue
        seen.add(r["application_id"])
        cleaned.append({
            "application_id": r["application_id"],
            "entity_id": r.get("entity_id"),
            "event_time": str(r.get("event_time")),
            "loan_amount": r.get("loan_amount"),
            "borrower_score": r.get("borrower_score"),
            "channel": r.get("channel"),
            "status": r.get("status"),
            "batch_id": batch_id,
        })

    table = pa.Table.from_pylist(cleaned)
    # Idempotent rebuild: the DWD is derived purely from the (immutable)
    # batch sources. Stream events land in ODS only — they are never folded
    # into DWD with synthetic keys (business-key integrity).
    target = "dwd.loan_application_detail"
    snap = gate.publish(
        catalog, target, table, approval_id=approvals[target],
        batch_id=f"{batch_id}:{target}")
    return {"dwd.loan_application_detail": {
        "inputRows": len(rows), "outputRows": len(cleaned), "snapshotId": snap}}


# ---------------------------------------------------------------------------
# DWS transforms
# ---------------------------------------------------------------------------

def build_dws(cfg: PipelineConfig, catalog, sources: dict[str, pa.Table], batch_id: str,
              gate, approvals: dict[str, str]) -> dict:
    """DWS.feature_values + DWS.prediction_points.

    feature_values: from feature_inputs (dedup entity/feature/date, keep last).
    prediction_points: from prediction_inputs (dedup entity/date).
    """
    records = {}

    # -- feature_values -------------------------------------------------
    feat_rows = sources["feature_inputs"].to_pylist()
    feat_dedup = {}
    for r in feat_rows:
        key = (r.get("entity_id"), r.get("feature_id"), str(r.get("event_time")))
        feat_dedup[key] = r  # last wins
    feat_clean = []
    for (ent, fid, d), r in sorted(feat_dedup.items()):
        feat_clean.append({
            "entity_id": ent,
            "feature_id": fid,
            "event_time": d,
            "feature_value": r.get("feature_value"),
            "source": r.get("source"),
            "batch_id": batch_id,
        })
    feat_table = pa.Table.from_pylist(feat_clean)
    target = "dws.feature_values"
    snap = gate.publish(
        catalog, target, feat_table, approval_id=approvals[target],
        batch_id=f"{batch_id}:{target}")
    records["dws.feature_values"] = {
        "inputRows": len(feat_rows), "outputRows": len(feat_clean), "snapshotId": snap}

    # -- prediction_points ----------------------------------------------
    pred_rows = sources["prediction_inputs"].to_pylist()
    pred_dedup = {}
    for r in pred_rows:
        key = (r.get("entity_id"), str(r.get("event_time")))
        pred_dedup[key] = r
    pred_clean = []
    for (ent, d), r in sorted(pred_dedup.items()):
        pred_clean.append({
            "entity_id": ent,
            "event_time": d,
            "prediction": r.get("prediction"),
            "model_id": r.get("model_id"),
            "score_version": r.get("score_version"),
            "batch_id": batch_id,
        })
    pred_table = pa.Table.from_pylist(pred_clean)
    target = "dws.prediction_points"
    snap = gate.publish(
        catalog, target, pred_table, approval_id=approvals[target],
        batch_id=f"{batch_id}:{target}")
    records["dws.prediction_points"] = {
        "inputRows": len(pred_rows), "outputRows": len(pred_clean), "snapshotId": snap}

    return records


# ---------------------------------------------------------------------------
# ADS transform
# ---------------------------------------------------------------------------

def build_ads(cfg: PipelineConfig, catalog, sources: dict[str, pa.Table], batch_id: str,
              gate, approvals: dict[str, str]) -> dict:
    """ADS.model_metrics: from model_metric_inputs (dedup model/date, last wins)."""
    rows = sources["model_metric_inputs"].to_pylist()
    dedup = {}
    for r in rows:
        key = (r.get("model_id"), str(r.get("metric_date")))
        dedup[key] = r
    clean = []
    for (mid, d), r in sorted(dedup.items()):
        clean.append({
            "model_id": mid,
            "metric_date": d,
            "auc": r.get("auc"),
            "sample_count": r.get("sample_count"),
            "batch_id": batch_id,
        })
    table = pa.Table.from_pylist(clean)
    target = "ads.model_metrics"
    snap = gate.publish(
        catalog, target, table, approval_id=approvals[target],
        batch_id=f"{batch_id}:{target}")
    return {"ads.model_metrics": {
        "inputRows": len(rows), "outputRows": len(clean), "snapshotId": snap}}
