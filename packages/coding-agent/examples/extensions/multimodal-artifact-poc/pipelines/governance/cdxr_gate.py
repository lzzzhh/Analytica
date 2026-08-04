"""CDXR feature promotion gate — DWS candidate → ADS / Feature Store.

Triggered by the DWS_FEATURE_CANDIDATE_READY event. Runs the existing
assess_training_data (injected caller; in tests a stub, in production the
gateway endpoint) with an explicit training-use description, wraps the CDXR
assessment into a FeaturePromotionReviewPackage, and requires an operator
decision before the feature may enter ADS / Feature Store.

CDXR is NOT a final approver — the operator is. Any requested change must
produce a new SchemaSpec/PipelineSpec version, re-process, re-run CDXR and
create a NEW review package (old approvals are invalidated).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Callable, Optional

from pipelines.governance.contracts import is_valid_contract
from pipelines.governance.repository import Repository

# Callable: training-use dict -> CDXR assessment dict (injected; stub in tests)
CdxrCaller = Callable[[dict], dict]

PROMOTION_DECISIONS = {
    "APPROVE", "REMOVE_FEATURE", "REQUEST_SCHEMA_CHANGE",
    "REQUEST_PIPELINE_CHANGE", "CHANGE_TIME_WINDOW", "ACCEPT_WITH_WAIVER",
    "REJECT",
}

# CDXR statuses that a plain APPROVE may promote without a waiver.
PROMOTABLE_CDXR_STATUSES = {"ALLOW", "REVIEW"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class CdxrPromotionGate:
    def __init__(self, repo: Optional[Repository] = None,
                 cdxr_caller: Optional[CdxrCaller] = None):
        self.repo = repo or Repository()
        from pipelines.governance.approval import OperatorApproval
        from pipelines.governance.contracts import sha256_canonical as _sha
        self.approvals = OperatorApproval(repo)
        self._sha = _sha
        self.cdxr_caller = cdxr_caller

    def _require_caller(self) -> CdxrCaller:
        if self.cdxr_caller is None:
            raise ValueError(
                "no real CDXR caller injected — a plain APPROVE requires "
                "an actual assessment; use ACCEPT_WITH_WAIVER only with "
                "an explicit operator waiver")
        return self.cdxr_caller

    def on_feature_candidate(self, pipeline_id: str, run_id: str,
                             dataset_and_snapshot: str, training_use: dict) -> dict:
        """DWS_FEATURE_CANDIDATE_READY → run CDXR → review package.

        The dataset/snapshot used for the assessment MUST be the one named in
        the training use — the caller receives both and must evaluate the
        SAME dataset the review claims to cover."""
        caller = self._require_caller()
        # bind dataset: trainingUse.datasetAndSnapshot must match the argument
        tu_dataset = training_use.get("datasetAndSnapshot")
        if tu_dataset is not None and tu_dataset != dataset_and_snapshot:
            raise ValueError(
                f"trainingUse.datasetAndSnapshot ({tu_dataset}) does not match "
                f"the review dataset ({dataset_and_snapshot})")
        training_use = {**training_use,
                        "datasetAndSnapshot": dataset_and_snapshot,
                        "pipelineId": pipeline_id, "runId": run_id}
        assessment = caller(training_use)
        review = {
            "reviewId": _new_id("fp"),
            "pipelineId": pipeline_id,
            "runId": run_id,
            "datasetAndSnapshot": dataset_and_snapshot,
            "trainingUse": training_use,
            "cdxrAssessment": assessment,
            "status": "PENDING_DECISION",
            "decidedBy": None,
            "decidedAt": None,
        }
        if not is_valid_contract("feature-promotion-review", review):
            raise ValueError("invalid feature promotion review")
        self.repo.put("feature-promotion-review", review["reviewId"], 1, review)
        return review

    def decide(self, review_id: str, decision: str, os_actor: str,
               comment: str = "") -> dict:
        """Operator decision. APPROVE only for promotable CDXR statuses;
        BLOCK / INSUFFICIENT_EVIDENCE require ACCEPT_WITH_WAIVER with a
        mandatory comment. Every other decision keeps the feature out."""
        if decision not in PROMOTION_DECISIONS:
            raise ValueError(f"invalid decision {decision!r}")
        obj = self.repo.get("feature-promotion-review", review_id, 1)
        if obj is None:
            raise ValueError(f"review {review_id} not found")
        review = obj.content
        if review["status"] != "PENDING_DECISION":
            raise ValueError(f"review {review_id} already decided")
        if decision == "REMOVE_FEATURE":
            raise ValueError(
                "REMOVE_FEATURE requires a new SchemaSpec/PipelineSpec version "
                "and a NEW CDXR review — use request_change instead")

        cdxr_status = review["cdxrAssessment"].get("status", "")
        if decision == "APPROVE":
            if cdxr_status not in PROMOTABLE_CDXR_STATUSES:
                raise ValueError(
                    f"CDXR assessment is '{cdxr_status}' — plain APPROVE is not "
                    f"allowed; only ACCEPT_WITH_WAIVER (with mandatory comment) "
                    f"may override")
            new_status = "APPROVED_FOR_ADS"
        elif decision == "ACCEPT_WITH_WAIVER":
            if not comment.strip():
                raise ValueError("ACCEPT_WITH_WAIVER requires a non-empty comment")
            new_status = "APPROVED_FOR_ADS"
        else:
            new_status = "REJECTED"

        decided = {**review, "status": new_status,
                   "decidedBy": os_actor, "decidedAt": _now(),
                   "decision": decision, "comment": comment}
        self.approvals.record("cdxr_promotion", review_id, decision, os_actor,
                              self._sha(decided), comment)
        self.repo.put("feature-promotion-review", review_id, 2, decided)
        return decided

    def request_change(self, review_id: str, os_actor: str,
                       reason: str) -> dict:
        """REQUEST_SCHEMA_CHANGE / REQUEST_PIPELINE_CHANGE / CHANGE_TIME_WINDOW:
        invalidate this review and require a fresh cycle (new spec version,
        re-process, re-run CDXR, new review package)."""
        obj = self.repo.get("feature-promotion-review", review_id, 1)
        if obj is None:
            raise ValueError(f"review {review_id} not found")
        review = obj.content
        changed = {**review, "status": "CHANGES_REQUESTED",
                   "decidedBy": os_actor, "decidedAt": _now(),
                   "changeReason": reason}
        next_v = max(self.repo.versions("feature-promotion-review", review_id)) + 1
        self.repo.put("feature-promotion-review", review_id, next_v, changed)
        # Old approval must never survive a change cycle — the caller must
        # create a new spec version + re-run CDXR for a NEW review id.
        return changed

    def require_approved(self, review_id: str) -> dict:
        """Only APPROVED_FOR_ADS may enter ADS / Feature Store, and only
        when the review hash is unchanged since the operator decision."""
        obj = self.repo.get("feature-promotion-review", review_id)
        if obj is None or obj.content["status"] != "APPROVED_FOR_ADS":
            raise ValueError(f"feature promotion {review_id} is not APPROVED_FOR_ADS — refusing")
        # either APPROVE or ACCEPT_WITH_WAIVER may have led to APPROVED_FOR_ADS
        dec = self.approvals.latest_for("cdxr_promotion", review_id)
        if dec is None:
            raise ValueError(f"no operator decision for feature promotion {review_id}")
        if dec["reviewContentHash"] != self._sha(obj.content):
            raise ValueError(f"feature promotion {review_id} hash changed after approval — invalidated")
        if dec["decision"] not in ("APPROVE", "ACCEPT_WITH_WAIVER"):
            raise ValueError(f"feature promotion {review_id} decision is '{dec['decision']}' — not promotable")
        return obj.content

    def re_run_required(self, review_id: str) -> bool:
        """After any change decision, a NEW review (new id) is mandatory."""
        obj = self.repo.get("feature-promotion-review", review_id)
        return obj is not None and obj.content["status"] == "CHANGES_REQUESTED"
