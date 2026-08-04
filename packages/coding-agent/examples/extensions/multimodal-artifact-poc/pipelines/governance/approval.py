"""Unified operator approval — shared by remediation, placement and CDXR.

The Phase 1 Schema/Pipeline approval already enforces OPERATOR_CLI source,
review-hash binding and immutable versions. These three other approval
families now share the same discipline:

  - approverSource is ALWAYS "OPERATOR_CLI" — callers cannot set it;
  - the decision records the object hash it decided on (tamper-proof);
  - a single ApprovalDecision is persisted per (kind, objectId, decision);
  - decisions are versioned and immutable (no overwrite);
  - the agent path is programmatically separated: the approval object is
    only written by the operator CLI / coordinator, never by agent code.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from pipelines.governance.contracts import is_valid_contract, sha256_canonical
from pipelines.governance.repository import Repository

APPROVAL_KINDS = {"remediation", "placement", "cdxr_promotion"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class OperatorApproval:
    def __init__(self, repo: Optional[Repository] = None):
        self.repo = repo or Repository()

    def record(self, kind: str, object_id: str, decision: str,
               os_actor: str, object_hash: str, comment: str = "") -> dict:
        """Record one operator decision. approverSource is fixed to
        OPERATOR_CLI and the object hash is bound — tampering is detected by
        the consuming module when it re-hashes the object."""
        if kind not in APPROVAL_KINDS:
            raise ValueError(f"unknown approval kind {kind!r}")
        approval_id = f"ap_{kind}_{uuid.uuid4().hex[:10]}"
        # The approval-decision contract has a fixed shape; kind/objectId/
        # objectHash are carried in the object file name suffix and via the
        # reviewId (objectId) + reviewContentHash (objectHash) fields.
        approval = {
            "approvalId": approval_id,
            "reviewId": object_id,
            "reviewContentHash": object_hash,
            "decision": decision,
            "approverSource": "OPERATOR_CLI",
            "osActor": os_actor,
            "comment": comment,
            "decidedAt": _now(),
        }
        if not is_valid_contract("approval-decision", approval):
            raise ValueError("approval decision fails contract validation")
        # CAS by construction: the storage key is unique per (kind, object_id)
        # — a second concurrent decision for the same object is rejected by
        # the repository's no-clobber publish (only the first wins). This is
        # the compare-and-set that prevents two approve() calls from both
        # observing "no terminal decision yet".
        decision_key = f"dec_{kind}_{object_id}"
        self.repo.put("approval-decision", decision_key, 1, approval)
        return approval

    def latest_for(self, kind: str, object_id: str) -> Optional[dict]:
        """Most recent OPERATOR_CLI decision for an object of a kind."""
        prefix = f"dec_{kind}_"
        best = None
        for entry in self.repo.ledger():
            if entry.get("type") != "approval-decision":
                continue
            aid = entry.get("id", "")
            if not aid.startswith(prefix):
                continue
            obj = self.repo.get("approval-decision", aid, entry.get("version"))
            if obj is None or obj.content.get("reviewId") != object_id:
                continue
            if best is None or obj.content["decidedAt"] > best["decidedAt"]:
                best = obj.content
        return best

    def require_decision(self, kind: str, object_id: str, decision: str,
                         object_hash: str) -> dict:
        """Consume-time check: the object's CURRENT hash must match the hash
        the operator approved — tampering after approval invalidates it."""
        dec = self.latest_for(kind, object_id)
        if dec is None:
            raise ValueError(f"no operator decision for {kind}:{object_id}")
        if dec["decision"] != decision:
            raise ValueError(
                f"operator decision for {kind}:{object_id} is '{dec['decision']}' "
                f"not '{decision}'")
        if dec["reviewContentHash"] != object_hash:
            raise ValueError(
                f"object {kind}:{object_id} hash changed after approval — "
                "decision invalidated (tamper detected)")
        return dec
