"""Target-quality rule: label distribution must support training.

Checks (all thresholds from AssessmentConfig, never hardcoded):
  - label missing rate above target_missing_threshold          -> HIGH/REVIEW
  - a single distinct label value (degenerate target)          -> HIGH/REVIEW
  - severe class imbalance on a binary target                  -> HIGH/REVIEW
When the distribution cannot be obtained (sensitive target, read failure)
the rule cannot evaluate -> evidence gap -> INSUFFICIENT_EVIDENCE.
"""
from __future__ import annotations

from cdxr.contracts import (
    R_TARGET_DISTRIBUTION,
    FindingSeverity,
    TrainingAssessmentFinding,
)
from cdxr.rules import RuleContext


def target_distribution(ctx: RuleContext) -> list[TrainingAssessmentFinding]:
    target = ctx.request.target_field
    dist = (ctx.distributions or {}).get(target)
    if dist is None or dist.counts is None:
        return [TrainingAssessmentFinding(
            code=R_TARGET_DISTRIBUTION,
            severity=FindingSeverity.HIGH.value,
            field=target,
            message=f"value distribution unavailable for target '{target}' "
                    "(sensitive field or unreadable)",
            evidence_reference=ctx.table_ref,
            recommendation="use a non-sensitive target or allow distribution access",
            evidence_gap=True,
        )]
    row_count = ctx.profile.row_count if ctx.profile is not None else None
    if row_count is None:
        return [TrainingAssessmentFinding(
            code=R_TARGET_DISTRIBUTION,
            severity=FindingSeverity.HIGH.value,
            field=target,
            message="row statistics unavailable — cannot assess label distribution",
            evidence_reference=ctx.table_ref,
            evidence_gap=True,
        )]
    counts = dist.counts
    non_null = sum(counts.values())
    missing_rate = (row_count - non_null) / row_count if row_count else 1.0

    findings: list[TrainingAssessmentFinding] = []
    if missing_rate >= ctx.config.target_missing_threshold:
        findings.append(TrainingAssessmentFinding(
            code=R_TARGET_DISTRIBUTION,
            severity=FindingSeverity.HIGH.value,
            field=target,
            message="target label missing rate exceeds the configured threshold",
            observed=f"missing_rate={missing_rate:.3f}",
            expected=f"missing_rate < {ctx.config.target_missing_threshold}",
            evidence_reference=ctx.table_ref,
            recommendation="drop rows without labels or re-collect labels",
        ))
    if len(counts) <= 1:
        findings.append(TrainingAssessmentFinding(
            code=R_TARGET_DISTRIBUTION,
            severity=FindingSeverity.HIGH.value,
            field=target,
            message="target has a single label value — degenerate for training",
            observed=f"distinct_labels={len(counts)}, non_null={non_null}",
            expected="at least two distinct label values",
            evidence_reference=ctx.table_ref,
            recommendation="re-check the label definition and data generation",
        ))
    if len(counts) == 2 and non_null:
        minority = min(counts.values())
        ratio = minority / non_null
        if ratio < ctx.config.min_positive_ratio:
            findings.append(TrainingAssessmentFinding(
                code=R_TARGET_DISTRIBUTION,
                severity=FindingSeverity.HIGH.value,
                field=target,
                message="severe class imbalance on the binary target",
                observed=f"minority_ratio={ratio:.3f}",
                expected=f"minority_ratio >= {ctx.config.min_positive_ratio}",
                evidence_reference=ctx.table_ref,
                recommendation="collect more minority-class rows or rebalance explicitly",
            ))
    return findings
