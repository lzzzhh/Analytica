"""Deterministic validation of SchemaSpec / PipelineSpec drafts.

Only validated specs may be compiled into a PipelineDraftArtifact; only an
approved review may freeze an ApprovedPipelineSpec. Validation is pure and
deterministic — no LLM involved.
"""
from __future__ import annotations

from typing import Any, Optional

from pipelines.governance.contracts import validate_contract


def validate_schema_spec(spec: dict, profile: Optional[dict] = None) -> list[dict]:
    """Returns list of ValidationIssue dicts (empty when valid)."""
    issues: list[dict] = []

    # Contract-level validation first — any JSON Schema error is an ERROR.
    contract_errors = validate_contract("schema-spec", spec)
    if contract_errors:
        issues.append(_issue("SCHEMA_SPEC_CONTRACT_INVALID", "ERROR",
                             "; ".join(contract_errors), None))

    # semantic rules
    if not spec.get("fieldMappings"):
        issues.append(_issue("EMPTY_FIELD_MAPPINGS", "ERROR", "fieldMappings must not be empty", "fieldMappings"))

    # primary key: if declared, must reference a mapped target field and be
    # non-empty (the agent proposes it; the human approves it).
    pk = spec.get("primaryKey")
    if pk is not None:
        if not isinstance(pk, list) or len(pk) == 0:
            issues.append(_issue("EMPTY_PRIMARY_KEY", "ERROR", "primaryKey must be a non-empty list", "primaryKey"))
        else:
            target_fields = {m["targetField"] for m in spec.get("fieldMappings", [])}
            for k in pk:
                if k not in target_fields:
                    issues.append(_issue("PRIMARY_KEY_NOT_MAPPED", "ERROR",
                                         f"primary key '{k}' not in fieldMappings", "primaryKey"))
    if spec.get("targetDataset") and len(spec["targetDataset"]) < 3:
        issues.append(_issue("TARGET_DATASET_TOO_SHORT", "WARNING",
                             "targetDataset name is suspiciously short", "targetDataset"))

    # cross-check against the profile when provided: primary key candidate
    # must appear among profile candidateKeys (evidence-based). No evidence →
    # ERROR: the operator must amend the spec or supply real evidence; the
    # first version has no manual override mechanism.
    if profile is not None and pk:
        cand = {tuple(c["fields"]) for c in profile.get("candidateKeys", [])}
        # composite keys are matched as a whole combination (candidate keys
        # are field combinations); single-field keys keep the same behaviour.
        if tuple(pk) in cand:
            key_meta = next(c for c in profile["candidateKeys"]
                            if tuple(c["fields"]) == tuple(pk))
            if not key_meta.get("fullScanVerified", False):
                issues.append(_issue("PRIMARY_KEY_SAMPLE_ONLY", "ERROR",
                                     f"primary key {pk} evidence is sample-only "
                                     "(fullScanVerified=false)", "primaryKey"))
        else:
            issues.append(_issue("PRIMARY_KEY_NO_EVIDENCE", "ERROR",
                                 f"primary key {pk} has no candidate-key evidence "
                                 "in profile", "primaryKey"))
    return issues


def validate_pipeline_spec(spec: dict, schema_spec: Optional[dict] = None) -> list[dict]:
    """Returns list of ValidationIssue dicts (empty when valid)."""
    issues: list[dict] = []

    contract_errors = validate_contract("pipeline-spec", spec)
    if contract_errors:
        issues.append(_issue("PIPELINE_SPEC_CONTRACT_INVALID", "ERROR",
                             "; ".join(contract_errors), "pipelineSpec"))

    steps = spec.get("steps", [])
    if not steps:
        issues.append(_issue("EMPTY_STEPS", "ERROR", "steps must not be empty", "steps"))
    else:
        seen_ids = set()
        for s in steps:
            if s.get("stepId") in seen_ids:
                issues.append(_issue("DUPLICATE_STEP_ID", "ERROR",
                                     f"duplicate stepId '{s.get('stepId')}'", "steps"))
            seen_ids.add(s.get("stepId"))

    if not spec.get("target"):
        issues.append(_issue("TARGET_MISSING", "ERROR", "target must not be empty", "target"))
    if not spec.get("sources"):
        issues.append(_issue("SOURCES_MISSING", "ERROR", "sources must not be empty", "sources"))

    # keys must be non-empty for any non-APPEND update mode
    if spec.get("updateMode") != "APPEND":
        keys = spec.get("keys", {})
        if not keys or all(not v for v in keys.values()):
            issues.append(_issue("KEYS_MISSING", "ERROR",
                                 "keys required for non-APPEND update mode", "keys"))

    if schema_spec is not None:
        if spec.get("target") != schema_spec.get("targetDataset"):
            issues.append(_issue("TARGET_MISMATCH", "ERROR",
                                 "pipeline target != schemaSpec targetDataset", "target"))

    return issues


def _issue(code: str, severity: str, message: str, field_path: Optional[str] = None) -> dict:
    return {"code": code, "severity": severity, "message": message,
            "fieldPath": field_path, "evidenceRefs": []}
