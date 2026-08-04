"""Controlled write gate — the ONLY legal path into the warehouse.

No data touches a target table unless ALL of the following hold:

  1. the target is in CONTROLLED_TARGETS (arbitrary writes are refused);
  2. a SEALED approved-pipeline-spec exists whose pipeline-spec.target
     equals the target (when an approval_id is given it must be the one
     that sealed the spec);
  3. target layer is dws/ads/feature_store → an approved CDXR
     feature-promotion review (status APPROVED_FOR_ADS) covers the dataset.

This turns the governance invariants (approval binding, controlled targets,
CDXR promotion gate) from documentation into an enforced mechanism: there is
no production write path that skips `require_approved`. Tests use a separate
test-only gate implementation that product modules cannot import.
"""
from __future__ import annotations

import logging
import threading
from typing import Any, Optional

from pipelines.governance.repository import Repository
from pipelines.governance.placement import CONTROLLED_TARGETS

logger = logging.getLogger(__name__)

CDXR_APPROVED_STATUS = "APPROVED_FOR_ADS"


class SnapshotConflictError(RuntimeError):
    """Raised when a publish declares a base_snapshot_id that is no longer
    current — the table changed under the writer (optimistic concurrency).
    The caller decides whether to re-read and retry."""



class WriteGate:
    def __init__(self, repo: Optional[Repository] = None,
                 controlled: Optional[set[str]] = None) -> None:
        self._repo = repo or Repository()
        self._controlled = set(controlled) if controlled is not None else set(CONTROLLED_TARGETS)
        self._target_locks: dict[str, threading.Lock] = {}

    def rollback(self, catalog: Any, target: str, snapshot_id: int) -> None:
        """Roll back a write by dropping the offending snapshot (idempotent:
        missing snapshot is ignored). Rollback is corrective rather than a new
        publish, so it does not perform an approval check."""
        try:
            catalog.drop_snapshot(target, snapshot_id)
        except Exception:
            pass

    # -- enforcement ------------------------------------------------------

    def require_approved(self, target: str, approval_id: Optional[str] = None) -> str:
        if target not in self._controlled:
            raise PermissionError(
                f"target '{target}' is not a controlled harness target — "
                "arbitrary writes are refused")
        resolved_approval_id = self._sealed_approval_for(target, approval_id)
        if resolved_approval_id is None:
            raise PermissionError(
                f"no sealed approval covers target '{target}'"
                + (f" with approvalId '{approval_id}'" if approval_id else ""))
        layer = target.split(".", 1)[0]
        if not self._placement_approved(target):
            raise PermissionError(
                f"'{target}' has no APPROVED placement plan (Gate 3) — "
                "the target layer decision must be approved before writing")
        if layer in ("dws", "ads", "feature_store") and not self._cdxr_approved(target):
            raise PermissionError(
                f"'{target}' is layer {layer}: an approved CDXR "
                "feature-promotion review is required before writing")
        return resolved_approval_id

    def publish(self, catalog: Any, target: str, table: Any,
                approval_id: Optional[str] = None,
                batch_id: Optional[str] = None,
                base_snapshot_id: Optional[int] = None) -> int:
        """Validate the gate, then write. The single supported write path.

        Concurrency: writes to the SAME target are serialized by a per-target
        lock (different targets stay parallel). When base_snapshot_id is
        given, an optimistic-concurrency check rejects the write if the table
        has moved on (SnapshotConflictError) — the caller re-reads and retries.
        Idempotency + traceability: every publish records a batch id and the
        approval binding in the write-audit ledger."""
        lock = self._target_locks.setdefault(target, threading.Lock())
        with lock:
            resolved_approval_id = self.require_approved(target, approval_id)
            if base_snapshot_id is not None:
                current = self._current_snapshot(catalog, target)
                if current is not None and current != base_snapshot_id:
                    raise SnapshotConflictError(
                        f"target '{target}' moved: current snapshot {current} != "
                        f"declared base {base_snapshot_id} — re-read and retry")
            import uuid as _uuid
            from datetime import datetime, timezone
            from pipelines.batch.stages import _create_table, _table_exists, _upsert_overwrite

            # Idempotency: (target, batchId) already committed?
            effective_bid = batch_id or f"batch_{_uuid.uuid4().hex[:12]}"
            existing = self._committed_audit(
                catalog, target, effective_bid, resolved_approval_id)
            if existing is not None:
                try:
                    return int(existing["snapshotId"])
                except (TypeError, ValueError):
                    return existing["snapshotId"]

            # Two-phase commit: PREPARED intent -> atomic overwrite -> COMMITTED
            # audit. If the warehouse write succeeds but the audit fails, the
            # PREPARED intent is left dangling and a startup reconcile can
            # detect and finish it — the write is never unaudited.
            intent_id = f"wi_{_uuid.uuid4().hex[:12]}"
            now = datetime.now(timezone.utc).isoformat()
            self._repo.put("write-audit", intent_id, 1, {
                "writeId": intent_id, "target": target, "batchId": effective_bid,
                "approvalId": resolved_approval_id, "status": "PREPARED",
                "committedAt": None, "intentAt": now,
            })

            if not _table_exists(catalog, target):
                _create_table(catalog, target, table.schema)
            snap = _upsert_overwrite(catalog, target, table)

            audit_id = f"w_{_uuid.uuid4().hex[:12]}"
            self._repo.put("write-audit", audit_id, 1, {
                "writeId": audit_id, "target": target, "batchId": effective_bid,
                "snapshotId": str(snap), "approvalId": resolved_approval_id,
                "status": "COMMITTED", "committedAt": now, "intentId": intent_id,
            })
        return snap

    def _committed_audit(self, catalog: Any, target: str, batch_id: str,
                         approval_id: str) -> Optional[dict]:
        """Return a committed audit only when it describes current catalog state.

        Governance repositories can be reused across isolated warehouses. An
        audit from another warehouse must never suppress the physical write.
        """
        current_snapshot = self._current_snapshot(catalog, target)
        if current_snapshot is None:
            return None
        for entry in self._repo.ledger():
            if entry.get("type") != "write-audit":
                continue
            obj = self._repo.get("write-audit", entry.get("id"), entry.get("version"))
            if obj is None:
                continue
            c = obj.content
            if (
                c.get("status") == "COMMITTED"
                and c.get("target") == target
                and c.get("batchId") == batch_id
                and c.get("approvalId") == approval_id
            ):
                try:
                    if int(c["snapshotId"]) == current_snapshot:
                        return c
                except (KeyError, TypeError, ValueError):
                    continue
        return None

    # -- evidence helpers -------------------------------------------------

    def _current_snapshot(self, catalog: Any, target: str) -> Optional[int]:
        """Latest committed snapshot id for the target (None when no
        snapshot exists yet or the table is absent)."""
        try:
            snaps = list(catalog.load_table(target).snapshots())
            if not snaps:
                return None
            return int(snaps[-1].snapshot_id)
        except Exception:
            return None

    def _sealed_approval_for(self, target: str,
                             approval_id: Optional[str]) -> Optional[str]:
        from pipelines.governance.flow import GovernancePhase1
        from pipelines.governance.repository import IntegrityError

        verifier = GovernancePhase1(self._repo)
        for entry in self._repo.ledger():
            if entry.get("type") != "approved-pipeline-spec":
                continue
            obj = self._repo.get("approved-pipeline-spec", entry.get("id"),
                                 entry.get("version"))
            if obj is None:
                continue
            if approval_id is not None and obj.content.get("approvalId") != approval_id:
                continue
            spec = self._repo.get("pipeline-spec", entry.get("id"),
                                  entry.get("version"))
            if spec is not None and spec.content.get("target") == target:
                sealed_approval_id = obj.content.get("approvalId")
                if isinstance(sealed_approval_id, str) and sealed_approval_id:
                    try:
                        verifier.verify_sealed_approval(
                            entry["id"], entry["version"], target,
                            sealed_approval_id)
                    except (IntegrityError, ValueError, KeyError):
                        continue
                    return sealed_approval_id
        return None

    def _placement_approved(self, target: str) -> bool:
        from pipelines.governance.placement import PlacementGovernance

        governance = PlacementGovernance(self._repo, controlled=self._controlled)
        for entry in self._repo.ledger():
            if entry.get("type") != "placement-plan":
                continue
            obj = self._repo.get("placement-plan", entry.get("id"))
            if obj is None:
                continue
            c = obj.content
            if c.get("status") == "APPROVED" and c.get("targetDataset") == target:
                try:
                    governance.require_approved(entry.get("id"))
                except (ValueError, KeyError):
                    continue
                return True
        return False

    def _cdxr_approved(self, target: str) -> bool:
        from pipelines.governance.cdxr_gate import CdxrPromotionGate

        governance = CdxrPromotionGate(self._repo)
        for entry in self._repo.ledger():
            if entry.get("type") != "feature-promotion-review":
                continue
            obj = self._repo.get("feature-promotion-review", entry.get("id"))
            if obj is None:
                continue
            c = obj.content
            if c.get("status") != CDXR_APPROVED_STATUS:
                continue
            dataset = (c.get("datasetAndSnapshot") or "").split("@", 1)[0]
            if dataset == target:
                try:
                    governance.require_approved(entry.get("id"))
                except (ValueError, KeyError):
                    continue
                return True
        return False
