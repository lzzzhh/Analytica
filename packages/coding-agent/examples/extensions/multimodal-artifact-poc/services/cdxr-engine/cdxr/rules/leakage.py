"""Leakage rules: target-in-features and explicitly label-derived features.

LABEL_DERIVED_FEATURE only fires on explicit role metadata provided by the
port (config.label_derived_role) — the engine never guesses from field names.
"""
from __future__ import annotations

from cdxr.contracts import (
    R_LABEL_DERIVED_FEATURE,
    R_TARGET_IN_FEATURES,
    FindingSeverity,
    TrainingAssessmentFinding,
)
from cdxr.rules import RuleContext


def target_in_features(ctx: RuleContext) -> list[TrainingAssessmentFinding]:
    if ctx.request.target_field in ctx.request.feature_fields:
        return [TrainingAssessmentFinding(
            code=R_TARGET_IN_FEATURES,
            severity=FindingSeverity.CRITICAL.value,
            field=ctx.request.target_field,
            related_fields=[ctx.request.target_field],
            message="target field must not be used as a feature (guaranteed label leakage)",
            observed=f"target '{ctx.request.target_field}' listed in feature_fields",
            expected="target field excluded from feature_fields",
            evidence_reference=ctx.table_ref,
            recommendation="remove the target field from feature_fields",
        )]
    return []


def label_derived(ctx: RuleContext) -> list[TrainingAssessmentFinding]:
    marker = ctx.config.label_derived_role
    findings: list[TrainingAssessmentFinding] = []
    for feature in ctx.request.feature_fields:
        roles = (ctx.roles or {}).get(feature, set())
        if marker in roles:
            findings.append(TrainingAssessmentFinding(
                code=R_LABEL_DERIVED_FEATURE,
                severity=FindingSeverity.HIGH.value,
                field=feature,
                message=f"feature is explicitly marked '{marker}' (derived from the label)",
                observed=f"role '{marker}' declared for field '{feature}'",
                expected="no feature carries the label-derived role",
                evidence_reference=ctx.table_ref,
                recommendation="exclude label-derived fields from features or re-derive them",
            ))
    return findings
