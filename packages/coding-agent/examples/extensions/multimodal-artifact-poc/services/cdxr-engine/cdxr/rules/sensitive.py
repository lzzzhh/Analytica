"""Sensitive-feature rule.

The target variable and every feature are compared against the port's
explicit sensitivity classification (never guessed from names). The request
policy decides the outcome: block -> BLOCK, review (default) -> REVIEW,
allow -> LOW finding + warning.
"""
from __future__ import annotations

from cdxr.contracts import (
    R_SENSITIVE_FEATURE,
    FindingSeverity,
    SensitiveFieldPolicy,
    TrainingAssessmentFinding,
)
from cdxr.rules import RuleContext


def sensitive_feature(ctx: RuleContext) -> list[TrainingAssessmentFinding]:
    policy = ctx.request.sensitive_field_policy
    findings: list[TrainingAssessmentFinding] = []
    for field in [ctx.request.target_field, *ctx.request.feature_fields]:
        if not (ctx.sensitive or {}).get(field):
            continue
        if policy == SensitiveFieldPolicy.BLOCK.value:
            severity = FindingSeverity.CRITICAL.value
        elif policy == SensitiveFieldPolicy.ALLOW.value:
            severity = FindingSeverity.LOW.value
        else:
            severity = FindingSeverity.HIGH.value
        findings.append(TrainingAssessmentFinding(
            code=R_SENSITIVE_FEATURE,
            severity=severity,
            field=field,
            message="field is classified as sensitive; using it for training "
                    "requires the configured policy decision",
            observed=f"sensitive_field_policy={policy or 'review'}",
            expected="sensitive fields excluded, or policy explicitly set to allow/review",
            evidence_reference=ctx.table_ref,
            recommendation="exclude the sensitive field, pseudonymize it, or "
                           "obtain an explicit human decision",
        ))
        if policy == SensitiveFieldPolicy.ALLOW.value and ctx.warnings is not None:
            ctx.warnings.append(
                f"sensitive field '{field}' allowed by policy; no waiver was granted by this tool")
    return findings
