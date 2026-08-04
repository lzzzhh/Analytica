"""Status dashboard — state projection for the Pi frontend.

The dashboard is a READ-ONLY projection of the State Reducer's authoritative
RunStateSnapshot. It never maintains a second state store, and the frontend /
agent context both consume the SAME snapshots. The model-facing tool content
carries only compact refs; the full numeric/large view goes through the
UI-only details channel (ToolDefinition.renderResult).
"""
from __future__ import annotations

from typing import Any, Optional

from pipelines.governance.state_reducer import StateReducer


class StatusDashboard:
    def __init__(self, reducer: Optional[StateReducer] = None,
                 repo: Optional[Any] = None):
        self.reducer = reducer or StateReducer()
        self.repo = repo

    def overview(self) -> list[dict]:
        """Global dashboard rows: one per pipeline run, from real snapshots."""
        rows = []
        for snap in self.reducer.all_snapshots():
            rows.append({
                "pipelineId": snap["pipelineId"],
                "pipelineVersion": snap["pipelineVersion"],
                "runId": snap["runId"],
                "state": snap["state"],
                "businessPhase": snap["businessPhase"],
                "engine": snap["engine"],
                "currentJob": snap.get("currentJob"),
                "currentStage": snap.get("currentStage"),
                "lastHeartbeatAt": snap.get("lastHeartbeatAt"),
                "lastProgressAt": snap.get("lastProgressAt"),
                "openFindings": len(snap["openFindingRefs"]),
                "pendingApproval": snap["pendingApprovalRef"],
                "severity": self._severity(snap),
            })
        return rows

    def detail(self, run_id: str) -> dict:
        """Single-run detail from the same snapshot source."""
        snap = self.reducer.reduce_run(run_id, "", 1)
        return {
            "runId": run_id,
            "snapshot": snap,
            "schemaSpecVersion": snap.get("schemaSpecVersion"),
            "pipelineSpecVersion": snap.get("pipelineSpecVersion"),
            "placementPlanVersion": snap.get("placementPlanVersion"),
            "openFindingRefs": snap["openFindingRefs"],
            "pendingApprovalRef": snap["pendingApprovalRef"],
            "latestEventId": snap["latestEventId"],
            "findings": self._findings_detail(snap["openFindingRefs"]),
        }

    def _findings_detail(self, finding_refs: list[str]) -> list[dict]:
        """Finding summaries for the detail page (id/code/severity/blocking/
        actions — never raw logs). Empty when no repository is attached."""
        if self.repo is None:
            return []
        out = []
        for ref in finding_refs:
            obj = self.repo.get("governance-finding", ref, 1)
            if obj is None:
                continue
            c = obj.content
            out.append({
                "findingId": c.get("findingId"),
                "code": c.get("code"),
                "severity": c.get("severity"),
                "blocking": c.get("blocking", False),
                "recommendedActions": c.get("recommendedActions", [])[:3],
            })
        return out

    def model_facing_summary(self, rows: Optional[list[dict]] = None) -> str:
        """Compact text for the model — refs/state only, never full metrics
        or large tables (those go through the UI details channel)."""
        rows = rows if rows is not None else self.overview()
        if not rows:
            return "no pipeline runs in governance store"
        lines = [f"{r['pipelineId']} v{r['pipelineVersion']} run={r['runId']} "
                 f"state={r['state']} phase={r['businessPhase']} "
                 f"findings={r['openFindings']} pendingApproval={r['pendingApproval']}"
                 for r in rows]
        return "governance dashboard:\n" + "\n".join(lines)

    def ui_details(self, rows: Optional[list[dict]] = None) -> dict:
        """Full structured payload for the UI-only details channel
        (renderResult). Contains the complete overview — the model never sees
        this payload."""
        return {
            "dashboardType": "PIPELINE_GOVERNANCE",
            "rows": rows if rows is not None else self.overview(),
            "generatedAt": self._now(),
        }

    @staticmethod
    def _severity(snap: dict) -> str:
        if snap["state"] in ("FAILED", "BLOCKED"):
            return "HIGH"
        if snap["state"] in ("ISSUE_DETECTED", "WAITING_REMEDIATION_APPROVAL"):
            return "MEDIUM"
        if snap["state"] == "PUBLISHED":
            return "LOW"
        return "INFO"

    @staticmethod
    def _now() -> str:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()
