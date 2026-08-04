"""Placement governance — PlacementPlan proposal, deterministic validator,
operator approval.

Layering rules (deterministic):
  - ODS: raw, immutable, non-derived — never final metrics dressed as ODS;
  - DWD: detail grain preserved (no aggregation hiding detail);
  - DWS: subject aggregates + candidate features allowed;
  - ADS: explicit consumption purpose required;
  - FEATURE_STORE: entity key + event time + reproducibility required.

Write policy: ONLY after operator APPROVE, and only to the controlled local
harness targets the repository knows. Arbitrary tables/paths are refused.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from pipelines.governance.contracts import is_valid_contract
from pipelines.governance.repository import Repository

CONTROLLED_TARGETS = {
    "ods.streaming_events", "ods.loan_applications_raw",
    "ods.feature_inputs_raw", "ods.prediction_inputs_raw",
    "ods.model_metric_inputs_raw", "dwd.loan_application_detail",
    "dws.feature_values", "dws.prediction_points", "ads.model_metrics",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class PlacementGovernance:
    def __init__(self, repo: Optional[Repository] = None,
                 controlled: Optional[set[str]] = None):
        self.repo = repo or Repository()
        self._controlled = set(controlled) if controlled is not None else set(CONTROLLED_TARGETS)
        from pipelines.governance.approval import OperatorApproval
        from pipelines.governance.contracts import sha256_canonical as _sha
        self.approvals = OperatorApproval(self.repo)
        self._sha = _sha

    def validate_plan(self, plan: dict) -> list[str]:
        """Deterministic placement validation. Returns error strings."""
        errors: list[str] = []
        if not is_valid_contract("placement-plan", plan):
            errors.append("placement plan fails contract validation")
            return errors
        layer = plan["targetLayer"]
        target = plan.get("targetDataset", "")

        # LAYER/NAMESPACE CONSISTENCY: the target dataset namespace must match
        # the declared layer (ADS targeting dws.* or DWS targeting ads.* is
        # refused regardless of rationale).
        layer_namespace = {
            "ODS": "ods.",
            "DWD": "dwd.",
            "DWS": "dws.",
            "ADS": "ads.",
            "FEATURE_STORE": "dws.",
        }[layer]
        if target in CONTROLLED_TARGETS and not target.startswith(layer_namespace):
            errors.append(
                f"targetLayer {layer} requires a '{layer_namespace}' dataset, "
                f"got '{target}' (layer/namespace mismatch)")

        if layer == "ODS":
            # ODS must be RAW — structured derivation declaration replaces the
            # old rationale string matching (which was trivially bypassed)
            if plan.get("derivation", "RAW") != "RAW":
                errors.append("ODS must be RAW — derived metrics never belong in ODS")
        elif layer == "DWD":
            # detail grain preserved: structured grain declaration + key
            if not plan.get("primaryKey"):
                errors.append("DWD requires a primary key (detail grain)")
            if not plan.get("grainDetail") or len(plan["grainDetail"]) < 4:
                errors.append("DWD requires a structured grainDetail declaration "
                              "(e.g. 'per loan application')")
            elif any(v in plan["grainDetail"].lower() for v in
                     ("aggregate", "summary", "total", "rollup", "daily total")):
                errors.append("DWD grainDetail must be detail-level — "
                              "aggregation/summary grains belong in DWS")
        elif layer == "DWS":
            pass  # subject aggregates + candidate features allowed
        elif layer == "ADS":
            if not plan.get("rationale") or len(plan["rationale"]) < 10:
                errors.append("ADS requires an explicit consumption purpose")
        elif layer == "FEATURE_STORE":
            if not plan.get("primaryKey"):
                errors.append("FEATURE_STORE requires an entity key")
            if not plan.get("grainDetail"):
                errors.append("FEATURE_STORE requires a structured grainDetail "
                              "declaration (entity-level grain)")
            if not any("time" in f or "date" in f for f in plan.get("partitioning", [])):
                errors.append("FEATURE_STORE requires event-time partitioning (reproducibility)")

        # write mode must be compatible with the primary key
        if plan.get("writeMode") in ("MERGE", "INCREMENTAL") and not plan.get("primaryKey"):
            errors.append(f"writeMode {plan['writeMode']} requires a primary key")

        # target table must be a controlled local harness target
        if plan.get("targetDataset") not in self._controlled:
            errors.append(
                f"target '{plan['targetDataset']}' is not a controlled harness target — "
                "arbitrary writes are refused")

        # partition cardinality sanity
        if len(plan.get("partitioning", [])) > 4:
            errors.append("too many partition columns (> 4) — high cardinality risk")
        return errors

    def propose(self, plan: dict) -> dict:
        errors = self.validate_plan(plan)
        if errors:
            raise ValueError(f"invalid placement plan: {'; '.join(errors)}")
        plan = {**plan, "placementPlanId": _new_id("pp"), "status": "DRAFT"}
        self.repo.put("placement-plan", plan["placementPlanId"], 1, plan)
        return plan

    def approve(self, placement_plan_id: str, os_actor: str,
                comment: str = "") -> dict:
        """Operator APPROVE -> APPROVED (write still requires the controlled
        target + explicit publisher; this only authorizes the plan)."""
        obj = self.repo.get("placement-plan", placement_plan_id, 1)
        if obj is None:
            raise ValueError(f"placement plan {placement_plan_id} not found")
        plan = obj.content
        if plan["status"] != "DRAFT":
            raise ValueError(f"placement plan {placement_plan_id} already decided")
        approved = {**plan, "status": "APPROVED",
                    "assumptions": [*plan.get("assumptions", []),
                                    f"approved by {os_actor} at {_now()}"]}
        # binds the hash of the APPROVED object — require_approved re-hashes
        # that same version, so any tampering invalidates the decision.
        self.approvals.record("placement", placement_plan_id, "APPROVE",
                              os_actor, self._sha(approved))
        self.repo.put("placement-plan", placement_plan_id, 2, approved)
        return approved

    def reject(self, placement_plan_id: str, os_actor: str,
               comment: str = "") -> dict:
        obj = self.repo.get("placement-plan", placement_plan_id, 1)
        if obj is None:
            raise ValueError(f"placement plan {placement_plan_id} not found")
        rejected = {**obj.content, "status": "REJECTED"}
        self.repo.put("placement-plan", placement_plan_id, 2, rejected)
        return rejected

    def require_approved(self, placement_plan_id: str) -> dict:
        """Only an APPROVED plan may be consumed by the publisher, and only
        when the plan hash is unchanged since the operator decision."""
        obj = self.repo.get("placement-plan", placement_plan_id)
        if obj is None or obj.content["status"] != "APPROVED":
            raise ValueError(f"placement plan {placement_plan_id} is not approved — refusing to write")
        self.approvals.require_decision("placement", placement_plan_id,
                                        "APPROVE", self._sha(obj.content))
        return obj.content
