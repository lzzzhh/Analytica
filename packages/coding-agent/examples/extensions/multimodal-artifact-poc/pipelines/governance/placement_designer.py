"""Placement Designer — the PLACEMENT role of the Pipeline Governance Agent.

After processing completes, the injected LLM caller proposes where the data
belongs (ODS/DWD/DWS/ADS/FEATURE_STORE) from the dataset's shape and usage.
The deterministic layer validator and the contract check guard the output;
the human approves at Gate 3. The Agent never writes to any layer.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from pipelines.governance.agent_worker import parse_agent_json
from pipelines.governance.contracts import is_valid_contract
from pipelines.governance.placement import CONTROLLED_TARGETS, PlacementGovernance

DesignCaller = Callable[[str], dict]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def build_placement_prompt(profile: dict, source_dataset: str, usage: str) -> str:
    lines: list[str] = [
        "You are a Pipeline Governance Agent in the PLACEMENT role. Propose "
        "which warehouse layer the processed dataset should land in, based "
        "ONLY on the evidence below.",
        "",
        "LAYER SEMANTICS:",
        "- ODS: raw, immutable, non-derived original records;",
        "- DWD: cleaned, standardised, deduplicated business detail (grain preserved);",
        "- DWS: reusable subject aggregates, wide tables, candidate features;",
        "- ADS: consumption products for apps/reports/training.",
        "",
        "HARD RULES:",
        "- Never query databases or read files; use only the profile + usage.",
        "- targetLayer MUST be one of ODS|DWD|DWS|ADS|FEATURE_STORE.",
        "- Output STRICT JSON only with these keys:",
        '{"targetLayer": "...", "targetDataset": "...", "rationale": "...",',
        ' "grainDetail": "...", "derivationType": "RAW|DERIVED",',
        ' "primaryKey": ["..."], "partitioning": ["..."],',
        ' "writeMode": "APPEND|OVERWRITE|MERGE", "retentionPolicy": "...",',
        ' "backfillRequired": false, "affectedDownstream": ["..."],',
        ' "assumptions": ["..."], "risks": ["..."]}',
        "",
        f"CONTROLLED TARGETS (targetDataset MUST be one of these): "
        + ", ".join(sorted(CONTROLLED_TARGETS)),
        f"SOURCE DATASET: {source_dataset}",
        f"TARGET USAGE: {usage}",
        f"PROFILE: {profile}",
    ]
    return "\n".join(lines)


class PlacementDesigner:
    """Assembles a validated PlacementPlan draft from an injected LLM
    decision. Fails loudly on invalid output; never writes anywhere."""

    def __init__(self, caller: Optional[DesignCaller] = None):
        self.caller = caller or (lambda _p: {"ok": False, "text": "", "error": "no placement caller injected"})
        self._placement = PlacementGovernance()

    def design(self, profile: dict, source_dataset: str, usage: str,
               version: int = 1) -> dict:
        raw = self.caller(build_placement_prompt(profile, source_dataset, usage))
        if not raw.get("ok"):
            return {"ok": False, "error": raw.get("error") or "placement caller failed",
                    "repaired": False}
        parsed, repaired = parse_agent_json(raw.get("text", ""))
        if parsed is None:
            return {"ok": False,
                    "error": "placement output is not valid JSON after one repair pass",
                    "repaired": False, "rawTruncated": raw.get("text", "")[:200]}

        plan = {
            "placementPlanId": _new_id("pp"),
            "version": version,
            "sourceDataset": source_dataset,
            "targetLayer": parsed.get("targetLayer", ""),
            "targetDataset": parsed.get("targetDataset") or source_dataset,
            "rationale": parsed.get("rationale") or "",
            "grainDetail": parsed.get("grainDetail") or "",
            "derivation": parsed.get("derivationType") or
                          ("RAW" if parsed.get("targetLayer") == "ODS" else "DERIVED"),
            "targetSchemaRef": "schema-spec:latest",
            "primaryKey": parsed.get("primaryKey") or [],
            "partitioning": parsed.get("partitioning") or [],
            "writeMode": parsed.get("writeMode") or "APPEND",
            "schemaEvolutionPolicy": "ADDITIVE",
            "retentionPolicy": parsed.get("retentionPolicy") or "default",
            "backfillRequired": bool(parsed.get("backfillRequired")),
            "affectedDownstream": parsed.get("affectedDownstream") or [],
            "qualityGateRefs": [],
            "assumptions": parsed.get("assumptions") or [],
            "risks": parsed.get("risks") or [],
            "status": "DRAFT",
        }
        errors = self._placement.validate_plan(plan)
        if errors:
            return {"ok": False, "error": "; ".join(errors), "issues": errors,
                    "repaired": repaired, "plan": plan}
        return {"ok": True, "plan": plan, "issues": [], "repaired": repaired,
                "contractValid": is_valid_contract("placement-plan", plan)}
