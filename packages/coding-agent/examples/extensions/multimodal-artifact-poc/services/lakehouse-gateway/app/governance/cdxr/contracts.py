"""CDXR governance contracts.

MIGRATED from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/agents/contracts/models.py — CDXR-related classes extracted; the source
file mixes these with the project's agent state machine models).
CDXR = Cross-Data X-Ray: feature-leakage detection and repair governance.
GENERALIZATION: no domain terms; risk-domain vocabulary is injected by
domains/risk via the rule registry.
"""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class GovernanceDecision(str, Enum):
    ALLOW = "ALLOW"
    ALLOW_WITH_WARNING = "ALLOW_WITH_WARNING"
    BLOCK = "BLOCK"
    NEEDS_REVIEW = "NEEDS_REVIEW"


class SystemRiskStatus(str, Enum):
    LOW_RISK = "LOW_RISK"
    SUSPICIOUS = "SUSPICIOUS"
    HIGH_RISK = "HIGH_RISK"
    EXPLOITABLE = "EXPLOITABLE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class SystemRecommendation(str, Enum):
    REVIEW_ALLOW = "REVIEW_ALLOW"
    REVIEW_EXCLUDE = "REVIEW_EXCLUDE"
    REVIEW_REPAIR = "REVIEW_REPAIR"
    COLLECT_MORE_EVIDENCE = "COLLECT_MORE_EVIDENCE"


class FindingStatus(str, Enum):
    OPEN = "OPEN"
    UNDER_REVIEW = "UNDER_REVIEW"
    RESOLVED = "RESOLVED"
    WAIVED = "WAIVED"


class ReviewActionType(str, Enum):
    OPEN = "OPEN"
    REOPEN = "REOPEN"
    ASSIGN = "ASSIGN"
    ACKNOWLEDGE = "ACKNOWLEDGE"
    RESOLVE = "RESOLVE"
    WAIVE = "WAIVE"
    ESCALATE = "ESCALATE"


class Severity(str, Enum):
    INFO = "INFO"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class ConfidenceComponentsV1(BaseModel):
    """Confidence breakdown (original 7 components, deterministic)."""
    schema_evidence: float = 0.0
    semantic_evidence: float = 0.0
    temporal_evidence: float = 0.0
    lineage_evidence: float = 0.0
    statistical_evidence: float = 0.0
    exploitability_evidence: float = 0.0
    evidence_coverage: float = 0.0


class CdxrFeatureAssessmentV1(BaseModel):
    """Per-feature CDXR assessment (original contract, verbatim fields)."""
    contract_version: str = "cdxr-feature-assessment.v1"
    feature_id: str = ""
    validity: dict[str, Any] = Field(default_factory=dict)
    detectability: dict[str, Any] = Field(default_factory=dict)
    exploitability: dict[str, Any] = Field(default_factory=dict)
    repair: dict[str, Any] = Field(default_factory=dict)
    decision: str = "NEEDS_REVIEW"
    confidence: float = 0.0
    evidence_refs: list[str] = Field(default_factory=list)


class GovernanceFindingV1(BaseModel):
    """Governance finding (original contract extended with lifecycle fields)."""
    finding_id: str = ""
    run_id: str = ""
    dataset_id: str = ""
    field_name: str | None = None
    rule_id: str = ""
    risk_type: str = ""
    risk_status: SystemRiskStatus = SystemRiskStatus.INSUFFICIENT_EVIDENCE
    severity: Severity = Severity.MEDIUM
    confidence: float = 0.0
    confidence_components: ConfidenceComponentsV1 = Field(default_factory=ConfidenceComponentsV1)
    reason_codes: list[str] = Field(default_factory=list)
    evidence_refs: list[str] = Field(default_factory=list)
    snapshot_id: str | None = None
    data_version: str = ""
    quality_reference: str | None = None
    lineage_reference: str | None = None
    status: FindingStatus = FindingStatus.OPEN
    first_detected_at: str = ""
    last_detected_at: str = ""
    created_at: str = ""
    recommendation: SystemRecommendation = SystemRecommendation.COLLECT_MORE_EVIDENCE
    exploitability_probe: dict[str, Any] = Field(default_factory=dict)
    summary: str = ""


class GovernanceEvidenceV1(BaseModel):
    """Evidence linked to a finding (new entity, follows evidence_refs pattern)."""
    evidence_id: str = ""
    finding_id: str = ""
    source_type: str = ""          # quality | lineage | snapshot | profile | rule | dataset
    source_reference: str = ""
    source_snapshot: str = ""
    observed_value: str = ""
    expected_value: str | None = None
    confidence: float = 0.0
    evaluator_version: str = ""
    created_at: str = ""


class GovernanceRunV1(BaseModel):
    run_id: str = ""
    dataset_id: str = ""
    dataset_layer: str = ""
    snapshot_id: str | None = None
    status: str = "COMPLETED"      # RUNNING | COMPLETED | FAILED
    started_at: str = ""
    finished_at: str = ""
    rules_executed: int = 0
    findings_created: int = 0
    findings_reopened: int = 0
    error: str = ""


class ReviewActionV1(BaseModel):
    review_id: str = ""
    finding_id: str = ""
    action: str = ""
    previous_status: str = ""
    new_status: str = ""
    reviewer: str = ""
    reason: str = ""
    created_at: str = ""


class TrustProfileV1(BaseModel):
    dataset_id: str = ""
    snapshot_id: str | None = None
    governance_score: float = 0.0
    status: str = "UNKNOWN"        # TRUSTED | CONDITIONAL | UNTRUSTED | INSUFFICIENT_EVIDENCE
    open_finding_count: int = 0
    highest_severity: str = "INFO"
    dimension_scores: dict[str, float] = Field(default_factory=dict)
    quality_status: str = ""
    quality_reference: str = ""
    lineage_reference: str = ""
    finding_ids: list[str] = Field(default_factory=list)
    generated_at: str = ""
    # rule coverage: a run whose mandatory rules errored must never publish
    # TRUSTED (review fix: rule failure ≠ absence of governance problems)
    rule_count: int = 0
    failed_rule_count: int = 0
