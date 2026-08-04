"""Sampling and feature-quality rules: SAMPLE_SIZE, FEATURE_MISSINGNESS,
CONSTANT_FEATURE. All thresholds come from AssessmentConfig."""
from __future__ import annotations

from cdxr.contracts import (
    R_CONSTANT_FEATURE,
    R_FEATURE_MISSINGNESS,
    R_SAMPLE_SIZE,
    FindingSeverity,
    TrainingAssessmentFinding,
)
from cdxr.rules import RuleContext


def sample_size(ctx: RuleContext) -> list[TrainingAssessmentFinding]:
    row_count = ctx.profile.row_count if ctx.profile is not None else None
    if row_count is None:
        return [TrainingAssessmentFinding(
            code=R_SAMPLE_SIZE,
            severity=FindingSeverity.HIGH.value,
            message="row statistics unavailable — cannot assess sample size",
            evidence_reference=ctx.table_ref,
            evidence_gap=True,
        )]
    if row_count == 0:
        return [TrainingAssessmentFinding(
            code=R_SAMPLE_SIZE,
            severity=FindingSeverity.CRITICAL.value,
            message="dataset contains zero rows — nothing to train on",
            observed="row_count=0",
            expected="row_count > 0",
            evidence_reference=ctx.table_ref,
            recommendation="point at a snapshot that contains data",
        )]
    if row_count < ctx.config.min_sample_rows:
        return [TrainingAssessmentFinding(
            code=R_SAMPLE_SIZE,
            severity=FindingSeverity.HIGH.value,
            message="sample size below the configured minimum",
            observed=f"row_count={row_count}",
            expected=f"row_count >= {ctx.config.min_sample_rows}",
            evidence_reference=ctx.table_ref,
            recommendation="collect more rows or explicitly accept a small sample",
        )]
    return []


def feature_missingness(ctx: RuleContext) -> list[TrainingAssessmentFinding]:
    row_count = ctx.profile.row_count if ctx.profile is not None else None
    if row_count is None or row_count == 0:
        return []  # SAMPLE_SIZE already reports the empty/unavailable case
    stats_by_name = {s.name: s for s in ctx.profile.fields}
    findings: list[TrainingAssessmentFinding] = []
    for feature in ctx.request.feature_fields:
        stats = stats_by_name.get(feature)
        if stats is None or stats.null_count is None:
            findings.append(TrainingAssessmentFinding(
                code=R_FEATURE_MISSINGNESS,
                severity=FindingSeverity.HIGH.value,
                field=feature,
                message=f"null statistics unavailable for feature '{feature}'",
                evidence_reference=ctx.table_ref,
                evidence_gap=True,
            ))
            continue
        rate = stats.null_count / row_count
        if rate >= ctx.config.feature_missing_threshold:
            findings.append(TrainingAssessmentFinding(
                code=R_FEATURE_MISSINGNESS,
                severity=FindingSeverity.MEDIUM.value,
                field=feature,
                message="feature missing rate exceeds the configured threshold",
                observed=f"missing_rate={rate:.3f}",
                expected=f"missing_rate < {ctx.config.feature_missing_threshold}",
                evidence_reference=ctx.table_ref,
                recommendation="impute or drop the feature after human review",
            ))
    return findings


def constant_feature(ctx: RuleContext) -> list[TrainingAssessmentFinding]:
    if ctx.profile is None:
        return []
    stats_by_name = {s.name: s for s in ctx.profile.fields}
    findings: list[TrainingAssessmentFinding] = []
    for feature in ctx.request.feature_fields:
        stats = stats_by_name.get(feature)
        if stats is None or stats.distinct_count is None:
            continue
        if stats.distinct_count <= 1:
            findings.append(TrainingAssessmentFinding(
                code=R_CONSTANT_FEATURE,
                severity=FindingSeverity.MEDIUM.value,
                field=feature,
                message="feature is constant or single-valued — no predictive signal",
                observed=f"distinct({feature})={stats.distinct_count}",
                expected="distinct(feature) > 1",
                evidence_reference=ctx.table_ref,
                recommendation="drop the feature from training",
            ))
    return findings
