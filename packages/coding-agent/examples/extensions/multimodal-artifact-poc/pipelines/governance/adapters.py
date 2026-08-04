"""Runtime adapters (§4.2) — the collectors that turn engine facts into
uniform runtime summaries.

Spark / Flink collectors are the wiring points for real engines (JobListener /
metrics API); in this local environment they run on fixture events with
verified=false (the deterministic governance engine never claims verified
production behaviour). The Iceberg adapter is REAL: it reads the pyiceberg
catalog (snapshots, data files, partition stats) and produces the
iceberg-commit-summary that govern_iceberg consumes.
"""
from __future__ import annotations

from typing import Any, Optional

import pyarrow.parquet as pq


# ---------------------------------------------------------------------------
# Spark adapter — wiring point for a real JobListener / metrics collector.
# ---------------------------------------------------------------------------

def spark_summary_from_events(events: list[dict], pipeline_id: str,
                              pipeline_version: int, run_id: str, job_id: int) -> dict:
    """Aggregate Spark lifecycle events into a spark-runtime-summary.
    Fixture-backed in this environment (verified=false); a real deployment
    replaces the event source with a Spark JobListener."""
    status = "RUNNING"
    stages: list[dict] = []
    task_summary: dict = {}
    for ev in events:
        etype = ev.get("eventType")
        if etype == "JOB_SUCCEEDED":
            status = "SUCCEEDED"
        elif etype == "JOB_FAILED":
            status = "FAILED"
        elif etype == "STAGE_COMPLETED":
            stages.append({
                "stageId": ev.get("stageId", 0), "status": "SUCCEEDED",
                "durationMs": ev.get("durationMs"),
                "spillBytes": ev.get("spillBytes", 0),
                "inputRows": ev.get("inputRows", 0),
                "outputRows": ev.get("outputRows", 0),
                "retryCount": ev.get("retryCount", 0),
            })
        elif etype == "TASK_SUMMARY":
            task_summary = ev.get("summary", {})
    return {
        "runId": run_id, "pipelineId": pipeline_id, "pipelineVersion": pipeline_version,
        "engine": "SPARK", "jobId": job_id, "status": status,
        "durationMs": sum(s.get("durationMs") or 0 for s in stages),
        "retries": 0, "stages": stages, "taskSummary": task_summary,
        "verified": False,
    }


# ---------------------------------------------------------------------------
# Flink adapter — wiring point for a real metrics API collector.
# ---------------------------------------------------------------------------

def flink_summary_from_events(events: list[dict], pipeline_id: str,
                              pipeline_version: int, run_id: str, job_id: int) -> dict:
    """Aggregate Flink lifecycle events into a flink-runtime-summary.
    Fixture-backed (verified=false); a real deployment feeds these from the
    Flink REST metrics API / operator metrics collector."""
    status = "RUNNING"
    operators: list[dict] = []
    checkpoints: dict = {}
    watermark: dict = {}
    backpressure: dict = {}
    for ev in events:
        etype = ev.get("eventType")
        if etype == "JOB_SUCCEEDED":
            status = "SUCCEEDED"
        elif etype == "JOB_FAILED":
            status = "FAILED"
        elif etype == "OPERATOR_METRICS":
            operators.append(ev.get("metrics", {}))
        elif etype == "CHECKPOINT_METRICS":
            checkpoints = ev.get("metrics", {})
        elif etype == "WATERMARK_METRICS":
            watermark = ev.get("metrics", {})
        elif etype == "BACKPRESSURE_METRICS":
            backpressure = ev.get("metrics", {})
    return {
        "runId": run_id, "pipelineId": pipeline_id, "pipelineVersion": pipeline_version,
        "engine": "FLINK", "jobId": job_id, "status": status,
        "operators": operators, "checkpoints": checkpoints,
        "watermark": watermark, "backpressure": backpressure,
        "verified": False,
    }


# ---------------------------------------------------------------------------
# Iceberg adapter — REAL: reads the pyiceberg catalog directly.
# ---------------------------------------------------------------------------

def iceberg_summary_from_catalog(catalog: Any, target: str, pipeline_id: str,
                                 pipeline_version: int, run_id: str,
                                 max_files: int = 1000) -> dict:
    """Build an iceberg-commit-summary from the actual table state: latest
    snapshot, data file sizes, partition stats, schema-change flag.

    Snapshot ids are monotonic; the latest snapshot is the commit under
    review. freshnessSeconds is the time since the snapshot's last update.
    """
    table = catalog.load_table(target)
    snapshots = list(table.snapshots())
    latest = snapshots[-1] if snapshots else None
    snapshot_id = str(latest.snapshot_id) if latest else "none"

    data_files: list[dict] = []
    partition_stats: dict = {}
    if latest is not None:
        manifest = table.scan(snapshot_id=latest.snapshot_id).plan_files()
        for pf in manifest:
            f = pf.file
            data_files.append({"path": str(f.file_path), "sizeBytes": f.file_size_in_bytes})
            # partition field stats: use the first partition field when present
            if len(f.partition) > 0:
                key = str(f.partition[0][1].value) if f.partition[0][1] is not None else "?"
                partition_stats[key] = partition_stats.get(key, 0) + f.file_size_bytes
            if len(data_files) >= max_files:
                break

    schema_changed = False
    if len(snapshots) >= 2:
        schema_changed = snapshots[-2].schema_id != latest.schema_id

    freshness_seconds = None
    if latest is not None:
        from datetime import datetime, timezone
        committed = datetime.fromtimestamp(latest.timestamp_ms / 1000.0, tz=timezone.utc)
        freshness_seconds = max(0, int((datetime.now(timezone.utc) - committed).total_seconds()))

    return {
        "runId": run_id, "pipelineId": pipeline_id, "pipelineVersion": pipeline_version,
        "engine": "ICEBERG", "snapshotId": snapshot_id,
        "dataFiles": data_files, "manifests": [{"path": "latest"}],
        "partitionStats": partition_stats,
        "schemaChanged": schema_changed, "partitionSpecChanged": False,
        "freshnessSeconds": freshness_seconds,
        # contract const=False: no summary ever claims verified production
        # behaviour (prevents fabricating production capability claims)
        "verified": False,
    }


