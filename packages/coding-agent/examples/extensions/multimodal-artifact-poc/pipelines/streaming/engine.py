"""Stream replay engine — deterministic local event replay.

Application-level event-time/watermark policy + local file checkpoint +
micro-batch commits:
  - events are validated, classified (watermark/dedup) and buffered;
  - a micro-batch (default 25 events) is appended to Iceberg in ONE commit;
  - the checkpoint advances only AFTER a successful append (commit-fail ⇒
    checkpoint does not move; re-running replays the same batch);
  - dedup state (seen event ids) is persisted in the checkpoint.

This is NOT PyFlink and NOT a distributed stream processor.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator, Optional

import pyarrow as pa

from pipelines.common.config import PipelineConfig, write_json

WATERMARK_SECONDS = 5 * 24 * 3600  # 5 days
LATE_TOLERANCE_SECONDS = 12 * 3600  # events up to 12h older than max are normal reordering
DEFAULT_MICRO_BATCH_SIZE = 25


@dataclass
class StreamEvent:
    raw: dict
    event_id: Optional[str]
    event_type: Optional[str]
    entity_id: Optional[str]
    event_time: Optional[datetime]
    processing_time: datetime
    valid: bool
    invalid_reason: Optional[str] = None
    is_duplicate: bool = False
    is_late: bool = False
    is_too_late: bool = False


@dataclass
class StreamCounters:
    accepted: int = 0
    duplicate: int = 0
    late: int = 0
    too_late: int = 0
    invalid: int = 0

    def to_dict(self) -> dict:
        return {
            "accepted": self.accepted,
            "duplicate": self.duplicate,
            "late": self.late,
            "tooLate": self.too_late,
            "invalid": self.invalid,
        }


@dataclass
class StreamState:
    """Local file checkpoint state."""

    watermark: str = ""
    seen_event_ids: list[str] = field(default_factory=list)
    counters: dict = field(default_factory=lambda: StreamCounters().to_dict())
    last_offset: int = -1  # last committed source line index

    def to_dict(self) -> dict:
        return {
            "watermark": self.watermark,
            "seenEventIds": self.seen_event_ids,
            "counters": self.counters,
            "lastOffset": self.last_offset,
        }


@dataclass
class StreamCommitStats:
    micro_batch_size: int = DEFAULT_MICRO_BATCH_SIZE
    commits_created: int = 0
    snapshots_created: int = 0
    data_files_created: int = 0

    def to_dict(self) -> dict:
        return {
            "microBatchSize": self.micro_batch_size,
            "commitsCreated": self.commits_created,
            "snapshotsCreated": self.snapshots_created,
            "dataFilesCreated": self.data_files_created,
        }


def checkpoint_path(cfg: PipelineConfig) -> Path:
    return cfg.checkpoints_dir / "stream-replay-checkpoint.json"


def load_state(cfg: PipelineConfig) -> StreamState:
    path = checkpoint_path(cfg)
    if not path.exists():
        return StreamState()
    data = json.loads(path.read_text(encoding="utf-8"))
    return StreamState(
        watermark=data.get("watermark", ""),
        seen_event_ids=data.get("seenEventIds", []),
        counters=data.get("counters", StreamCounters().to_dict()),
        last_offset=data.get("lastOffset", -1),
    )


def save_state(cfg: PipelineConfig, state: StreamState) -> None:
    write_json(checkpoint_path(cfg), state.to_dict())


def read_events(path: Path, start_offset: int = -1) -> Iterator[tuple[int, dict]]:
    """Yield (line_index, event) from a JSONL file; skips consumed lines."""
    with open(path, "r", encoding="utf-8") as f:
        for idx, line in enumerate(f):
            if idx <= start_offset:
                continue
            line = line.strip()
            if not line:
                continue
            try:
                yield idx, json.loads(line)
            except json.JSONDecodeError:
                yield idx, {"_invalid_json": True, "raw": line}


def parse_event_time(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    s = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def normalize_event(raw: dict, processing_time: datetime) -> StreamEvent:
    """Schema validation + event-time extraction."""
    event_id = raw.get("event_id")
    event_type = raw.get("event_type")
    entity_id = raw.get("entity_id")
    event_time = parse_event_time(raw.get("event_time"))

    if raw.get("_invalid_json"):
        return StreamEvent(raw=raw, event_id=None, event_type=None, entity_id=None,
                           event_time=None, processing_time=processing_time,
                           valid=False, invalid_reason="invalid_json")
    if not event_id or not isinstance(event_id, str):
        return StreamEvent(raw=raw, event_id=None, event_type=None, entity_id=None,
                           event_time=None, processing_time=processing_time,
                           valid=False, invalid_reason="missing_event_id")
    if event_time is None:
        return StreamEvent(raw=raw, event_id=event_id, event_type=event_type, entity_id=entity_id,
                           event_time=None, processing_time=processing_time,
                           valid=False, invalid_reason="bad_event_time")
    if event_type not in ("application_submitted", "feature_updated", "prediction_requested"):
        return StreamEvent(raw=raw, event_id=event_id, event_type=event_type, entity_id=entity_id,
                           event_time=event_time, processing_time=processing_time,
                           valid=False, invalid_reason="bad_event_type")
    return StreamEvent(raw=raw, event_id=event_id, event_type=event_type, entity_id=entity_id,
                       event_time=event_time, processing_time=processing_time, valid=True)


def classify(ev: StreamEvent, state: StreamState,
             watermark_seconds: int = WATERMARK_SECONDS,
             late_tolerance: int = LATE_TOLERANCE_SECONDS) -> StreamEvent:
    """Apply application-level watermark + dedup classification."""
    if not ev.valid:
        return ev
    assert ev.event_id is not None and ev.event_time is not None

    if ev.event_id in state.seen_event_ids:
        ev.is_duplicate = True
        return ev

    now_ts = ev.event_time.timestamp()
    if state.watermark:
        wm = datetime.fromisoformat(state.watermark).timestamp()
        if now_ts < wm - watermark_seconds:
            ev.is_too_late = True
            return ev
    if state.watermark:
        wm = datetime.fromisoformat(state.watermark).timestamp()
        if now_ts < wm - late_tolerance:
            ev.is_late = True

    new_wm = max(now_ts, datetime.fromisoformat(state.watermark).timestamp() if state.watermark else 0)
    state.watermark = datetime.fromtimestamp(new_wm).isoformat()
    state.seen_event_ids.append(ev.event_id)
    return ev


def fact_rows(events: list[StreamEvent]) -> list[dict]:
    """Build ODS fact rows for a micro-batch of accepted events."""
    rows = []
    for ev in events:
        rows.append({
            "event_id": ev.event_id,
            "event_type": ev.event_type,
            "source_table": ev.raw.get("source_table"),
            "entity_id": ev.entity_id,
            "event_time": ev.event_time.isoformat() if ev.event_time else None,
            "payload_json": json.dumps(ev.raw.get("payload_json") or {}, ensure_ascii=False),
            "processing_time": ev.processing_time.isoformat(),
        })
    return rows


def table_exists(catalog, full_name: str) -> bool:
    if hasattr(catalog, "table_exists"):
        return bool(catalog.table_exists(full_name))
    try:
        catalog.load_table(full_name)
        return True
    except Exception:
        return False


def append_micro_batch(catalog, rows: list[dict], gate, approval_id: str,
                       batch_id: str) -> int | None:
    """Publish one micro-batch to ods.streaming_events in a single commit.

    The gate's atomic overwrite receives the complete table state, preserving
    append semantics while ensuring authorization, audit, and idempotency are
    applied to the physical write. The caller only advances its checkpoint
    after this succeeds.
    """
    if not rows:
        return None
    target = "ods.streaming_events"
    incoming = pa.Table.from_pylist(rows)
    if table_exists(catalog, target):
        existing = catalog.load_table(target).scan().to_arrow()
        complete = pa.concat_tables([existing, incoming])
    else:
        complete = incoming
    return gate.publish(
        catalog, target, complete, approval_id=approval_id, batch_id=batch_id)


def write_dead_letter(cfg: PipelineConfig, ev: StreamEvent, reason: str) -> None:
    entry = {
        "event_id": ev.event_id,
        "event_type": ev.event_type,
        "entity_id": ev.entity_id,
        "event_time": ev.event_time.isoformat() if ev.event_time else None,
        "processing_time": ev.processing_time.isoformat(),
        "reason": reason,
        "raw": ev.raw,
    }
    path = cfg.outputs_dir / "dead-letter.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
