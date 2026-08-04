"""Temporal rules: future-information leakage and validation leakage.

POST_OUTCOME_FEATURE compares the business time of temporal features against
the prediction time field (and, when provided, the label time field). A
feature whose max business time is later than the prediction point may carry
future information -> CRITICAL -> BLOCK. Non-temporal fields (no time
semantics per the port) are skipped, not guessed about. When the prediction
time field or its profile is unavailable the rule cannot run -> evidence gap.
"""
from __future__ import annotations

from cdxr.contracts import (
    R_POST_OUTCOME_FEATURE,
    R_VALIDATION_LEAKAGE,
    FindingSeverity,
    TrainingAssessmentFinding,
)
from cdxr.rules import RuleContext


def post_outcome(ctx: RuleContext) -> list[TrainingAssessmentFinding]:
    request = ctx.request
    prediction = request.prediction_time_field
    if not prediction:
        return [TrainingAssessmentFinding(
            code=R_POST_OUTCOME_FEATURE,
            severity=FindingSeverity.HIGH.value,
            message="predictionTimeField is required to check future-information leakage",
            evidence_reference=ctx.table_ref,
            recommendation="provide predictionTimeField (and labelTimeField when available)",
            evidence_gap=True,
        )]
    profiles = ctx.time_profiles or {}
    pred = profiles.get(prediction)
    if pred is None or not pred.temporal or pred.max_value is None:
        return [TrainingAssessmentFinding(
            code=R_POST_OUTCOME_FEATURE,
            severity=FindingSeverity.HIGH.value,
            field=prediction,
            message=f"time profile unavailable for predictionTimeField '{prediction}'",
            evidence_reference=ctx.table_ref,
            evidence_gap=True,
        )]
    label_profile = None
    if request.label_time_field:
        label_profile = profiles.get(request.label_time_field)

    findings: list[TrainingAssessmentFinding] = []
    for feature in request.feature_fields:
        tp = profiles.get(feature)
        if tp is None:
            findings.append(TrainingAssessmentFinding(
                code=R_POST_OUTCOME_FEATURE,
                severity=FindingSeverity.HIGH.value,
                field=feature,
                message=f"time profile unavailable for feature '{feature}'",
                evidence_reference=ctx.table_ref,
                evidence_gap=True,
            ))
            continue
        if not tp.temporal:
            continue  # no business time semantics — nothing to compare
        if tp.max_value is None:
            findings.append(TrainingAssessmentFinding(
                code=R_POST_OUTCOME_FEATURE,
                severity=FindingSeverity.HIGH.value,
                field=feature,
                message=f"feature '{feature}' has no determinable max business time",
                evidence_reference=ctx.table_ref,
                evidence_gap=True,
            ))
            continue
        if pred.max_value < tp.max_value:
            findings.append(TrainingAssessmentFinding(
                code=R_POST_OUTCOME_FEATURE,
                severity=FindingSeverity.CRITICAL.value,
                field=feature,
                message="feature business time extends past the prediction point "
                        "(potential future-information leakage)",
                observed=f"max({feature})={tp.max_value} > max({prediction})={pred.max_value}",
                expected=f"max({feature}) <= max({prediction})",
                evidence_reference=ctx.table_ref,
                recommendation="exclude the feature or shift the prediction point",
            ))
        if label_profile is not None and label_profile.temporal \
                and label_profile.max_value is not None \
                and label_profile.max_value < tp.max_value:
            findings.append(TrainingAssessmentFinding(
                code=R_POST_OUTCOME_FEATURE,
                severity=FindingSeverity.CRITICAL.value,
                field=feature,
                message="feature business time extends past the label time "
                        "(feature values may be produced after the label)",
                observed=f"max({feature})={tp.max_value} > max(label field)={label_profile.max_value}",
                expected=f"max({feature}) <= max(label field)",
                evidence_reference=ctx.table_ref,
                recommendation="exclude the feature or verify its business time",
            ))
    return findings


