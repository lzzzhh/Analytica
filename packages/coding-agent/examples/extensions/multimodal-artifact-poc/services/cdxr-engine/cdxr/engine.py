"""Assessment engine — deterministic orchestration.

1. structural request validation (never guesses, never accepts SQL/expressions)
2. schema resolution and field-existence checks
3. bounded aggregate data fetch through TrainingDatasetPort (every port call
   is guarded: failures become rule-error findings, never silent ALLOWs)
4. rule evaluation (pure functions; defensively wrapped)
5. traceability (a snapshot reference is mandatory)
6. deterministic status aggregation (see contracts.aggregate_status)
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from cdxr.config import AssessmentConfig
from cdxr.contracts import (
    ASSESSMENT_RULE_VERSION,
    AssessmentStatus,
    C_INFO_MISSING,
    C_REQUEST_INVALID,
    C_RULE_ERROR,
    R_TRACEABILITY,
    FindingSeverity,
    SensitiveFieldPolicy,
    TrainingAssessmentFinding,
    TrainingAssessmentRequest,
    TrainingAssessmentResult,
    TrainingPurpose,
    ValidationStrategyType,
    aggregate_status,
    new_assessment_id,
)
from cdxr.ports import DatasetSchema, TrainingDatasetPort
from cdxr.rules import RuleContext
from cdxr.rules.leakage import label_derived, target_in_features
from cdxr.rules.quality import target_distribution
from cdxr.rules.sampling import constant_feature, feature_missingness, sample_size
from cdxr.rules.sensitive import sensitive_feature
from cdxr.rules.temporal import post_outcome, validation_leakage

_FIELD_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")

_RULES = (
    target_in_features,
    label_derived,
    post_outcome,
    sensitive_feature,
    target_distribution,
    sample_size,
    feature_missingness,
    constant_feature,
    validation_leakage,
)

# Rule ids: the rule function names, plus the special "traceability" gate
# (engine step 6). Feature-driven disabling (round3.cdxr_* feature ids ->
# rule ids) is applied by the gateway resolver via `enabled_rules`.
ALL_RULE_IDS = frozenset(
    {rule.__name__ for rule in _RULES} | {"traceability"})

RULE_FEATURE_MAP: dict[str, frozenset[str]] = {
    "round3.cdxr_target_leakage": frozenset({"target_in_features", "label_derived"}),
    "round3.cdxr_temporal": frozenset({"post_outcome"}),
    "round3.cdxr_sensitive": frozenset({"sensitive_feature"}),
    "round3.cdxr_target_distribution": frozenset({"target_distribution"}),
    "round3.cdxr_sample_size": frozenset({"sample_size"}),
    "round3.cdxr_missingness": frozenset({"feature_missingness"}),
    "round3.cdxr_constant_feature": frozenset({"constant_feature"}),
    "round3.cdxr_validation_split": frozenset({"validation_leakage"}),
    "round3.cdxr_traceability": frozenset({"traceability"}),
}


def run_assessment(request: TrainingAssessmentRequest,
                   port: TrainingDatasetPort,
                   config: AssessmentConfig | None = None,
                   *, now: str | None = None,
                   enabled_rules: set[str] | None = None) -> TrainingAssessmentResult:
    """Assess a dataset for training suitability. Pure with respect to the
    port — no writes, no raw rows, deterministic status.

    `enabled_rules`: rule ids that may run (subset of ALL_RULE_IDS). When a
    rule is disabled it is not executed and recorded in `disabled_rules`; it
    is never reported as PASS. Default: all rules enabled.
    """
    cfg = config or AssessmentConfig()
    checked_at = now or datetime.now(timezone.utc).isoformat()
    assessment_id = new_assessment_id(
        request.dataset_id, request.snapshot_id, request.purpose,
        request.target_field, request.feature_fields, checked_at)
    findings: list[TrainingAssessmentFinding] = []
    warnings: list[str] = []
    table_ref = f"table://{request.dataset_id}?snapshot={request.snapshot_id or 'none'}"
    checked_fields = list(dict.fromkeys([request.target_field, *request.feature_fields]))

    enabled = set(ALL_RULE_IDS if enabled_rules is None else enabled_rules)
    disabled_rules = sorted(ALL_RULE_IDS - enabled)
    if disabled_rules:
        warnings.append(
            f"disabled rules ({', '.join(disabled_rules)}) were not executed and are not "
            "reported as PASS — verify remaining evidence before relying on ALLOW")

    def finish(status: str, schema: DatasetSchema | None = None,
               checked: list[str] | None = None) -> TrainingAssessmentResult:
        # Safety gate (feature-gated runs): ALLOW must never be issued while
        # any rule was disabled — the unexecuted checks are an evidence gap.
        if status == AssessmentStatus.ALLOW.value and disabled_rules:
            warnings.append(
                "ALLOW downgraded to INSUFFICIENT_EVIDENCE because rules were "
                f"disabled ({', '.join(disabled_rules)}) — do not use this assessment "
                "to authorize training")
            status = AssessmentStatus.INSUFFICIENT_EVIDENCE.value
        return TrainingAssessmentResult(
            assessment_id=assessment_id,
            dataset_id=request.dataset_id,
            snapshot_id=schema.snapshot_id if schema is not None else request.snapshot_id,
            purpose=request.purpose,
            status=status,
            summary=f"assessment {assessment_id}: {status} — {len(findings)} finding(s)",
            findings=findings,
            checked_fields=checked or checked_fields,
            rule_version=ASSESSMENT_RULE_VERSION,
            checked_at=checked_at,
            raw_rows_returned=False,
            warnings=warnings,
            checked_rules=sorted(rule_id for rule_id in ALL_RULE_IDS if rule_id in enabled),
            disabled_rules=disabled_rules,
        )

    # 1) structural validation (no port involved)
    findings.extend(_validate_shape(request, table_ref))
    if any(f.code == C_REQUEST_INVALID for f in findings):
        return finish(_status_after(findings))

    # 2) schema resolution
    schema = _safe(findings, "get_schema", port.get_schema,
                  request.dataset_id, request.snapshot_id)
    if schema is None:
        findings.append(TrainingAssessmentFinding(
            code=C_INFO_MISSING, severity=FindingSeverity.HIGH.value,
            message="schema could not be resolved for the dataset/snapshot",
            evidence_reference=table_ref, evidence_gap=True))
        return finish(_status_after(findings))

    # 3) field existence (target/features required; time fields required when given)
    known = {f.name for f in schema.fields}
    strategy_field = request.validation_strategy.field if request.validation_strategy else None
    optional_fields = [f for f in (request.prediction_time_field,
                                   request.label_time_field, strategy_field) if f]
    missing_required = [f for f in checked_fields if f not in known]
    missing_optional = [f for f in optional_fields if f not in known]
    for field in missing_required:
        findings.append(TrainingAssessmentFinding(
            code=C_REQUEST_INVALID, severity=FindingSeverity.HIGH.value,
            field=field, message=f"field '{field}' not found in dataset schema",
            evidence_reference=table_ref, evidence_gap=True))
    for field in missing_optional:
        findings.append(TrainingAssessmentFinding(
            code=C_REQUEST_INVALID, severity=FindingSeverity.HIGH.value,
            field=field,
            message=f"referenced time/split field '{field}' not found in dataset schema",
            evidence_reference=table_ref, evidence_gap=True))
    if any(f.code == C_REQUEST_INVALID for f in findings):
        return finish(_status_after(findings), schema)

    # 4) bounded aggregate data (every call guarded)
    profile_fields = list(dict.fromkeys(
        [*checked_fields, *optional_fields, *(request.entity_id_fields or [])]))
    profile = _safe(findings, "get_profile", port.get_profile,
                   request.dataset_id, request.snapshot_id, profile_fields)
    sensitive = _safe(findings, "get_sensitive_classification",
                       port.get_sensitive_classification, request.dataset_id,
                       [request.target_field, *request.feature_fields],
                       request.snapshot_id) or {}
    roles = _safe(findings, "get_field_roles", port.get_field_roles,
                   request.dataset_id, request.feature_fields,
                   request.snapshot_id) or {}
    lineage = _safe(findings, "get_lineage", port.get_lineage,
                   request.dataset_id, request.snapshot_id)
    time_fields = list(dict.fromkeys([*request.feature_fields, *optional_fields]))
    time_profiles = {
        tp.field: tp
        for tp in (_safe(findings, "get_time_profile", port.get_time_profile,
                          request.dataset_id, time_fields,
                          request.snapshot_id) or ())
    }
    target_dist = _safe(findings, "get_value_distribution",
                        port.get_value_distribution, request.dataset_id,
                        request.target_field, request.snapshot_id)

    ctx = RuleContext(
        request=request, schema=schema, config=cfg, table_ref=table_ref,
        profile=profile, sensitive=sensitive, roles=roles,
        time_profiles=time_profiles,
        distributions={request.target_field: target_dist},
        lineage=lineage, warnings=warnings,
    )

    # 5) rules — defensively wrapped; a rule failure is evidence-gap, never ALLOW.
    #    Feature-gated: disabled rules are skipped and recorded, never PASS.
    for rule in _RULES:
        if rule.__name__ not in enabled:
            continue
        try:
            findings.extend(rule(ctx) or [])
        except Exception as exc:  # noqa: BLE001 — engine must stay deterministic
            findings.append(TrainingAssessmentFinding(
                code=C_RULE_ERROR, severity=FindingSeverity.HIGH.value,
                message=f"rule '{rule.__name__}' failed to evaluate: {type(exc).__name__}",
                evidence_reference=table_ref, evidence_gap=True))

    # 6) traceability: without a snapshot reference the provenance is unknown.
    #    Feature-gated by round3.cdxr_traceability ("traceability" rule id).
    if "traceability" in enabled:
        if schema.snapshot_id is None:
            findings.append(TrainingAssessmentFinding(
                code=R_TRACEABILITY, severity=FindingSeverity.HIGH.value,
                message="no snapshot reference could be determined — training data "
                        "provenance is not traceable",
                evidence_reference=table_ref, evidence_gap=True,
                recommendation="retry with an explicit snapshotId or a snapshot that resolves"))
    else:
        warnings.append("traceability rule disabled — ALLOW without a snapshot reference is possible")
    if lineage is None and ctx.warnings is not None:
        ctx.warnings.append("lineage unavailable; traceability limited to the snapshot reference")

    return finish(_status_after(findings), schema)


def _status_after(findings: list[TrainingAssessmentFinding]) -> str:
    return aggregate_status(findings).value


def _validate_shape(request: TrainingAssessmentRequest,
                    table_ref: str) -> list[TrainingAssessmentFinding]:
    """Structural validation — deterministic, no data access."""
    out: list[TrainingAssessmentFinding] = []

    def invalid(message: str, field: str | None = None) -> TrainingAssessmentFinding:
        return TrainingAssessmentFinding(
            code=C_REQUEST_INVALID, severity=FindingSeverity.HIGH.value,
            field=field, message=message, evidence_reference=table_ref,
            evidence_gap=True)

    if request.purpose not in {p.value for p in TrainingPurpose}:
        out.append(invalid(f"purpose must be 'model_training', got '{request.purpose}'"))
    if not request.target_field:
        out.append(invalid("targetField is required"))
    if not request.feature_fields:
        out.append(invalid("featureFields must be non-empty"))
    id_fields = request.entity_id_fields or []
    for field in [request.target_field, *request.feature_fields, *id_fields]:
        if not _FIELD_ID_RE.fullmatch(field):
            out.append(invalid(
                f"field name '{field}' is not a plain identifier — SQL or "
                "arbitrary expressions are not allowed", field=field))
    if request.sensitive_field_policy not in {p.value for p in SensitiveFieldPolicy}:
        out.append(invalid(
            f"sensitiveFieldPolicy must be one of "
            f"{[p.value for p in SensitiveFieldPolicy]}, got '{request.sensitive_field_policy}'"))
    if request.validation_strategy is not None:
        strategy = request.validation_strategy
        if strategy.type not in {t.value for t in ValidationStrategyType}:
            out.append(invalid(
                f"validationStrategy.type must be one of "
                f"{[t.value for t in ValidationStrategyType]}, got '{strategy.type}'"))
        elif strategy.type in ("time", "group") and not strategy.field and not strategy.cutoff:
            out.append(invalid(
                f"validationStrategy.type='{strategy.type}' requires a split field "
                "(or cutoff for time)"))
    return out


def _safe(findings: list[TrainingAssessmentFinding], label: str, call, *args):
    """Run a port call; failures become rule-error findings (-> INSUFFICIENT)."""
    try:
        return call(*args)
    except Exception as exc:  # noqa: BLE001
        findings.append(TrainingAssessmentFinding(
            code=C_RULE_ERROR, severity=FindingSeverity.HIGH.value,
            message=f"port call '{label}' failed: {type(exc).__name__}: {exc}",
            evidence_gap=True))
        return None
