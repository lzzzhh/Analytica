"""Governance orchestration — Phase 1 state machine and review flow.

State machine:
  DRAFT → VALIDATING → DRAFT_COMPILED → WAITING_FOR_APPROVAL
        → APPROVED | CHANGES_REQUESTED | REJECTED

Rules:
  - a draft is compiled by the deterministic Compiler BEFORE approval
    (executable=false) and included in the ReviewPackage;
  - APPROVED freezes SchemaSpec + PipelineSpec + PipelineDraftArtifact +
    ReviewPackage content hashes into an ApprovedPipelineSpec (no run
    permission is implied);
  - CHANGES_REQUESTED produces a new spec version via Amendment, re-compiles,
    re-validates and creates a NEW ReviewPackage; old approvals are never
    reused;
  - REJECTED is terminal for that review;
  - linear versioning: v1 → v2 → v3 (no parallel branches); stale reviews and
    stale base versions are rejected.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from pipelines.governance.contracts import is_valid_contract, sha256_canonical
from pipelines.governance.repository import IntegrityError, Repository


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class StaleReviewError(ValueError):
    """Raised when operating on an outdated review/base version."""


class GovernancePhase1:
    def __init__(self, repo: Optional[Repository] = None):
        self.repo = repo or Repository()

    # ------------------------------------------------------------------
    # Review integrity helpers
    # ------------------------------------------------------------------

    def _load_review_verified(self, review_id: str) -> dict:
        """Load a review and verify its contentHash matches the content.
        Also verifies referenced specs/draft exist in the repository and
        their content hashes match what the review records."""
        review = self.repo.get_review(review_id)
        if review is None:
            raise ValueError(f"review {review_id} not found")
        actual = sha256_canonical({
            "schemaSpec": review["schemaSpec"],
            "pipelineSpec": review["pipelineSpec"],
            "draft": review["pipelineDraftArtifact"],
            "issues": review["validationIssues"],
        })
        if actual != review["contentHash"]:
            raise IntegrityError(f"review {review_id}: contentHash mismatch (content tampered)")
        return review

    def _verify_referenced_objects(self, review: dict) -> None:
        """The review's specs/draft must exist in the repo with matching hashes."""
        schema_spec = review["schemaSpec"]
        pipeline_spec = review["pipelineSpec"]
        draft = review["pipelineDraftArtifact"]

        spec_id = schema_spec.get("specId")
        stored_schema = self.repo.get("schema-spec", spec_id, schema_spec.get("version"))
        if stored_schema is None or sha256_canonical(stored_schema.content) != sha256_canonical(schema_spec):
            raise IntegrityError(f"review references schema-spec {spec_id}@v{schema_spec.get('version')} "
                                 "which is missing or hash-mismatched in the repository")

        stored_pipeline = self.repo.get("pipeline-spec", pipeline_spec.get("specId"), pipeline_spec.get("version"))
        if stored_pipeline is None or sha256_canonical(stored_pipeline.content) != sha256_canonical(pipeline_spec):
            raise IntegrityError(f"review references pipeline-spec {pipeline_spec.get('specId')}@v"
                                 f"{pipeline_spec.get('version')} which is missing or hash-mismatched")

        if draft is not None:
            stored_draft = self.repo.get("pipeline-draft-artifact", draft.get("artifactId"), 1)
            if stored_draft is None or sha256_canonical(stored_draft.content) != sha256_canonical(draft):
                raise IntegrityError(f"review references draft {draft.get('artifactId')} "
                                     "which is missing or hash-mismatched")

    def _seal_preconditions(self, review_id: str) -> dict:
        """Load + verify review, run integrity scan (blocks on MISSING_OBJECT),
        and verify referenced objects. Returns the verified review."""
        scan = self.repo.integrity_scan()
        if any(i.code == "MISSING_OBJECT" for i in scan):
            raise IntegrityError("repository has MISSING_OBJECT entries — refusing to seal")
        review = self._load_review_verified(review_id)
        self._verify_referenced_objects(review)
        return review

    # ------------------------------------------------------------------
    # Flow: draft -> validate -> compile -> review package
    # ------------------------------------------------------------------

    def create_review_package(self, schema_spec: dict, pipeline_spec: dict,
                              requester: str = "operator") -> dict:
        """Validate both specs, compile the draft (executable=false), build
        the ReviewPackage and persist it. State: WAITING_FOR_APPROVAL."""
        from pipelines.governance.validation import validate_pipeline_spec, validate_schema_spec
        issues = []
        issues += validate_schema_spec(schema_spec)
        issues += validate_pipeline_spec(pipeline_spec, schema_spec=schema_spec)
        errors = [i for i in issues if i["severity"] == "ERROR"]

        draft = None
        if not errors:
            from pipelines.governance.compiler import compile_draft
            draft = compile_draft(pipeline_spec, pipeline_spec["version"],
                                  _new_id("draft"))

        # Persist specs + draft as versioned objects so reviews reference
        # real repository objects (required by _verify_referenced_objects).
        self.repo.put("schema-spec", schema_spec["specId"], schema_spec["version"], schema_spec)
        self.repo.put("pipeline-spec", pipeline_spec["specId"], pipeline_spec["version"], pipeline_spec)
        if draft is not None:
            self.repo.put("pipeline-draft-artifact", draft["artifactId"], 1, draft)

        review = {
            "reviewId": _new_id("review"),
            "schemaSpec": schema_spec,
            "pipelineSpec": pipeline_spec,
            "pipelineDraftArtifact": draft,
            "validationIssues": issues,
            "contentHash": "",
            "createdAt": _now(),
            "requester": requester,
        }
        review["contentHash"] = sha256_canonical({
            "schemaSpec": schema_spec, "pipelineSpec": pipeline_spec,
            "draft": draft, "issues": issues,
        })
        self.repo.put_review(review)
        return review

    # ------------------------------------------------------------------
    # Approval (OPERATOR_CLI only)
    # ------------------------------------------------------------------

    def approve(self, review_id: str, decision: str, os_actor: str,
                comment: str = "") -> dict:
        """Record an operator decision. Rules:
          - decision must be valid;
          - REQUEST_CHANGES requires a non-empty comment;
          - the review must be loadable and hash-verified;
          - a review already REJECTED or CHANGES_REQUESTED cannot be approved
            again directly — a new review cycle is required.
        """
        if decision not in ("APPROVE", "REQUEST_CHANGES", "REJECT"):
            raise ValueError(f"invalid decision '{decision}'")
        if decision == "REQUEST_CHANGES" and not comment.strip():
            raise ValueError("REQUEST_CHANGES requires a non-empty --comment")

        review = self._load_review_verified(review_id)

        # terminal-state guard: look for an existing decision on this review
        existing_decisions = []
        for entry in self.repo.ledger():
            if entry.get("type") != "approval-decision":
                continue
            obj = self.repo.get("approval-decision", entry.get("id"), entry.get("version"))
            if obj is not None and obj.content.get("reviewId") == review_id:
                existing_decisions.append(obj.content.get("decision"))
        if "REJECT" in existing_decisions:
            raise ValueError(f"review {review_id} is already REJECTED (terminal)")
        if decision == "APPROVE" and "REQUEST_CHANGES" in existing_decisions:
            raise ValueError(
                f"review {review_id} is already CHANGES_REQUESTED — APPROVE is not allowed; "
                "complete the amendment to open a new review cycle")

        approval = {
            "approvalId": _new_id("approval"),
            "reviewId": review_id,
            "reviewContentHash": review["contentHash"],
            "decision": decision,
            "approverSource": "OPERATOR_CLI",
            "osActor": os_actor,
            "comment": comment,
            "decidedAt": _now(),
        }
        if not is_valid_contract("approval-decision", approval):
            raise ValueError("approval decision fails contract validation")
        # CAS by construction: storage key is unique per review — a second
        # concurrent decision for the same review is rejected by no-clobber
        # publish, so two approve() calls cannot both observe "no decision".
        self.repo.put("approval-decision", f"dec_review_{review_id}", 1, approval)
        return approval

    def seal_approved(self, review_id: str, approval: dict) -> dict:
        """Freeze the four content hashes into an ApprovedPipelineSpec.

        Preconditions: repository integrity clean, review hash-verified,
        referenced objects exist and match, approval binds this review,
        and the approval has not already sealed another object.
        """
        review = self._seal_preconditions(review_id)

        if approval["decision"] != "APPROVE":
            raise ValueError("only APPROVE may seal an approved spec")
        if approval["reviewContentHash"] != review["contentHash"]:
            raise ValueError("approval does not bind this review content hash")
        if approval["reviewId"] != review_id:
            raise ValueError("approval references a different review")

        # an approvalId may seal only ONE object (ledger 'id' == approvalId)
        sealed_for_approval = [
            a for a in self.repo.ledger()
            if a.get("type") == "approved-pipeline-spec" and a.get("id") == approval["approvalId"]
        ]
        if sealed_for_approval:
            raise ValueError(f"approval {approval['approvalId']} already sealed an object")

        schema_spec = review["schemaSpec"]
        pipeline_spec = review["pipelineSpec"]
        draft = review["pipelineDraftArtifact"]
        if draft is None:
            raise ValueError("review has no compiled draft — cannot seal")

        sealed = {
            "specId": pipeline_spec["specId"],
            "version": pipeline_spec["version"],
            "approvalId": approval["approvalId"],
            "schemaSpecHash": sha256_canonical(schema_spec),
            "pipelineSpecHash": sha256_canonical(pipeline_spec),
            "draftArtifactHash": draft["contentHash"],
            "reviewPackageHash": review["contentHash"],
            "sealedAt": _now(),
        }
        if not is_valid_contract("approved-pipeline-spec", sealed):
            raise ValueError("sealed spec fails contract validation")
        self.repo.put("approved-pipeline-spec", sealed["specId"], sealed["version"], sealed)
        return sealed

    def verify_sealed_approval(self, spec_id: str, version: int,
                               target: str, approval_id: str) -> dict:
        """Verify that a stored seal came from the complete operator flow.

        This is the consume-time counterpart of ``seal_approved``: repository
        hashes, the operator decision, review content, referenced objects, and
        every frozen seal hash must still agree.
        """
        issues = self.repo.integrity_scan()
        if issues:
            summary = "; ".join(f"{issue.code}: {issue.detail}" for issue in issues)
            raise IntegrityError(f"governance repository integrity check failed: {summary}")

        stored = self.repo.get("approved-pipeline-spec", spec_id, version)
        if stored is None or not is_valid_contract("approved-pipeline-spec", stored.content):
            raise IntegrityError(f"approved spec {spec_id}@v{version} is missing or invalid")
        sealed = stored.content
        if sealed["approvalId"] != approval_id:
            raise IntegrityError("sealed approvalId does not match requested approval")

        decisions = []
        for entry in self.repo.ledger():
            if entry.get("type") != "approval-decision":
                continue
            obj = self.repo.get("approval-decision", entry.get("id"), entry.get("version"))
            if obj is not None and obj.content.get("approvalId") == approval_id:
                decisions.append(obj.content)
        if len(decisions) != 1:
            raise IntegrityError(
                f"approval {approval_id} must have exactly one operator decision")
        decision = decisions[0]
        if decision.get("decision") != "APPROVE" or decision.get("approverSource") != "OPERATOR_CLI":
            raise IntegrityError(f"approval {approval_id} is not an OPERATOR_CLI APPROVE decision")

        review = self._seal_preconditions(decision["reviewId"])
        if decision.get("reviewContentHash") != review.get("contentHash"):
            raise IntegrityError("operator decision no longer binds the review content")
        pipeline_spec = review["pipelineSpec"]
        schema_spec = review["schemaSpec"]
        draft = review["pipelineDraftArtifact"]
        if (
            pipeline_spec.get("specId") != spec_id
            or pipeline_spec.get("version") != version
            or pipeline_spec.get("target") != target
        ):
            raise IntegrityError("sealed pipeline identity or target does not match the write")
        if sealed["specId"] != spec_id or sealed["version"] != version:
            raise IntegrityError("sealed object identity does not match its repository key")
        if sealed["pipelineSpecHash"] != sha256_canonical(pipeline_spec):
            raise IntegrityError("sealed pipelineSpecHash mismatch")
        if sealed["schemaSpecHash"] != sha256_canonical(schema_spec):
            raise IntegrityError("sealed schemaSpecHash mismatch")
        if draft is None or sealed["draftArtifactHash"] != draft.get("contentHash"):
            raise IntegrityError("sealed draftArtifactHash mismatch")
        if sealed["reviewPackageHash"] != review.get("contentHash"):
            raise IntegrityError("sealed reviewPackageHash mismatch")
        return sealed

    def request_changes(self, review_id: str, approval: dict,
                        changed_schema: dict, changed_pipeline: dict,
                        reason: str) -> dict:
        """CHANGES_REQUESTED → record Amendment, re-validate, re-compile and
        create a NEW review package. Old approvals are never reused."""
        review = self._load_review_verified(review_id)
        if approval["reviewContentHash"] != review["contentHash"]:
            raise ValueError("approval does not bind this review content hash")
        if approval["decision"] != "REQUEST_CHANGES":
            raise ValueError("only a REQUEST_CHANGES decision may open an amendment")

        old_pipeline = review["pipelineSpec"]
        old_schema = review["schemaSpec"]
        old_version = old_pipeline["version"]

        # linear versioning: base must be the latest version in the repo
        latest = self.repo.get("pipeline-spec", old_pipeline["specId"])
        if latest is None or latest.version != old_version:
            raise StaleReviewError(
                f"STALE_BASE_VERSION: review bases on pipeline-spec v{old_version} "
                f"but repository latest is v{latest.version if latest else '?'}")
        latest_schema = self.repo.get("schema-spec", old_schema["specId"])
        if latest_schema is None or latest_schema.version != old_schema["version"]:
            raise StaleReviewError(
                f"STALE_BASE_VERSION: review bases on schema-spec v{old_schema['version']} "
                f"but repository latest is v{latest_schema.version if latest_schema else '?'}")

        new_version = old_version + 1
        changed_pipeline = {**changed_pipeline, "version": new_version}
        changed_schema = {**changed_schema, "version": new_version}

        amendment = {
            "amendmentId": _new_id("amend"),
            "baseSpecVersion": old_version,
            "changes": [{"field": k, "from": old_pipeline.get(k), "to": changed_pipeline.get(k)}
                        for k in ("target", "executionMode", "steps", "keys") if old_pipeline.get(k) != changed_pipeline.get(k)],
            "newSpecVersion": new_version,
            "reason": reason,
            "approvedBy": approval["osActor"],
            "amendedAt": _now(),
        }
        if not is_valid_contract("pipeline-amendment", amendment):
            raise ValueError("amendment fails contract validation")
        # version reservation by construction: one amendment per review —
        # a concurrent request_changes on the same base is rejected by
        # no-clobber, so no half-completed amendment can be left behind.
        self.repo.put("pipeline-amendment", f"amend_{review_id}", 1, amendment)

        # re-validate + re-compile + new review package
        return self.create_review_package(changed_schema, changed_pipeline,
                                          requester=approval["osActor"])

    def latest_changes_requested_approval(self, review_id: str) -> Optional[dict]:
        """Return the most recent OPERATOR_CLI REQUEST_CHANGES decision bound
        to this review (used by the CLI `amend` command)."""
        candidates = []
        for entry in self.repo.ledger():
            if entry.get("type") != "approval-decision":
                continue
            obj = self.repo.get("approval-decision", entry.get("id"), entry.get("version"))
            if obj is not None and obj.content.get("reviewId") == review_id \
                    and obj.content.get("decision") == "REQUEST_CHANGES":
                candidates.append(obj.content)
        if not candidates:
            return None
        # most recent by decidedAt
        return max(candidates, key=lambda a: a.get("decidedAt", ""))

    # ------------------------------------------------------------------
    # State helpers
    # ------------------------------------------------------------------

    @staticmethod
    def state_of(review: dict) -> str:
        if review["pipelineDraftArtifact"] is None:
            return "VALIDATING" if review["validationIssues"] else "DRAFT_COMPILED"
        return "WAITING_FOR_APPROVAL"
