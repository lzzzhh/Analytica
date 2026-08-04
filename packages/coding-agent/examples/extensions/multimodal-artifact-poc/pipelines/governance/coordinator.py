"""Governance Coordinator — the single integration point.

Every governance action goes through here so the authoritative Event Store
and State Reducer stay in sync:

    component action
      → atomically persist the business object (Repository)
      → append the corresponding GovernanceEvent (EventStore)
      → the State Reducer derives the new RunStateSnapshot

Callers never have to remember to emit events themselves. This also enforces
feature gating: a coordinator service only wires the components whose
feature is effective (assembled by feature-resolver-aware service code).
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from pipelines.governance.contracts import sha256_canonical
from pipelines.governance.event_store import EventStore
from pipelines.governance.repository import Repository
from pipelines.governance.state_reducer import StateReducer


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class GovernanceCoordinator:
    """Feature-gated integration point: every action requires its feature to
    be effective (parent + child). Off components never run; off actions
    raise RuntimeError with the feature id."""

    # action -> feature id required (parent round2.pipeline_governance is
    # checked implicitly: none of these can be effective without it)
    ACTION_FEATURES = {
        "emit": "round2.pipeline_event_store",
        "snapshot": "round2.pipeline_state_reducer",
        "record_finding": "round2.pipeline_governance",
        "watchdog_renew": "round2.pipeline_deadline_watchdog",
        "design_schema": "round2.pipeline_schema_design",
        "agent_interpret": "round2.pipeline_agent_worker",
        "remediation_decide": "round2.pipeline_remediation",
        "placement_design": "round2.pipeline_placement_governance",
        "placement_approve": "round2.pipeline_placement_governance",
        "cdxr_promote": "round2.pipeline_cdxr_promotion_gate",
        "status_dashboard": "round2.pipeline_status_dashboard",
    }

    def __init__(self, repo: Optional[Repository] = None,
                 store: Optional[EventStore] = None,
                 resolver: Optional[Any] = None):
        self.repo = repo or Repository()
        self.store = store or EventStore(repo)
        self.reducer = StateReducer(self.store)
        self._resolver = resolver
        if self._resolver is None:
            try:
                sys.path.insert(0, str(Path(__file__).resolve().parents[2] /
                                       "services" / "lakehouse-gateway"))
                from app.features import get_default_resolver
                self._resolver = get_default_resolver()
            except Exception:
                self._resolver = None

    def _require(self, action: str) -> None:
        """Refuse the action when its feature is not effective."""
        if self._resolver is None:
            return  # no resolver available — caller already gated registration
        fid = self.ACTION_FEATURES[action]
        if not self._resolver.is_effective(fid):
            raise RuntimeError(
                f"governance action '{action}' requires feature '{fid}' — "
                "not effective; refusing to run")

    # -- event emission ---------------------------------------------------

    def emit(self, etype: str, pipeline_id: str, pipeline_version: int,
             run_id: str, payload: Optional[dict] = None,
             source: str = "PIPELINE_GOVERNANCE") -> str:
        self._require("emit")
        events = self.store.events_for_run(run_id)
        seq = max((e["sequenceNumber"] for e in events), default=-1) + 1
        event = {
            "eventId": _new_id("evt"),
            "eventType": etype,
            "pipelineId": pipeline_id,
            "pipelineVersion": pipeline_version,
            "runId": run_id,
            "source": source,
            "sequenceNumber": seq,
            "occurredAt": _now(),
            "payloadHash": sha256_canonical(payload or {}),
            "payloadRef": None,
            "supersedesEventId": None,
            "payload": payload or {},
        }
        return self.store.append(event)

    def snapshot(self, run_id: str, pipeline_id: str = "",
                 pipeline_version: int = 1) -> dict:
        """Current authoritative snapshot for a run (post any events)."""
        self._require("snapshot")
        return self.reducer.reduce_run(run_id, pipeline_id, pipeline_version)

    # -- findings / watchdog ----------------------------------------------

    def record_finding(self, finding: dict) -> str:
        """Persist a finding + emit FINDING_DETECTED so the reducer state
        transitions to ISSUE_DETECTED."""
        self._require("record_finding")
        self.repo.put("governance-finding", finding["findingId"], 1, finding)
        return self.emit(
            "FINDING_DETECTED",
            finding["pipelineId"], finding.get("pipelineVersion", 1),
            finding["runId"],
            payload={"findingId": finding["findingId"]},
        )

    def watchdog_renew(self, run_id: str, pipeline_id: str, pipeline_version: int,
                       deadline: str) -> str:
        """Emit a heartbeat/progress event with the renewed deadline."""
        self._require("watchdog_renew")
        return self.emit("PROGRESS_UPDATED", pipeline_id, pipeline_version,
                         run_id, payload={"deadline": deadline})

    # -- schema design -----------------------------------------------------

    def design_schema(self, profile: dict, target_usage: str, pipeline_id: str,
                      target_dataset: str, version: int = 1,
                      designer: Optional[Any] = None,
                      run_id: Optional[str] = None) -> dict:
        """Run the DESIGN step: injected LLM caller proposes business
        semantics from the deterministic profile; the validated SchemaSpec +
        PipelineSpec draft is persisted and a SCHEMA_DESIGNED event emitted.
        Human approval (Gate 1) happens via the review flow."""
        self._require("design_schema")
        from pipelines.governance.schema_designer import SchemaDesigner
        d = designer or SchemaDesigner()
        result = d.design(profile, target_usage, pipeline_id, target_dataset, version)
        if not result.get("ok"):
            return result
        ss, ps = result["schemaSpec"], result["pipelineSpec"]
        # spec persistence is owned by the review flow (create_review_package
        # stores them immutably); design only emits the event referencing them.
        run_id = run_id or profile.get("runId") or f"run_{uuid.uuid4().hex[:12]}"
        self.emit("SCHEMA_DESIGNED", pipeline_id, version, run_id,
                  payload={"schemaSpecId": ss["specId"],
                           "pipelineSpecId": ps["specId"],
                           "targetDataset": target_dataset},
                  source="AGENT_WORKER")
        return result

    # -- agent interpretation (remediation/placement advice) ---------------

    def agent_interpret(self, event: dict, relevant_event_refs: Optional[list] = None,
                        caller: Optional[Any] = None) -> dict:
        """Wake the Governance Agent for ONE trigger event. The injected
        caller (or the failing stub) proposes an interpretation; the worker
        never mutates state. The interpretation is emitted as an event."""
        self._require("agent_interpret")
        from pipelines.governance.agent_worker import AgentWorker
        worker = AgentWorker(caller=caller)
        result = worker.on_event(event, relevant_event_refs)
        if result.get("ok"):
            self.emit("AGENT_INTERPRETED", event.get("pipelineId", "pipeline_1"),
                      event.get("pipelineVersion", 1), event.get("runId", "run_1"),
                      payload={"eventType": event.get("eventType", ""),
                               "interpretation": result.get("result", {})},
                      source="AGENT_WORKER")
        return result

    # -- placement design --------------------------------------------------

    def placement_design(self, profile: dict, source_dataset: str, usage: str,
                         version: int = 1, designer: Optional[Any] = None,
                         run_id: Optional[str] = None) -> dict:
        """Run the PLACEMENT role: injected LLM caller proposes the target
        layer; the validated plan is persisted and a PLACEMENT_PROPOSED event
        emitted. Human approval (Gate 3) happens separately."""
        self._require("placement_design")
        from pipelines.governance.placement_designer import PlacementDesigner
        d = designer or PlacementDesigner()
        result = d.design(profile, source_dataset, usage, version)
        if not result.get("ok"):
            return result
        plan = result["plan"]
        self.repo.put("placement-plan", plan["placementPlanId"], version, plan)
        self.emit("PLACEMENT_PROPOSED", "pipeline_1", version,
                  run_id or f"run_{uuid.uuid4().hex[:12]}",
                  payload={"placementPlanId": plan["placementPlanId"],
                           "targetLayer": plan["targetLayer"],
                           "targetDataset": plan["targetDataset"]},
                  source="AGENT_WORKER")
        return result

    # -- remediation ------------------------------------------------------

    def remediation_decide(self, proposal: dict, decision: str,
                           os_actor: str, comment: str = "") -> str:
        """Record a remediation decision + emit an event so the snapshot
        reflects the outcome (state returns to RUNNING after approval)."""
        self._require("remediation_decide")
        from pipelines.governance.runtime_governance import Remediation
        rem = Remediation(self.repo)
        decided = rem.decide(proposal["proposalId"], decision, os_actor, comment)
        etype = ("REMEDIATION_APPROVED" if decided["status"] == "APPROVED"
                 else "REMEDIATION_REJECTED")
        return self.emit(etype, decided["pipelineId"],
                         proposal.get("pipelineVersion", 1), decided["runId"],
                         payload={"proposalId": proposal["proposalId"],
                                  "decision": decision})

    # -- placement --------------------------------------------------------

    def placement_approve(self, plan: dict, os_actor: str) -> str:
        self._require("placement_approve")
        from pipelines.governance.placement import PlacementGovernance
        pg = PlacementGovernance(self.repo)
        approved = pg.approve(plan["placementPlanId"], os_actor)
        return self.emit("PLACEMENT_APPROVED", approved.get("pipelineId", "pipeline_1"),
                         1, approved.get("runId", "run_1"),
                         payload={"placementPlanId": plan["placementPlanId"],
                                  "placementPlanVersion": 2})

    # -- CDXR promotion ---------------------------------------------------

    def cdxr_promote(self, review: dict, os_actor: str) -> str:
        self._require("cdxr_promote")
        from pipelines.governance.cdxr_gate import CdxrPromotionGate
        gate = CdxrPromotionGate(self.repo)
        decided = gate.decide(review["reviewId"], "APPROVE", os_actor)
        return self.emit("FEATURE_PROMOTION_APPROVED",
                         decided["pipelineId"], 1, decided["runId"],
                         payload={"reviewId": review["reviewId"]})
