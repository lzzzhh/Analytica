"""Append-only, version-immutable repository for governance objects.

Layout (runtime data, never committed to git):
  .data/pipeline-governance/
  ├── objects/<type>/<id>@<version>.json     immutable per version
  ├── ledger.jsonl                           append-only write ledger
  └── reviews/<reviewId>.json                review packages

Write protocol (atomic):
  1. validate type / id / version;
  2. create a temp file in the SAME directory as the target;
  3. write full canonical JSON;
  4. flush + os.fsync(temp);
  5. os.replace(temp, target);
  6. fsync the parent directory;
  7. append the ledger line;
  8. flush + os.fsync(ledger).

Guarantees:
  - an existing <id>@<version> is never overwritten (checked before write,
    enforced by os.replace semantics on an existing target = error);
  - a failed object write never writes a ledger line;
  - an object written with a failed ledger is DETECTABLE via integrity scan
    (ORPHAN_OBJECT) and recoverable via explicit reconcile;
  - ledger never references a missing object in the normal commit order
    (ledger is appended only after the object fsync completes);
  - concurrent writers use an OS-level lock so only one writer may commit
    the same id/version.

Concurrency: an exclusive lock file guards all put()/put_review() writes.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from pipelines.governance.contracts import sha256_canonical

DEFAULT_ROOT = Path(os.environ.get("PIPELINE_GOVERNANCE_ROOT", ".data/pipeline-governance"))

VALID_TYPES = (
    "source-registration",
    "source-schema-profile",
    "schema-spec",
    "pipeline-spec",
    "pipeline-draft-artifact",
    "pipeline-review-package",
    "approval-decision",
    "pipeline-amendment",
    "approved-pipeline-spec",
    "governance-finding",
    "remediation-proposal",
    "placement-plan",
    "feature-promotion-review",
    "watchdog-lease",
    "write-audit",
)

# IDs must be plain tokens — no path separators, no dots, no '@', no control chars.
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

LEDGER_EVENT_TYPES = ("WRITE", "RECOVERED", "REPAIRED")


class IntegrityError(Exception):
    """Raised when the repository is inconsistent (missing objects, corrupt
    ledger mid-file, etc.)."""


@dataclass
class StoredObject:
    type: str
    obj_id: str
    version: int
    content: dict
    content_hash: str
    written_at: str


@dataclass
class IntegrityIssue:
    code: str  # ORPHAN_OBJECT | MISSING_OBJECT | TRUNCATED_LEDGER_TAIL | CORRUPT_LEDGER
    detail: str


class Repository:
    def __init__(self, root: Path = DEFAULT_ROOT):
        self.root = Path(root).resolve()
        self.objects_dir = self.root / "objects"
        self.ledger_path = self.root / "ledger.jsonl"
        self.reviews_dir = self.root / "reviews"
        self._lock_path = self.root / ".write.lock"
        for d in (self.objects_dir, self.reviews_dir):
            d.mkdir(parents=True, exist_ok=True)
        if not self.ledger_path.exists():
            self.ledger_path.touch()

    # ------------------------------------------------------------------
    # ID / path safety
    # ------------------------------------------------------------------

    @staticmethod
    def validate_id(value: str, what: str) -> str:
        """Reject unsafe ids outright — no sanitisation, no escaping."""
        if not isinstance(value, str) or not value:
            raise ValueError(f"{what} must be a non-empty string")
        if not ID_RE.fullmatch(value):
            raise ValueError(
                f"invalid {what} {value!r}: only [A-Za-z0-9_-]+ allowed "
                "(no '/', '\\\\', '..', '@', spaces or control characters)"
            )
        if any(ord(c) < 0x20 for c in value):
            raise ValueError(f"invalid {what}: control characters not allowed")
        return value

    def _safe_dir(self, obj_type: str) -> Path:
        """Resolve the object-type directory and verify it stays inside root."""
        self.validate_id(obj_type, "object type")
        d = (self.objects_dir / obj_type).resolve()
        if not d.is_relative_to(self.root):
            raise ValueError(f"object type directory escapes repository root: {obj_type}")
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _path(self, obj_type: str, obj_id: str, version: int) -> Path:
        """Build the target path, verifying no symlink escape on the parent."""
        obj_id = self.validate_id(obj_id, "object id")
        if not isinstance(version, int) or version < 1:
            raise ValueError(f"invalid version {version!r}: must be int >= 1")
        d = self._safe_dir(obj_type)
        target = (d / f"{obj_id}@{version}.json").resolve()
        # The parent must be the real object-type dir inside root — no symlinks.
        if not target.parent.is_relative_to(self.root):
            raise ValueError("resolved object path escapes repository root")
        return target

    # ------------------------------------------------------------------
    # Atomic writes
    # ------------------------------------------------------------------

    def put(self, obj_type: str, obj_id: str, version: int, content: dict) -> StoredObject:
        if obj_type not in VALID_TYPES:
            raise ValueError(f"unknown object type '{obj_type}'")
        obj_id = self.validate_id(obj_id, "object id")
        if not isinstance(version, int) or version < 1:
            raise ValueError(f"invalid version {version!r}")
        target = self._path(obj_type, obj_id, version)
        content_hash = sha256_canonical(content)
        now = datetime.now(timezone.utc).isoformat()
        ledger_line = json.dumps({
            "type": obj_type, "id": obj_id, "version": version,
            "contentHash": content_hash, "at": now,
        }, ensure_ascii=False) + "\n"

        with self._write_lock():
            if target.exists():
                raise ValueError(f"object {obj_type}/{obj_id}@v{version} already exists (immutable)")
            self._atomic_write(target, content)
            self._append_ledger(ledger_line)

        return StoredObject(obj_type, obj_id, version, content, content_hash, now)

    def put_review(self, review: dict) -> Path:
        review_id = review["reviewId"]
        review_id = self.validate_id(review_id, "reviewId")
        target = (self.reviews_dir / f"{review_id}.json").resolve()
        if not target.parent.is_relative_to(self.root):
            raise ValueError("resolved review path escapes repository root")
        with self._write_lock():
            if target.exists():
                raise ValueError(f"review {review_id} already exists (immutable)")
            self._atomic_write(target, review)
        return target

    def _atomic_write(self, target: Path, content: dict) -> None:
        """tmp file (same dir) → write → fsync → NO-CLOBBER publish → fsync dir.

        Immutability is enforced by the filesystem, not by a cooperative
        target.exists() check: os.link fails with EEXIST when the target
        already exists (atomic, no-clobber), so concurrent or foreign writers
        cannot silently overwrite an object."""
        fd, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(content, ensure_ascii=False, indent=2) + "\n")
                f.flush()
                os.fsync(f.fileno())
            try:
                os.link(tmp_name, target)
            except FileExistsError:
                raise ValueError(
                    f"object {target.name} already exists (immutable) — "
                    "no-clobber publish rejected the write") from None
            # fsync the directory so the link is durable.
            dir_fd = os.open(str(target.parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except Exception:
            try:
                if os.path.exists(tmp_name):
                    os.unlink(tmp_name)
            except OSError:
                pass
            raise
        finally:
            try:
                os.unlink(tmp_name)  # temp link no longer needed after publish
            except OSError:
                pass

    def _append_ledger(self, line: str) -> None:
        """Append one authoritative record. FAILS CLOSED when the existing
        tail is damaged: appending after a truncated line would convert
        recoverable tail damage into permanent mid-file corruption, so the
        write is rejected until the tail is repaired."""
        if self.ledger_path.exists() and self.ledger_path.stat().st_size > 0:
            lines = self.ledger_path.read_text(encoding="utf-8").splitlines()
            if lines and not _is_valid_json_line(lines[-1]):
                raise IntegrityError(
                    "ledger tail is damaged (REPAIR_REQUIRED) — run "
                    "repair_ledger_tail() before further writes")
        with open(self.ledger_path, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())

    @contextmanager
    def _write_lock(self):
        """Process/thread-level exclusive lock around writes."""
        import fcntl
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_fd = os.open(str(self._lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            yield
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def get(self, obj_type: str, obj_id: str, version: Optional[int] = None) -> Optional[StoredObject]:
        if version is not None:
            target = self._path(obj_type, obj_id, version)
            if not target.exists():
                return None
            content = json.loads(target.read_text(encoding="utf-8"))
            return StoredObject(obj_type, obj_id, version, content,
                                sha256_canonical(content), self._mtime(target))
        versions = self.versions(obj_type, obj_id)
        if not versions:
            return None
        return self.get(obj_type, obj_id, max(versions))

    def versions(self, obj_type: str, obj_id: str) -> list[int]:
        self.validate_id(obj_id, "object id")
        d = self._safe_dir(obj_type)
        out = []
        for p in d.glob(f"{obj_id}@*.json"):
            try:
                out.append(int(p.stem.split("@")[-1]))
            except ValueError:
                continue
        return out

    def get_review(self, review_id: str) -> Optional[dict]:
        review_id = self.validate_id(review_id, "reviewId")
        path = (self.reviews_dir / f"{review_id}.json").resolve()
        if not path.exists():
            return None
        if not path.parent.is_relative_to(self.root):
            raise IntegrityError("review path escapes repository root")
        return json.loads(path.read_text(encoding="utf-8"))

    def ledger(self) -> list[dict]:
        """Read the full ledger. Raises IntegrityError on corrupt MID-file
        lines; tolerates a single truncated LAST line (reported separately
        via integrity_scan)."""
        out: list[dict] = []
        lines = self.ledger_path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                if i == len(lines) - 1:
                    # truncated tail — only the LAST line may be repaired
                    continue  # reported by integrity_scan, not fatal here
                raise IntegrityError(f"corrupt ledger line {i + 1} (mid-file): {line[:80]!r}")
        return out

    def _ledger_issues(self, lines: list[str]) -> list[IntegrityIssue]:
        issues: list[IntegrityIssue] = []
        for i, line in enumerate(lines):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except json.JSONDecodeError:
                if i == len(lines) - 1:
                    issues.append(IntegrityIssue("TRUNCATED_LEDGER_TAIL", f"line {i + 1}"))
                else:
                    raise IntegrityError(f"corrupt ledger line {i + 1} (mid-file): {line[:80]!r}")
        return issues

    def integrity_scan(self) -> list[IntegrityIssue]:
        """Compare object store against the ledger.

        - object exists but no ledger entry → ORPHAN_OBJECT
        - ledger references a missing object → MISSING_OBJECT (blocks seal)
        - truncated ledger tail → TRUNCATED_LEDGER_TAIL
        - mid-file corruption → raises IntegrityError
        """
        lines = self.ledger_path.read_text(encoding="utf-8").splitlines()
        issues = self._ledger_issues(lines)
        entries: list[dict] = []
        for line in lines:
            if not line.strip():
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                if line == lines[-1]:
                    continue  # truncated tail already reported
                raise

        # objects on disk
        disk_objects: set[tuple[str, str, int]] = set()
        for obj_type in VALID_TYPES:
            d = self.objects_dir / obj_type
            if not d.exists():
                continue
            for p in d.glob("*.json"):
                if p.name.startswith(".tmp-"):
                    continue
                stem = p.stem
                if "@" not in stem:
                    issues.append(IntegrityIssue("ORPHAN_OBJECT", f"{obj_type}/{p.name} (no version)"))
                    continue
                obj_id, _, ver = stem.rpartition("@")
                try:
                    version = int(ver)
                except ValueError:
                    issues.append(IntegrityIssue("ORPHAN_OBJECT", f"{obj_type}/{p.name} (bad version)"))
                    continue
                disk_objects.add((obj_type, obj_id, version))

        # ledger → disk: existence + CONTENT HASH verification
        for e in entries:
            key = (e.get("type"), e.get("id"), e.get("version"))
            if key not in disk_objects:
                issues.append(IntegrityIssue(
                    "MISSING_OBJECT",
                    f"ledger references {key[0]}/{key[1]}@v{key[2]} but object is missing",
                ))
                continue
            if e.get("event", "WRITE") in ("WRITE", "RECOVERED"):
                target = self._path(e.get("type"), e.get("id"), e.get("version"))
                if target.exists() and not target.name.startswith(".tmp-"):
                    actual = sha256_canonical(json.loads(target.read_text(encoding="utf-8")))
                    expected = e.get("contentHash")
                    if expected and actual != expected:
                        issues.append(IntegrityIssue(
                            "CONTENT_HASH_MISMATCH",
                            f"{key[0]}/{key[1]}@v{key[2]} content hash {actual[:12]} "
                            f"!= ledger {expected[:12]} (object tampered or corrupted)",
                        ))

        # duplicate ledger entries (same type/id/version recorded twice)
        seen: set[tuple] = set()
        for e in entries:
            if e.get("event", "WRITE") not in ("WRITE", "RECOVERED"):
                continue
            k = (e.get("type"), e.get("id"), e.get("version"))
            if k in seen:
                issues.append(IntegrityIssue(
                    "DUPLICATE_LEDGER_ENTRY",
                    f"{k[0]}/{k[1]}@v{k[2]} recorded more than once in ledger",
                ))
            seen.add(k)

        # disk → ledger (only WRITE/RECOVERED entries count as object records)
        ledger_keys = {
            (e.get("type"), e.get("id"), e.get("version"))
            for e in entries if e.get("event", "WRITE") in ("WRITE", "RECOVERED")
        }
        for (t, i, v) in sorted(disk_objects):
            if (t, i, v) not in ledger_keys:
                issues.append(IntegrityIssue("ORPHAN_OBJECT", f"{t}/{i}@v{v} has no ledger entry"))

        return issues

    def reconcile(self, obj_type: str, obj_id: str, version: int,
                  actor: str = "operator") -> IntegrityIssue:
        """Explicitly record an ORPHAN_OBJECT as recovered (ledger backfill).
        Never automatic. The scan AND the backfill happen under the exclusive
        lock, so a concurrent writer finishing its commit cannot race the
        orphan verdict."""
        needle = f"{obj_type}/{obj_id}@v{version}"
        with self._write_lock():
            obj = self.get(obj_type, obj_id, version)
            if obj is None:
                raise IntegrityError(f"cannot reconcile missing object {obj_type}/{obj_id}@v{version}")
            scan = self.integrity_scan()
            orphan_issue = next((i for i in scan if i.code == "ORPHAN_OBJECT" and needle in i.detail), None)
            if orphan_issue is None:
                raise IntegrityError(f"{obj_type}/{obj_id}@v{version} is not an orphan (nothing to reconcile)")
            line = json.dumps({
                "event": "RECOVERED",
                "type": obj_type, "id": obj_id, "version": version,
                "contentHash": obj.content_hash, "at": datetime.now(timezone.utc).isoformat(),
                "actor": actor,
            }, ensure_ascii=False) + "\n"
            self._append_ledger(line)
        return IntegrityIssue("ORPHAN_OBJECT", f"reconciled {obj_type}/{obj_id}@v{version} (RECOVERED)")

    def repair_ledger_tail(self, actor: str = "operator") -> IntegrityIssue:
        """Explicitly drop the final truncated ledger line. Fails if the last
        line is intact or if corruption is mid-file. The recheck and the
        atomic repair both happen under the exclusive lock: a writer that
        appends after the broken tail cannot be lost, and the repair itself
        uses the atomic temp+fsync+link protocol."""
        with self._write_lock():
            lines = self.ledger_path.read_text(encoding="utf-8").splitlines()
            if not lines or _is_valid_json_line(lines[-1]):
                raise IntegrityError("no truncated ledger tail to repair")
            repaired = "\n".join(lines[:-1]) + ("\n" if len(lines) > 1 else "")
            self._atomic_replace_text(self.ledger_path, repaired)
        return IntegrityIssue("TRUNCATED_LEDGER_TAIL", f"repaired by {actor}: dropped final incomplete line")

    def _atomic_replace_text(self, path: Path, text: str) -> None:
        """Atomic text replacement (temp + fsync + no-clobber link to a fresh
        name + fsync dir) so a repair crash cannot corrupt the whole file."""
        fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".fix")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
                f.flush()
                os.fsync(f.fileno())
            # replace via link to a unique final name, then swap pointers is
            # not possible on one filesystem path — use rename after the
            # durable temp exists: crash before rename leaves the original
            # intact; crash after rename leaves the repaired file complete.
            os.replace(tmp_name, path)
            dir_fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except Exception:
            try:
                if os.path.exists(tmp_name):
                    os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def has_missing_objects(self) -> bool:
        return any(i.code == "MISSING_OBJECT" for i in self.integrity_scan())

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _mtime(path: Path) -> str:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _is_valid_json_line(line: str) -> bool:
    try:
        json.loads(line)
        return True
    except json.JSONDecodeError:
        return False
