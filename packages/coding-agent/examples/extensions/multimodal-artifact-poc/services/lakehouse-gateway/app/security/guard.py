"""Security guards: audit logging + simple rate limiting.

Read-only by construction; no credentials, no external auth providers.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AuditLog:
    """Append-only JSONL audit trail (local mode writes to a file; no-op when None)."""

    def __init__(self, path: str | None = None):
        self.path = Path(path) if path else None
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, action: str, **kwargs: Any) -> str:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "action": action,
            "auditId": f"au_{uuid.uuid4().hex[:12]}",
            **kwargs,
        }
        if self.path:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
        return entry["auditId"]


@dataclass
class RateLimiter:
    """Sliding-window rate limit per client (in-memory)."""

    max_requests: int = 60
    window_seconds: float = 60.0
    _hits: dict[str, list[float]] = field(default_factory=dict)

    def allow(self, client_key: str) -> tuple[bool, int]:
        now = time.time()
        bucket = [t for t in self._hits.get(client_key, []) if now - t < self.window_seconds]
        if len(bucket) >= self.max_requests:
            self._hits[client_key] = bucket
            return False, self.max_requests
        bucket.append(now)
        self._hits[client_key] = bucket
        return True, self.max_requests - len(bucket)
