"""CDXR aggregation — governance score, dimension scores, trust profile.

Deterministic; findings drive the score, never an LLM.
"""
from __future__ import annotations

from typing import Any

from app.governance.cdxr.contracts import (
    FindingStatus,
    GovernanceFindingV1,
    Severity,
    SystemRiskStatus,
    TrustProfileV1,
)

SEVERITY_WEIGHTS = {
    Severity.CRITICAL.value: 40,
    Severity.HIGH.value: 25,
    Severity.MEDIUM.value: 10,
    Severity.LOW.value: 5,
    Severity.INFO.value: 0,
}

# Current-state projection shared by profile / severity / dimension score /
# review queue: findings that still need attention. RESOLVED and WAIVED are
# inactive; UNDER_REVIEW stays active — a finding under human review must not
# silently flip the dataset back to TRUSTED (review round-4 P1).
ACTIVE_STATUSES = (FindingStatus.OPEN.value, FindingStatus.UNDER_REVIEW.value)

TRUSTED_THRESHOLD = 90.0
CONDITIONAL_THRESHOLD = 70.0


def severity_weight(severity: str) -> int:
    return SEVERITY_WEIGHTS.get(severity, 10)


def compute_governance_score(findings: list[GovernanceFindingV1]) -> tuple[float, str]:
    """Score 0..100; status TRUSTED | CONDITIONAL | UNTRUSTED."""
    active = [f for f in findings if f.status in ACTIVE_STATUSES]
    if not active:
        return 100.0, "TRUSTED"
    penalty = sum(severity_weight(f.severity) for f in active)
    score = max(0.0, 100.0 - penalty)
    if score >= TRUSTED_THRESHOLD:
        status = "TRUSTED"
    elif score >= CONDITIONAL_THRESHOLD:
        status = "CONDITIONAL"
    else:
        status = "UNTRUSTED"
    return round(score, 2), status


def compute_dimension_scores(findings: list[GovernanceFindingV1],
                             dimension_of_rule: dict[str, str]) -> dict[str, float]:
    """Per-dimension score (100 - penalties of active findings in that dimension)."""
    dims: dict[str, list[GovernanceFindingV1]] = {}
    for f in findings:
        if f.status not in ACTIVE_STATUSES:
            continue
        dim = dimension_of_rule.get(f.rule_id, "other")
        dims.setdefault(dim, []).append(f)
    out: dict[str, float] = {}
    for dim, fs in dims.items():
        penalty = sum(severity_weight(f.severity) for f in fs)
        out[dim] = round(max(0.0, 100.0 - penalty), 2)
    return out


def highest_severity(findings: list[GovernanceFindingV1]) -> str:
    order = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
    severities = {f.severity for f in findings if f.status in ACTIVE_STATUSES}
    if not severities:
        return "INFO"
    return max(severities, key=lambda s: order.index(s))


def risk_status_for(severity: str) -> SystemRiskStatus:
    """Map a finding severity to a system risk status."""
    if severity == Severity.CRITICAL.value:
        return SystemRiskStatus.HIGH_RISK
    if severity == Severity.HIGH.value:
        return SystemRiskStatus.SUSPICIOUS
    if severity == Severity.MEDIUM.value:
        return SystemRiskStatus.SUSPICIOUS
    return SystemRiskStatus.LOW_RISK


def build_trust_profile(
    dataset_id: str,
    snapshot_id: str | None,
    findings: list[GovernanceFindingV1],
    quality_status: str,
    quality_reference: str,
    lineage_reference: str,
    dimension_of_rule: dict[str, str],
    generated_at: str,
    rule_count: int = 0,
    failed_rule_count: int = 0,
) -> TrustProfileV1:
    """Assemble the ADS trust profile for one dataset/snapshot.

    When mandatory rules failed to execute, the status degrades to
    INSUFFICIENT_EVIDENCE regardless of the score — a run where rules errored
    must never look TRUSTED (review fix).
    """
    score, status = compute_governance_score(findings)
    if failed_rule_count > 0:
        status = "INSUFFICIENT_EVIDENCE"
    active_findings = [f for f in findings if f.status in ACTIVE_STATUSES]
    return TrustProfileV1(
        dataset_id=dataset_id,
        snapshot_id=snapshot_id,
        governance_score=score,
        status=status,
        # "open" count follows the current-state projection (OPEN + UNDER_REVIEW)
        open_finding_count=len(active_findings),
        highest_severity=highest_severity(findings),
        dimension_scores=compute_dimension_scores(findings, dimension_of_rule),
        quality_status=quality_status,
        quality_reference=quality_reference,
        lineage_reference=lineage_reference,
        finding_ids=[f.finding_id for f in findings],
        generated_at=generated_at,
        rule_count=rule_count,
        failed_rule_count=failed_rule_count,
    )
