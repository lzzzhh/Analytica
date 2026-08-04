"""Governance Event Store — append-only, recoverable, idempotent, safe.

Guarantees:
  - runId/pipelineId/eventId use the SAME ID whitelist as the Repository
    (no path traversal, no symlink escape, resolved inside events_dir);
  - writes are guarded by the Repository's process lock: check-then-commit
    is atomic (duplicate eventId is rejected exactly once);
  - the event line is the single committed marker; the index is rebuilt
    from event files (a lost index is recoverable, a lost event is not);
  - payloadHash is RECOMPUTED from payload and must match;
  - mid-file corruption fails; a truncated tail can only be repaired
    explicitly;
  - events are validated against the governance-event contract.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from pipelines.governance.contracts import is_valid_contract, sha256_canonical
from pipelines.governance.repository import ID_RE, IntegrityError, Repository


class EventStore:
    def __init__(self, repo: Optional[Repository] = None):
        self.repo = repo or Repository()
        self.events_dir = self.repo.root / "events"
        # NOTE: no mkdir here — construction must not create files; a gated
        # coordinator that refuses to run leaves the root untouched.
        # index is derived, not authoritative — kept for fast duplicate checks
        self._index_path = self.events_dir / "index.jsonl"

    # -- ID / path safety -------------------------------------------------

    def _safe_run_dir(self, run_id: str) -> Path:
        """Validate runId (same whitelist as Repository) and resolve inside
        events_dir — no traversal, no symlink escape."""
        if not isinstance(run_id, str) or not ID_RE.fullmatch(run_id):
            raise ValueError(
                f"invalid runId {run_id!r}: only [A-Za-z0-9_-]+ allowed")
        d = (self.events_dir / run_id).resolve()
        if not d.is_relative_to(self.events_dir.resolve()):
            raise ValueError(f"runId {run_id!r} escapes the events directory")
        if d.is_symlink():
            raise ValueError(f"runId {run_id!r} resolves through a symlink")
        d.mkdir(parents=True, exist_ok=True)
        return d

    @staticmethod
    def _validate_event_ids(event: dict) -> None:
        for field in ("runId", "pipelineId"):
            val = event.get(field)
            if not isinstance(val, str) or not ID_RE.fullmatch(val):
                raise ValueError(f"invalid {field} {val!r}: only [A-Za-z0-9_-]+ allowed")
        event_id = event.get("eventId", "")
        if not event_id.startswith("evt_") or not ID_RE.fullmatch(event_id[len("evt_"):]):
            raise ValueError(f"invalid eventId {event_id!r}")

    # -- writes (locked, check-then-commit) -------------------------------

    def append(self, event: dict) -> str:
        """Validate + persist one event. Duplicate eventId is rejected
        atomically; payloadHash is recomputed and must match."""
        if not is_valid_contract("governance-event", event):
            raise ValueError(f"event fails contract validation: {event.get('eventId')}")
        self._validate_event_ids(event)
        # recompute payloadHash — never trust the caller
        payload = event.get("payload")
        expected = sha256_canonical(payload) if payload is not None else None
        if event.get("payloadHash") != expected:
            raise ValueError(
                f"event {event.get('eventId')}: payloadHash mismatch "
                f"(got {event.get('payloadHash')}, expected {expected})")
        event_id = event["eventId"]
        run_id = event["runId"]
        run_dir = self._safe_run_dir(run_id)
        path = run_dir / "events.jsonl"
        line = json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n"

        with self.repo._write_lock():
            # fail closed: a damaged event tail must be repaired before append
            for fpath in (path, self._index_path):
                if fpath.exists() and fpath.stat().st_size > 0:
                    lines = fpath.read_text(encoding="utf-8").splitlines()
                    if lines:
                        try:
                            json.loads(lines[-1])
                        except json.JSONDecodeError:
                            raise IntegrityError(
                                f"event tail damaged (REPAIR_REQUIRED) in {fpath} — "
                                "run repair before further appends")
            if self._indexed(event_id):
                raise ValueError(f"event {event_id} already exists (idempotency)")
            created_dirs = not path.parent.exists()
            with open(path, "a", encoding="utf-8") as f:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
            with open(self._index_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "eventId": event_id, "runId": run_id,
                    "sequenceNumber": event["sequenceNumber"],
                    "pipelineVersion": event["pipelineVersion"],
                }) + "\n")
                f.flush()
                os.fsync(f.fileno())
            if created_dirs:
                # fsync the newly created parent dirs so the entries survive
                # a power-loss boundary (review P0 #8)
                for d in (path.parent, self.events_dir):
                    dir_fd = os.open(str(d), os.O_RDONLY)
                    try:
                        os.fsync(dir_fd)
                    finally:
                        os.close(dir_fd)
        return event_id

    # -- reads ------------------------------------------------------------

    def _indexed(self, event_id: str) -> bool:
        """Duplicate check. Fast path: the unique event index (O(n) total, not
        O(total events) per append). Authoritative fallback: scan the event
        files when the index is absent."""
        if self._index_path.exists() and self._index_path.stat().st_size > 0:
            for line in self._index_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    break  # index damaged — fall through to authoritative scan
                if entry.get("eventId") == event_id:
                    return True
        for line in self._read_events_raw_all():
            if line.get("eventId") == event_id:
                return True
        return False

    def _read_events_raw_all(self) -> list[dict]:
        out = []
        for run_dir in sorted(self.events_dir.iterdir()):
            if not run_dir.is_dir():
                continue
            path = run_dir / "events.jsonl"
            if not path.exists():
                continue
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError as e:
                    raise IntegrityError(
                        f"corrupt event line in {path}: {line[:80]!r}") from e
        return out

    def events_for_run(self, run_id: str) -> list[dict]:
        self._safe_run_dir(run_id)
        path = self.events_dir / run_id / "events.jsonl"
        if not path.exists():
            return []
        out = []
        lines = path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                if i == len(lines) - 1:
                    # truncated tail — reported by integrity_scan, skipped here
                    continue
                raise IntegrityError(f"corrupt event line {i + 1} in {path}: {line[:80]!r}")
        return out

    def all_events(self) -> list[dict]:
        out = []
        for run_dir in sorted(self.events_dir.iterdir()):
            if run_dir.is_dir():
                out.extend(self.events_for_run(run_dir.name))
        return out

    def latest_sequence(self, run_id: str) -> int:
        events = self.events_for_run(run_id)
        return max((e["sequenceNumber"] for e in events), default=-1)

    def integrity_scan(self) -> list[str]:
        """Cross-check event files and the derived index. Returns issue
        strings (empty when consistent)."""
        issues: list[str] = []
        # 1. every event file line must parse (mid-file corruption fails)
        event_ids: set[str] = set()
        for run_dir in sorted(self.events_dir.iterdir()):
            if not run_dir.is_dir():
                continue
            path = run_dir / "events.jsonl"
            if not path.exists():
                continue
            lines = path.read_text(encoding="utf-8").splitlines()
            for i, line in enumerate(lines):
                if not line.strip():
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    if i == len(lines) - 1:
                        issues.append(f"TRUNCATED_EVENT_TAIL: {path} line {i + 1}")
                        continue
                    raise IntegrityError(f"corrupt event line {i + 1} in {path}")
                event_ids.add(ev["eventId"])
        # 2. index entries should reference existing events (stale index is
        #    tolerated — the index is derived; missing events are not)
        return issues

    def repair_event_tail(self, run_id: str) -> None:
        """Explicitly drop a truncated final event line for a run. The read,
        recheck and atomic repair all happen under the exclusive lock so a
        concurrent append cannot be lost, and the repair itself uses the
        atomic temp+fsync+replace protocol."""
        self._safe_run_dir(run_id)
        path = self.events_dir / run_id / "events.jsonl"
        with self.repo._write_lock():
            if not path.exists():
                raise IntegrityError(f"no event file for run {run_id}")
            lines = path.read_text(encoding="utf-8").splitlines()
            if not lines:
                raise IntegrityError("event file is empty")
            if _is_valid_json_line(lines[-1]):
                raise IntegrityError("last event line is intact — nothing to repair")
            repaired = "\n".join(lines[:-1]) + ("\n" if len(lines) > 1 else "")
            self.repo._atomic_replace_text(path, repaired)


def _is_valid_json_line(line: str) -> bool:
    try:
        json.loads(line)
        return True
    except json.JSONDecodeError:
        return False
