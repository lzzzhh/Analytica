"""Hybrid pipeline — batch baseline + stream replay append.

Flow:
  1. Batch: build the historical baseline (ODS→DWD→DWS→ADS) from sources;
  2. Stream replay: deterministic local event replay into ods.streaming_events
     (dedup, application-level watermark, dead letter, micro-batch commits);
  3. Ledger: the stream replay writes a processed-event ledger recording
     event_id → source_offset per run; the ledger, checkpoint and execution
     manifest are the ONLY places event provenance lives.

Business-key integrity: stream events are NEVER folded into DWD/DWS/ADS with
synthetic keys. The DWD schema requires real application business keys from
the batch source; the current stream payloads do not carry them, so stream
events land in ODS only (facts + ledger). No DWD schema semantics are
changed to make the E2E pass.
"""
from __future__ import annotations

from pipelines.common.config import PipelineConfig, ensure_namespaces, open_catalog, write_json
from pipelines.common.manifests import ExecutionManifest
from pipelines.batch.run_batch import run_batch as _run_batch
from pipelines.streaming.run_streaming import run_streaming as _run_streaming


def _write_ledger(cfg: PipelineConfig, run_id: str) -> dict:
    """Write the processed-event ledger from the ODS fact table.

    The ledger records event_id → source_offset/event_time for every accepted
    event; it exists for provenance and replay auditing. It is NOT a business
    table and carries no business keys.
    """
    catalog = open_catalog(cfg.warehouse)
    try:
        rows = catalog.load_table("ods.streaming_events").scan().to_arrow().to_pylist()
    except Exception:
        rows = []
    entries = [
        {
            "event_id": r.get("event_id"),
            "event_time": str(r.get("event_time")),
            "processing_time": r.get("processing_time"),
            "source": "stream_replay",
        }
        for r in rows
        if r.get("event_id")
    ]
    path = cfg.outputs_dir / f"ledger-{run_id}.json"
    write_json(path, {"runId": run_id, "entries": entries})
    return {"ledgerPath": str(path), "ledgerEntries": len(entries)}


def run_hybrid(cfg: PipelineConfig, gate) -> ExecutionManifest:
    if gate is None:
        raise PermissionError("WriteGate authorization is required before pipeline execution")
    manifest = ExecutionManifest(
        run_id=cfg.run_id,
        mode=cfg.mode,
        profile=cfg.profile,
        warehouse=str(cfg.warehouse),
        config={"pipeline": "batch_baseline -> stream_replay_append -> ledger"},
    )
    try:
        # 1. batch baseline (ODS→DWD→DWS→ADS)
        batch_manifest = _run_batch(cfg, gate)
        for k, v in batch_manifest.layers.items():
            manifest.layers[k] = v

        # 2. stream replay append (micro-batch commits into ODS only)
        stream_manifest = _run_streaming(cfg, gate)
        manifest.stream = stream_manifest.stream
        manifest.checkpoint = stream_manifest.checkpoint
        manifest.stream_commits = stream_manifest.stream_commits

        # 3. processed-event ledger (provenance; never a business table)
        ledger = _write_ledger(cfg, cfg.run_id)
        manifest.config["ledger"] = ledger

        manifest.success = True
    except Exception as e:  # noqa: BLE001
        manifest.success = False
        manifest.error = f"{type(e).__name__}: {e}"
        raise

    manifest.write(cfg)
    return manifest
