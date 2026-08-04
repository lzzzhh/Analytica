"""CDXR Governance Engine — deterministic validity, detectability, and policy evaluation.

MIGRATED from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/governance/cdxr/engine.py, 120 lines) with one generalization:
the risk_indicator vocabulary is no longer hardcoded — it is injected by the
domain package (domains/risk/governance/cdxr) through the rule registry.
Mechanism, thresholds, decision chain and confidence values are verbatim.

PR D: Does NOT call LLM. Computes evidence from DatasetProfile + DatasetManifest.
"""
from __future__ import annotations

from app.governance.cdxr.contracts import CdxrFeatureAssessmentV1, GovernanceDecision

# Reason codes (verbatim from the original module)
REASON_CODES = {
    "FUTURE_TIMESTAMP": {"severity": "HIGH", "default_action": "BLOCK"},
    "POST_PREDICTION_RECORD": {"severity": "HIGH", "default_action": "BLOCK"},
    "POST_OUTCOME_SOURCE": {"severity": "CRITICAL", "default_action": "BLOCK"},
    "LABEL_DERIVED": {"severity": "CRITICAL", "default_action": "BLOCK"},
    "TARGET_DUPLICATE": {"severity": "CRITICAL", "default_action": "BLOCK"},
    "TARGET_PROXY": {"severity": "HIGH", "default_action": "BLOCK"},
    "JOIN_PATH_TO_OUTCOME": {"severity": "HIGH", "default_action": "BLOCK"},
    "SOURCE_STAGE_MISMATCH": {"severity": "MEDIUM", "default_action": "REVIEW"},
    "UNRESOLVED_PREDICTION_BOUNDARY": {"severity": "HIGH", "default_action": "REVIEW"},
    "UNRESOLVED_TARGET": {"severity": "HIGH", "default_action": "REVIEW"},
    "LOW_SCHEMA_CONFIDENCE": {"severity": "MEDIUM", "default_action": "REVIEW"},
    "OCR_LOW_CONFIDENCE": {"severity": "MEDIUM", "default_action": "REVIEW"},
}

# Generic name patterns that hint at leakage (domain-neutral).
DEFAULT_NAME_PATTERN = ("final", "outcome", "label", "target", "status", "result")


def assess_validity(feature_id: str, column_role: dict, manifest: dict) -> dict:
    """Check if a feature is available at prediction time."""
    reasons = []
    business_stage = column_role.get("business_stage", "unknown")
    column_role.get("table_id", "")

    if business_stage in ("post_outcome", "label_derived"):
        reasons.append("POST_OUTCOME_SOURCE")
    if column_role.get("time_role") == "outcome_time_dependent":
        reasons.append("FUTURE_TIMESTAMP")
    if column_role.get("feature_eligibility") == "BLOCK":
        reasons.append("SOURCE_STAGE_MISMATCH")

    available = len(reasons) == 0
    return {
        "status": "PASS" if available else "FAIL",
        "available_at_prediction_time": available,
        "reason_codes": reasons,
    }


def assess_detectability(feature_id: str, column_role: dict, profile: dict,
                         risk_indicators: tuple[str, ...] = ()) -> dict:
    """Detect leakage signals from column metadata.

    risk_indicators is injected by the domain layer (e.g. domains/risk provides
    its vocabulary); the generic kernel only contributes domain-neutral signals.
    """
    signals = []
    name = feature_id.lower()
    role = column_role.get("semantic_role", "unknown")
    stage = column_role.get("business_stage", "unknown")

    if role in ("outcome", "target", "label_derived"):
        signals.append("semantic_role")
    if stage in ("post_outcome", "label_derived"):
        signals.append("business_stage")
    if any(w in name for w in DEFAULT_NAME_PATTERN):
        signals.append("name_pattern")
    if any(w in name for w in risk_indicators):
        signals.append("risk_indicator")

    score = min(1.0, len(signals) * 0.3)
    return {
        "score": round(score, 4),
        "signals": signals,
    }


def evaluate_feature(feature_id: str, column_role: dict, manifest: dict,
                      profile: dict | None = None,
                      X: "np.ndarray | None" = None, y: "np.ndarray | None" = None,
                      feature_names: list[str] | None = None,
                      blocked_features: list[str] | None = None,
                      risk_indicators: tuple[str, ...] = (),
                      paired_trainer: "Callable | None" = None) -> CdxrFeatureAssessmentV1:
    """Full CDXR assessment for one feature, optionally with paired training.

    paired_trainer is injected by the caller (domain implementations return a
    dict with domain-neutral keys: metric_delta / score_delta / full_score /
    strict_score / governed_vs_random_delta). Without one, exploitability
    stays NOT_EVALUATED.
    """
    validity = assess_validity(feature_id, column_role, manifest)
    detectability = assess_detectability(feature_id, column_role, profile or {},
                                         risk_indicators=risk_indicators)

    # Paired training exploitability (if data + trainer provided)
    exploitability = {"status": "NOT_EVALUATED", "note": "Requires paired training"}
    if X is not None and y is not None and feature_names is not None and paired_trainer is not None:
        blocked = blocked_features or []
        review = [feature_id] if feature_id not in blocked else []
        exp = paired_trainer(X, y, feature_names, blocked, review).get("exploitability", {})
        if exp.get("status") == "VERIFIED":
            exploitability = {
                "status": "VERIFIED",
                "metric_delta": exp.get("metric_delta", 0),
                "score_delta": exp.get("score_delta", 0),
                "full_score": exp.get("full_score", 0),
                "strict_score": exp.get("strict_score", 0),
                "governed_vs_random": exp.get("governed_vs_random_delta", 0),
            }

    # Decision logic (verbatim)
    if not validity["available_at_prediction_time"]:
        decision = GovernanceDecision.BLOCK.value
    elif detectability["score"] > 0.5:
        decision = GovernanceDecision.NEEDS_REVIEW.value
    elif column_role.get("confidence", 1.0) < 0.7:
        decision = GovernanceDecision.NEEDS_REVIEW.value
    else:
        decision = GovernanceDecision.ALLOW.value

    confidence = 0.95 if len(validity.get("reason_codes", [])) > 0 else 0.7

    return CdxrFeatureAssessmentV1(
        feature_id=feature_id,
        validity=validity,
        detectability=detectability,
        exploitability=exploitability,
        repair={"status": "NOT_EVALUATED", "strategy": "DROP_FEATURE" if decision == "BLOCK" else "NONE"},
        decision=decision,
        confidence=confidence,
        evidence_refs=[f"profile:{feature_id}", f"manifest:{column_role.get('table_id', '')}"],
    )
