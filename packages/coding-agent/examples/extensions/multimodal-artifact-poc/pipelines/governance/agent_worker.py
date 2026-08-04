"""Governance Agent Worker — event-triggered, non-resident.

The worker is invoked ONLY by: anomaly events, phase-complete events, and
human approval events. It reads a PipelineContextPackage (built from the
RunStateSnapshot + relevant event refs) and produces a structured result
(findings interpretation or remediation proposal). It never:
  - resides or polls;
  - reads the full event history or full logs;
  - writes state, approvals, or run records;
  - modifies Spark/Flink jobs or the warehouse.

The worker validates its inputs (trigger event whitelist) and its outputs
(strict JSON parse with ONE auto-repair pass; the raw model text is never
forwarded verbatim). The LLM call is an injected stub in tests — the worker
itself is the orchestration boundary.
"""
from __future__ import annotations

import json
import re
from typing import Callable, Optional

from pipelines.governance.contracts import is_valid_contract
from pipelines.governance.state_reducer import StateReducer

# Callable injected by the runtime: prompt -> {ok, text, error}
AgentCaller = Callable[[str], dict]

# The ONLY event types the worker may react to: anomalies, phase-complete
# and human-approval events. Anything else is refused outright (no silent
# ignore — the caller gets a failure so it cannot misattribute work).
TRIGGER_EVENT_TYPES = frozenset({
    "FINDING_DETECTED",
    "WATCHDOG_ANOMALY",
    "STAGE_COMPLETED",
    "PROCESSING_COMPLETED",
    "REMEDIATION_REQUESTED",
    "REMEDIATION_APPROVED",
    "REMEDIATION_REJECTED",
    "PLACEMENT_APPROVED",
    "FEATURE_PROMOTION_APPROVED",
})


def _extract_json_block(text: str) -> str:
    """Pull the JSON out of a model reply: fenced code block if present,
    otherwise the first {...} span."""
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    if fence:
        return fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start:end + 1].strip()
    return text.strip()


def _repair_json_once(raw: str) -> str:
    """One bounded auto-repair pass for common model output defects:
    trailing commas, Python True/False/None literals, single-quoted keys.
    Never attempts anything beyond these textual fixes."""
    s = re.sub(r",\s*([}\]])", r"\1", raw)          # trailing commas
    s = re.sub(r"\bTrue\b", "true", s)
    s = re.sub(r"\bFalse\b", "false", s)
    s = re.sub(r"\bNone\b", "null", s)
    s = re.sub(r"(['\"])([A-Za-z_][A-Za-z0-9_]*)(['\"])\s*:", r'"\2":', s)  # quoted keys
    s = re.sub(r"'\s*:", '":', s)                    # stray single quotes before colon
    s = re.sub(r"'\s*([,\]})])", r"\1", s)           # trailing single quotes in values
    return s


def parse_agent_json(text: str) -> tuple[Optional[dict], bool]:
    """Strict JSON parse with ONE repair pass. Returns (parsed, repaired);
    (None, False) when even the repaired text is not a JSON object."""
    try:
        obj = json.loads(_extract_json_block(text))
        if not isinstance(obj, dict):
            return None, False
        return obj, False
    except (json.JSONDecodeError, ValueError):
        pass
    try:
        obj = json.loads(_repair_json_once(_extract_json_block(text)))
        if not isinstance(obj, dict):
            return None, False
        return obj, True
    except (json.JSONDecodeError, ValueError):
        return None, False


def build_context_package(snapshot: dict, relevant_event_refs: list[str],
                          approved_decision_refs: Optional[list[str]] = None) -> dict:
    """Build the compact context the agent may read (never full history)."""
    pkg = {
        "pipelineId": snapshot["pipelineId"],
        "pipelineVersion": snapshot["pipelineVersion"],
        "runId": snapshot["runId"],
        "currentState": snapshot["state"],
        "businessPhase": snapshot["businessPhase"],
        "schemaSpecRef": f"schema-spec:{(snapshot.get('schemaSpecVersion') or 'latest')}",
        "pipelineSpecRef": f"pipeline-spec:{(snapshot.get('pipelineSpecVersion') or 'latest')}",
        "currentEngineContext": {
            "engine": snapshot["engine"],
            "jobId": snapshot.get("currentJob"),
            "stageId": snapshot.get("currentStage"),
        },
        "openFindingRefs": snapshot["openFindingRefs"],
        "pendingApprovalRef": snapshot["pendingApprovalRef"],
        "approvedDecisionRefs": approved_decision_refs or [],
        "relevantEventRefs": relevant_event_refs[:50],  # bounded, never full history
    }
    if not is_valid_contract("pipeline-context-package", pkg):
        raise ValueError("invalid PipelineContextPackage")
    return pkg


class AgentWorker:
    def __init__(self, reducer: Optional[StateReducer] = None,
                 caller: Optional[AgentCaller] = None):
        self.reducer = reducer or StateReducer()
        self.caller = caller or (lambda _p: {"ok": False, "text": "", "error": "no caller injected"})

    def on_event(self, event: dict, relevant_event_refs: Optional[list[str]] = None) -> dict:
        """Trigger the agent for ONE event (anomaly / phase-complete / approval).

        Returns the worker result with the agent's JSON payload parsed; the
        worker NEVER mutates state. Non-trigger events and unparseable model
        output both fail loudly (never forwarded verbatim).
        """
        etype = event.get("eventType", "")
        if etype not in TRIGGER_EVENT_TYPES:
            return {
                "ok": False,
                "error": f"event type '{etype}' is not a worker trigger "
                         "(anomaly/phase-complete/approval only)",
                "repaired": False,
            }
        run_id = event["runId"]
        snapshot = self.reducer.reduce_run(
            run_id, event.get("pipelineId", ""), event.get("pipelineVersion", 1))
        pkg = build_context_package(snapshot, relevant_event_refs or [event["eventId"]])
        prompt = (
            "You are a Pipeline Governance Agent. Read ONLY the context package. "
            "Interpret the trigger event and propose a remediation or placement "
            "suggestion as STRICT JSON. Never modify state, approvals or runs. "
            "Never claim a fact not present in the context.\n\n"
            f"EVENT: {etype}\n"
            f"CONTEXT: {pkg}"
        )
        raw = self.caller(prompt)
        if not raw.get("ok"):
            return {"ok": False, "error": raw.get("error") or "agent call failed",
                    "repaired": False}
        parsed, repaired = parse_agent_json(raw.get("text", ""))
        if parsed is None:
            return {
                "ok": False,
                "error": "agent output is not valid JSON after one repair pass",
                "repaired": False,
                "rawTruncated": (raw.get("text", "")[:200]),
            }
        return {"ok": True, "result": parsed, "repaired": repaired}
