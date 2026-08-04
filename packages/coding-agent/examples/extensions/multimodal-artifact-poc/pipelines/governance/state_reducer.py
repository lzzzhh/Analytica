"""Deterministic State Reducer — events → RunStateSnapshot.

The reducer is the ONLY producer of authoritative run state. It replays
events for a run in sequence order and applies a deterministic transition
function. Idempotency and ordering:
  - a duplicate eventId is skipped (store already rejects writes);
  - a sequenceNumber <= the last applied sequence is ignored (never rewinds);
  - an event with an older pipelineVersion than the current snapshot is
    ignored (old-version events cannot overwrite new state).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from pipelines.governance.contracts import is_valid_contract
from pipelines.governance.event_store import EventStore

ALL_STATES = [
    "DRAFT", "WAITING_SCHEMA_APPROVAL", "APPROVED", "QUEUED", "RUNNING",
    "ISSUE_DETECTED", "WAITING_REMEDIATION_APPROVAL", "PROCESSING_COMPLETED",
    "WAITING_PLACEMENT_APPROVAL", "WAITING_CDXR_APPROVAL", "PUBLISHING",
    "PUBLISHED", "BLOCKED", "FAILED", "CANCELLED",
]

TERMINAL_STATES = {"PUBLISHED", "FAILED", "CANCELLED", "BLOCKED"}

# eventType -> new state (default transition table; extensions can provide
# custom transitions)
DEFAULT_TRANSITIONS: dict[str, str] = {
    "RUN_CREATED": "QUEUED",
    "RUN_REOPENED": "RUNNING",      # explicit reopen leaves a terminal state
    "RUN_STARTED": "RUNNING",
    "ENGINE_HEARTBEAT": "RUNNING",          # non-state-changing progress
    "PROGRESS_UPDATED": "RUNNING",          # non-state-changing progress
    "STAGE_COMPLETED": "RUNNING",
    "FINDING_DETECTED": "ISSUE_DETECTED",
    "REMEDIATION_REQUESTED": "WAITING_REMEDIATION_APPROVAL",
    "REMEDIATION_APPROVED": "RUNNING",
    "PROCESSING_COMPLETED": "PROCESSING_COMPLETED",
    "PLACEMENT_REQUESTED": "WAITING_PLACEMENT_APPROVAL",
    "PLACEMENT_APPROVED": "PUBLISHING",
    "DWS_FEATURE_CANDIDATE_READY": "WAITING_CDXR_APPROVAL",
    "FEATURE_PROMOTION_APPROVED": "PUBLISHING",
    "PUBLISHED": "PUBLISHED",
    "RUN_FAILED": "FAILED",
    "RUN_CANCELLED": "CANCELLED",
    "RUN_BLOCKED": "BLOCKED",
}


class StateReducer:
    def __init__(self, store: Optional[EventStore] = None):
        self.store = store or EventStore()

    def reduce_run(self, run_id: str, pipeline_id: str = "",
                   pipeline_version: int = 1) -> dict:
        """Replay all events for a run and return the deterministic snapshot."""
        snapshot: dict[str, Any] = {
            "pipelineId": pipeline_id,
            "pipelineVersion": pipeline_version,
            "runId": run_id,
            "state": "DRAFT",
            "businessPhase": "DESIGN",
            "engine": "UNKNOWN",
            "engineRunRef": None,
            "currentJob": None,
            "currentStage": None,
            "lastHeartbeatAt": None,
            "lastProgressAt": None,
            "activeDeadline": None,
            "schemaSpecVersion": None,
            "pipelineSpecVersion": None,
            "placementPlanVersion": None,
            "openFindingRefs": [],
            "pendingApprovalRef": None,
            "latestEventId": "",
            "lastSequenceNumber": -1,
            "updatedAt": "",
        }
        last_seq = -1
        last_version = pipeline_version
        for event in sorted(self.store.events_for_run(run_id),
                            key=lambda e: e["sequenceNumber"]):
            seq = event["sequenceNumber"]
            ver = event.get("pipelineVersion", last_version)
            # same sequence, different eventId → conflict (never silently ignore)
            if seq == last_seq and event["eventId"] != snapshot["latestEventId"]:
                raise ValueError(
                    f"conflicting events at sequence {seq} for run {run_id}: "
                    f"{snapshot['latestEventId']} vs {event['eventId']}")
            if seq < last_seq:
                continue  # stale sequence — never rewind
            if ver < last_version:
                continue  # old-version event cannot overwrite new state
            # terminal states cannot be left by ordinary events
            if snapshot["state"] in TERMINAL_STATES and event["eventType"] not in (
                "RUN_REOPENED", "RUN_CREATED"
            ):
                continue  # a late heartbeat/progress must not resurrect a terminal run
            last_seq = seq
            last_version = ver
            snapshot = self._apply(event, snapshot)
            snapshot["pipelineVersion"] = last_version

        snapshot["latestEventId"] = snapshot["latestEventId"] or f"none_{run_id}"
        snapshot["lastSequenceNumber"] = max(last_seq, 0)
        snapshot["updatedAt"] = snapshot.get("updatedAt") or \
            datetime.now(timezone.utc).isoformat()
        # keep pipelineId/version from the first event that carries them
        if not snapshot["pipelineId"]:
            events = self.store.events_for_run(run_id)
            if events:
                snapshot["pipelineId"] = events[0].get("pipelineId", "")
                snapshot["pipelineVersion"] = events[0].get("pipelineVersion", 1)
        if not is_valid_contract("pipeline-run-state-snapshot", snapshot):
            raise ValueError("reducer produced an invalid snapshot")
        return snapshot

    def _apply(self, event: dict, snapshot: dict) -> dict:
        etype = event["eventType"]
        new_state = DEFAULT_TRANSITIONS.get(etype)
        out = dict(snapshot)
        out["latestEventId"] = event["eventId"]
        out["updatedAt"] = event["occurredAt"]

        if etype == "ENGINE_HEARTBEAT":
            out["lastHeartbeatAt"] = event["occurredAt"]
            out["activeDeadline"] = event.get("payload", {}).get("deadline", out.get("activeDeadline"))
            if event.get("payload", {}).get("engine"):
                out["engine"] = event["payload"]["engine"]
            if event.get("payload", {}).get("engineRunRef"):
                out["engineRunRef"] = event["payload"]["engineRunRef"]
        elif etype == "PROGRESS_UPDATED":
            out["lastProgressAt"] = event["occurredAt"]
            out["activeDeadline"] = event.get("payload", {}).get("deadline", out.get("activeDeadline"))
            payload = event.get("payload") or {}
            for k in ("currentJob", "currentStage"):
                if payload.get(k) is not None:
                    out[k] = payload[k]
        elif etype == "FINDING_DETECTED":
            payload = event.get("payload") or {}
            if payload.get("findingId") and payload["findingId"] not in out["openFindingRefs"]:
                out["openFindingRefs"] = [*out["openFindingRefs"], payload["findingId"]]
        elif etype == "REMEDIATION_REQUESTED":
            out["pendingApprovalRef"] = event.get("payload", {}).get("approvalRequestId")
        elif etype == "PLACEMENT_REQUESTED":
            out["pendingApprovalRef"] = event.get("payload", {}).get("approvalRequestId")
        elif etype == "PLACEMENT_APPROVED":
            out["pendingApprovalRef"] = None
            out["placementPlanVersion"] = event.get("payload", {}).get("placementPlanVersion")
        elif etype == "DWS_FEATURE_CANDIDATE_READY":
            out["pendingApprovalRef"] = event.get("payload", {}).get("approvalRequestId")
        elif etype == "FEATURE_PROMOTION_APPROVED":
            out["pendingApprovalRef"] = None
        elif etype in ("PROCESSING_COMPLETED", "REMEDIATION_APPROVED", "PUBLISHED",
                       "RUN_FAILED", "RUN_CANCELLED", "RUN_BLOCKED"):
            out["pendingApprovalRef"] = None

        if new_state is not None:
            out["state"] = new_state
            if new_state == "PROCESSING_COMPLETED":
                out["businessPhase"] = "PLACEMENT"
            elif new_state == "WAITING_PLACEMENT_APPROVAL":
                out["businessPhase"] = "PLACEMENT"
            elif new_state == "WAITING_CDXR_APPROVAL":
                out["businessPhase"] = "FEATURE_PROMOTION"
            elif new_state == "PUBLISHED":
                out["businessPhase"] = "PUBLISHED"
            elif new_state == "FAILED":
                out["businessPhase"] = "FAILED"
            elif new_state == "CANCELLED":
                out["businessPhase"] = "CANCELLED"
        return out

    def all_snapshots(self) -> list[dict]:
        """Snapshots for every run currently in the store (multi-pipeline)."""
        runs: dict[str, dict] = {}
        for event in self.store.all_events():
            run_id = event["runId"]
            runs.setdefault(run_id, {
                "pipelineId": event.get("pipelineId", ""),
                "pipelineVersion": event.get("pipelineVersion", 1),
            })
        return [self.reduce_run(rid, meta["pipelineId"], meta["pipelineVersion"])
                for rid, meta in runs.items()]
