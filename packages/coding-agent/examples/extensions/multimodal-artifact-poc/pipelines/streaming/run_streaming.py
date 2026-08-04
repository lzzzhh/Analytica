"""Stream replay pipeline entry — deterministic local event replay.

Run: python3 -m pipelines.run --mode streaming --profile small [--replay events.jsonl] [--reset]

Micro-batch semantics:
  - events are buffered as they are validated/classified/deduped;
  - when the buffer reaches microBatchSize (default 25), the whole batch is
    appended to ods.streaming_events in ONE Iceberg commit;
  - the checkpoint advances ONLY after the append succeeds — a failed commit
    leaves the checkpoint untouched so a restart replays the same batch;
  - dead-letter / duplicate / too-late events are never buffered into the
    fact batch (they never touch the fact table).

Engine declaration: distributed=false, exactlyOnceVerified=false — this is a
local deterministic harness, not PyFlink.
"""
from __future__ import annotations

import random
from datetime import datetime, timezone
from pathlib import Path as _P

from pipelines.common.config import PipelineConfig, ensure_namespaces, open_catalog, sha256_file
from pipelines.common.generators import gen_stream_events, write_events_jsonl
from pipelines.common.manifests import ExecutionManifest
from pipelines.streaming.engine import (
    DEFAULT_MICRO_BATCH_SIZE,
    StreamCommitStats,
    StreamCounters,
    StreamEvent,
    StreamState,
    append_micro_batch,
    checkpoint_path,
    classify,
    fact_rows,
    load_state,
    normalize_event,
    read_events,
    save_state,
    write_dead_letter,
)


def generate_stream_source(cfg: PipelineConfig, seed: int = 7) -> str:
    """Write events.jsonl if absent (deterministic). Returns content hash."""
    if cfg.stream_source.exists() and not cfg.reset:
        return sha256_file(cfg.stream_source)
    rng = random.Random(seed)
    events = gen_stream_events(rng)
    return write_events_jsonl(cfg.stream_source, events)


def run_streaming(cfg: PipelineConfig, gate) -> ExecutionManifest:
    if gate is None:
        raise PermissionError("WriteGate authorization is required before pipeline execution")
    approval_id = gate.require_approved("ods.streaming_events")
    micro_batch_size = int(getattr(cfg, "micro_batch_size", DEFAULT_MICRO_BATCH_SIZE))
    manifest = ExecutionManifest(
        run_id=cfg.run_id,
        mode=cfg.mode,
        profile=cfg.profile,
        warehouse=str(cfg.warehouse),
        config={"replay": cfg.replay or str(cfg.stream_source), "microBatchSize": micro_batch_size},
    )
    counters = StreamCounters()
    commits = StreamCommitStats(micro_batch_size=micro_batch_size)
    try:
        cfg.ensure_dirs()
        generate_stream_source(cfg)

        catalog = open_catalog(cfg.warehouse)
        ensure_namespaces(catalog)

        state = StreamState() if cfg.reset else load_state(cfg)
        if cfg.reset:
            cp = checkpoint_path(cfg)
            if cp.exists():
                cp.unlink()
            dl = cfg.outputs_dir / "dead-letter.jsonl"
            if dl.exists():
                dl.unlink()
            state = StreamState()
            try:
                catalog.drop_table("ods.streaming_events")
            except Exception:
                pass
        else:
            # Recovery: the ODS fact table is the source of truth. Even if the
            # checkpoint was lost or rewound, event_ids already committed are
            # never written again.
            try:
                committed = catalog.load_table("ods.streaming_events").scan().to_arrow().to_pylist()
                for r in committed:
                    eid = r.get("event_id")
                    if eid and eid not in state.seen_event_ids:
                        state.seen_event_ids.append(eid)
            except Exception:
                pass

        source_path = cfg.replay if cfg.replay else str(cfg.stream_source)
        start = state.last_offset

        buffer: list[StreamEvent] = []

        def flush() -> None:
            """Append the buffered micro-batch and advance the checkpoint.

            The append must succeed BEFORE the checkpoint moves. On failure we
            re-raise — the checkpoint stays at the previous committed offset.
            """
            nonlocal buffer
            if not buffer:
                return
            rows = fact_rows(buffer)
            # snapshot count before/after to record commits
            try:
                before_snaps = len(catalog.load_table("ods.streaming_events").history())
            except Exception:
                before_snaps = 0
            append_micro_batch(
                catalog, rows, gate, approval_id,
                batch_id=f"stream_{cfg.run_id}_{state.last_offset}")
            commits.commits_created += 1
            try:
                after_snaps = len(catalog.load_table("ods.streaming_events").history())
                commits.snapshots_created += (after_snaps - before_snaps)
            except Exception:
                commits.snapshots_created += 1
            commits.data_files_created += len(rows)  # one data file per micro-batch commit
            # advance checkpoint AFTER successful commit (state.last_offset
            # already holds the highest consumed line index)
            state.counters = counters.to_dict()
            save_state(cfg, state)
            buffer = []

        for idx, raw in read_events(_P(source_path), start_offset=start):
            ev = normalize_event(raw, datetime.now(timezone.utc))
            setattr(ev, "_offset", idx)
            # every consumed line advances the in-memory offset; the
            # checkpoint file only moves forward on a successful micro-batch
            # commit (flush), but invalid/duplicate/too-late events are
            # recorded in counters and their offsets persist at the next
            # flush — restarting replays them, and they are idempotent
            # (dead-letter is append-only with dedup at classify time).
            state.last_offset = idx

            if not ev.valid:
                counters.invalid += 1
                write_dead_letter(cfg, ev, "invalid")
                state.counters = counters.to_dict()
                continue
            classified = classify(ev, state)
            if classified.is_duplicate:
                counters.duplicate += 1
                state.counters = counters.to_dict()
                continue
            if classified.is_too_late:
                counters.too_late += 1
                write_dead_letter(cfg, classified, "too_late")
                state.counters = counters.to_dict()
                continue
            if classified.is_late:
                counters.late += 1  # accepted within watermark, counted separately
            counters.accepted += 1
            buffer.append(classified)

            if len(buffer) >= micro_batch_size:
                flush()

        # flush the tail (partial final micro-batch)
        flush()

        manifest.stream = counters.to_dict()
        manifest.stream_commits = commits.to_dict()
        manifest.checkpoint = {
            "watermark": state.watermark,
            "seenEventIds": len(state.seen_event_ids),
            "lastOffset": state.last_offset,
            "path": str(checkpoint_path(cfg)),
        }
        manifest.success = True
    except Exception as e:  # noqa: BLE001
        manifest.success = False
        manifest.error = f"{type(e).__name__}: {e}"
        raise

    manifest.write(cfg)
    return manifest
