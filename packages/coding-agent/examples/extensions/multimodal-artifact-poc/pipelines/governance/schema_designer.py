"""Schema Designer — the DESIGN role of the Pipeline Governance Agent.

Deterministic discovery produces a SourceDatasetProfile; the injected LLM
caller then proposes the BUSINESS semantics (granularity, keys, time fields,
field mappings, partitioning, execution mode) from that evidence, and this
module assembles a validated SchemaSpec + PipelineSpec draft for human
approval at Gate 1.

The designer NEVER:
  - queries the database / gateway or reads files beyond the profile;
  - fabricates fields not present in the profile;
  - writes state, approvals or runs;
  - forwards the raw model text verbatim (strict JSON parse + one repair).

The LLM call is an injected caller (prompt -> {"ok", "text", "error"}); the
default is a stub that fails loudly — production wiring is a separate step.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from pipelines.governance.agent_worker import parse_agent_json
from pipelines.governance.contracts import is_valid_contract
from pipelines.governance.validation import validate_pipeline_spec, validate_schema_spec

# Callable injected by the runtime: prompt -> {ok, text, error}
DesignCaller = Callable[[str], dict]

DEFAULT_BACKEND = "PYICEBERG_LOCAL"
DEFAULT_MODE = "BATCH"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def build_design_prompt(profile: dict, target_usage: str, profile_ref: str = "profile://source") -> str:
    """What the DESIGN agent receives: evidence only, plus the target usage."""
    lines: list[str] = [
        "You are a Pipeline Governance Agent in the DESIGN role. You propose the "
        "business semantics of a target dataset based ONLY on the deterministic "
        "SourceDatasetProfile below.",
        "",
        "HARD RULES:",
        "- Never query databases, never call the gateway, never read files, never invent fields "
          "not present in the profile fields.",
        "- Every field you reference in fieldMappings must exist in the profile fields.",
        "- Output STRICT JSON only (single object, no markdown fence text outside it).",
        "- Do not claim a fact not present in the profile evidence.",
        "- You propose; you never approve, never write state, never modify anything.",
        "",
        "OUTPUT SHAPE (fixed keys, do not deviate):",
        "{\n"
        '  "businessGranularity": "one row represents ...",\n'
        '  "primaryKey": ["<targetField>", ...],\n'
        '  "businessKeys": ["<targetField>", ...],\n'
        '  "timeFields": ["<event time field>", ...],\n'
        '  "fieldMappings": [{"sourceField": "...", "targetField": "...", "targetType": "..."}],\n'
        '  "partitioning": "..." ,\n'
        '  "sensitiveFields": ["<targetField>", ...],\n'
        '  "executionMode": "BATCH",\n'
        '  "updateMode": "APPEND",\n'
        '  "timeSemantics": "PROCESSING_TIME",\n'
        '  "assumptions": ["..."],\n'
        '  "risks": ["..."]\n'
        "}",
        "",
        f"TARGET USAGE: {target_usage}",
        f"PROFILE REF: {profile_ref}",
        f"PROFILE: {profile}",
    ]
    return "\n".join(lines)


def _default_steps(target_dataset: str, source: str) -> list[dict]:
    """Deterministic step skeleton; the approved spec is compiled by the
    deterministic Compiler, this is only the draft preview."""
    return [
        {"stepId": "load", "operation": "READ", "input": source, "output": f"raw:{target_dataset}"},
        {"stepId": "transform", "operation": "TRANSFORM", "input": f"raw:{target_dataset}", "output": f"clean:{target_dataset}"},
        {"stepId": "write", "operation": "WRITE", "input": f"clean:{target_dataset}", "output": target_dataset},
    ]


def _as_list(value: Any) -> list:
    """Normalize a partitioning/fields value (string or list) to a list."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [str(value)]


class SchemaDesigner:
    """Assembles a validated SchemaSpec + PipelineSpec draft from an injected
    LLM design decision (strict JSON). Fails loudly on invalid output."""

    def __init__(self, caller: Optional[DesignCaller] = None):
        self.caller = caller or (lambda _p: {"ok": False, "text": "", "error": "no design caller injected"})

    def design(self, profile: dict, target_usage: str, pipeline_id: str,
               target_dataset: str, version: int = 1) -> dict:
        """Run the DESIGN step. Returns {ok, schemaSpec, pipelineSpec, issues,
        repaired} or {ok: False, error, ...}."""
        fields = profile.get("fields") or []
        if not fields:
            return {"ok": False, "error": "profile has no fields; refusing to design",
                    "repaired": False}
        source_ref = profile.get("datasetId") or "source"

        prompt = build_design_prompt(profile, target_usage)
        raw = self.caller(prompt)
        if not raw.get("ok"):
            return {"ok": False, "error": raw.get("error") or "design caller failed",
                    "repaired": False}
        parsed, repaired = parse_agent_json(raw.get("text", ""))
        if parsed is None:
            return {"ok": False,
                    "error": "design output is not valid JSON after one repair pass",
                    "repaired": False, "rawTruncated": raw.get("text", "")[:200]}

        now = _now()
        schema_spec = {
            "specId": _new_id("sspec"),
            "version": version,
            "targetDataset": target_dataset,
            "businessGranularity": parsed.get("businessGranularity", ""),
            "primaryKey": parsed.get("primaryKey") or None,
            "businessKeys": parsed.get("businessKeys") or [],
            "fieldMappings": parsed.get("fieldMappings") or [],
            "types": {},
            "timeFields": parsed.get("timeFields") or [],
            "partitioning": _as_list(parsed.get("partitioning")),
            "compatibilityStrategy": "ADDITIVE",
            "sensitiveFields": parsed.get("sensitiveFields") or [],
            "assumptions": parsed.get("assumptions") or [],
            "risks": parsed.get("risks") or [],
            "createdAt": now,
        }
        # types: mirror the mapped target types (evidence from profile).
        for m in schema_spec["fieldMappings"]:
            schema_spec["types"][m.get("targetField")] = m.get("targetType", "string")

        pk = parsed.get("primaryKey") or []
        pipeline_spec = {
            "specId": _new_id("pspec"),
            "version": version,
            "pipelineId": pipeline_id,
            "sources": [source_ref],
            "target": target_dataset,
            "executionMode": parsed.get("executionMode") or DEFAULT_MODE,
            "executionBackend": parsed.get("executionBackend") or DEFAULT_BACKEND,
            "updateMode": parsed.get("updateMode") or "APPEND",
            "steps": _default_steps(target_dataset, source_ref),
            "keys": {"primaryKey": pk, "businessKeys": parsed.get("businessKeys") or []},
            "timeSemantics": parsed.get("timeSemantics") or "PROCESSING_TIME",
            "partitioning": _as_list(parsed.get("partitioning")),
            "schemaEvolutionPolicy": "ADDITIVE",
            "assumptions": parsed.get("assumptions") or [],
            "risks": parsed.get("risks") or [],
            "createdAt": now,
        }

        issues = validate_schema_spec(schema_spec, profile)
        issues += validate_pipeline_spec(pipeline_spec, schema_spec)
        contract_ok = is_valid_contract("schema-spec", schema_spec) and \
            is_valid_contract("pipeline-spec", pipeline_spec)
        if issues or not contract_ok:
            return {"ok": False, "error": "design failed validation",
                    "issues": issues, "repaired": repaired,
                    "schemaSpec": schema_spec, "pipelineSpec": pipeline_spec}
        return {"ok": True, "schemaSpec": schema_spec, "pipelineSpec": pipeline_spec,
                "issues": [], "repaired": repaired}