def validation_leakage(ctx: RuleContext) -> list[TrainingAssessmentFinding]:
    strategy = ctx.request.validation_strategy
    if strategy is None:
        return []
    if strategy.type == "time":
        return _validation_leakage_time(ctx, strategy)
    if strategy.type == "group":
        return _validation_leakage_group(ctx, strategy)
    return []  # random split — nothing deterministic to check


def _validation_leakage_time(ctx: RuleContext, strategy) -> list[TrainingAssessmentFinding]:
    field = strategy.field
    cutoff = strategy.cutoff
    if not field:
        return [TrainingAssessmentFinding(
            code=R_VALIDATION_LEAKAGE,
            severity=FindingSeverity.HIGH.value,
            message="time validation strategy requires a split field",
            evidence_reference=ctx.table_ref,
            evidence_gap=True,
        )]
    tp = (ctx.time_profiles or {}).get(field)
    if tp is None or not tp.temporal or tp.min_value is None or tp.max_value is None:
        return [TrainingAssessmentFinding(
            code=R_VALIDATION_LEAKAGE,
            severity=FindingSeverity.HIGH.value,
            field=field,
            message=f"time profile unavailable for split field '{field}'",
            evidence_reference=ctx.table_ref,
            evidence_gap=True,
        )]
    if not cutoff:
        return [TrainingAssessmentFinding(
            code=R_VALIDATION_LEAKAGE,
            severity=FindingSeverity.HIGH.value,
            field=field,
            message="time validation strategy requires a cutoff",
            evidence_reference=ctx.table_ref,
            evidence_gap=True,
        )]
    if cutoff < tp.min_value:
        return [TrainingAssessmentFinding(
            code=R_VALIDATION_LEAKAGE,
            severity=FindingSeverity.HIGH.value,
            field=field,
            message="validation split is empty: cutoff precedes every row "
                    "(all rows land in training)",
            observed=f"cutoff={cutoff} < min({field})={tp.min_value}",
            expected=f"min({field}) <= cutoff <= max({field})",
            evidence_reference=ctx.table_ref,
            recommendation="pick a cutoff inside the observed time range",
        )]
    if cutoff >= tp.max_value:
        return [TrainingAssessmentFinding(
            code=R_VALIDATION_LEAKAGE,
            severity=FindingSeverity.HIGH.value,
            field=field,
            message="validation split is empty: cutoff follows every row "
                    "(all rows land in validation)",
            observed=f"cutoff={cutoff} >= max({field})={tp.max_value}",
            expected=f"min({field}) <= cutoff <= max({field})",
            evidence_reference=ctx.table_ref,
            recommendation="pick a cutoff inside the observed time range",
        )]
    # Non-overlap is guaranteed by the cutoff semantics once the cutoff lies
    # strictly inside the observed range: train <= cutoff < validation.
    return []


def _validation_leakage_group(ctx: RuleContext, strategy) -> list[TrainingAssessmentFinding]:
    field = strategy.field
    if not field:
        return [TrainingAssessmentFinding(
            code=R_VALIDATION_LEAKAGE,
            severity=FindingSeverity.HIGH.value,
            message="group validation strategy requires a group/entity field",
            evidence_reference=ctx.table_ref,
            evidence_gap=True,
        )]
    stats = None
    if ctx.profile is not None:
        stats = next((s for s in ctx.profile.fields if s.name == field), None)
    if stats is None or stats.distinct_count is None:
        return [TrainingAssessmentFinding(
            code=R_VALIDATION_LEAKAGE,
            severity=FindingSeverity.HIGH.value,
            field=field,
            message=f"distinct-count statistics unavailable for group field '{field}'",
            evidence_reference=ctx.table_ref,
            evidence_gap=True,
        )]
    if stats.distinct_count <= 1:
        return [TrainingAssessmentFinding(
            code=R_VALIDATION_LEAKAGE,
            severity=FindingSeverity.HIGH.value,
            field=field,
            message="group field is constant: rows cannot be split by entity "
                    "(single entity lands in both train and validation)",
            observed=f"distinct({field})={stats.distinct_count}",
            expected=f"distinct({field}) > 1",
            evidence_reference=ctx.table_ref,
            recommendation="use a group field with more than one distinct entity",
        )]
    return []
