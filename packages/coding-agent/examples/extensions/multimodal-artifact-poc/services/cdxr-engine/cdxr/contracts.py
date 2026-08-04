"""CDXR training-assessment contracts.

Shared vocabulary for the on-demand training-data suitability assessment.
This module (and the whole cdxr-engine core) must stay free of gateway,
catalog, storage and governance imports: the engine only talks to a
TrainingDatasetPort (see cdxr.ports).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

ASSESSMENT_RULE_VERSION = "cdxr-training.v1"


class TrainingPurpose(Enum):
    MODEL_TRAINING = "model_training"


class AssessmentStatus(Enum):
    ALLOW = "ALLOW"
    REVIEW = "REVIEW"
    BLOCK = "BLOCK"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class FindingSeverity(Enum):
    INFO = "INFO"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class SensitiveFieldPolicy(Enum):
    BLOCK = "block"
    REVIEW = "review"
    ALLOW = "allow"


class ValidationStrategyType(Enum):
    RANDOM = "random"
    TIME = "time"
    GROUP = "group"


# -- rule codes ---------------------------------------------------------

R_TARGET_IN_FEATURES = "TARGET_IN_FEATURES"
R_POST_OUTCOME_FEATURE = "POST_OUTCOME_FEATURE"
R_LABEL_DERIVED_FEATURE = "LABEL_DERIVED_FEATURE"
R_SENSITIVE_FEATURE = "SENSITIVE_FEATURE"
R_TARGET_DISTRIBUTION = "TARGET_DISTRIBUTION"
R_SAMPLE_SIZE = "SAMPLE_SIZE"
R_FEATURE_MISSINGNESS = "FEATURE_MISSINGNESS"
R_CONSTANT_FEATURE = "CONSTANT_FEATURE"
R_VALIDATION_LEAKAGE = "VALIDATION_LEAKAGE"
R_TRACEABILITY = "TRACEABILITY"

# Engine-level codes: request problems and evidence gaps. Findings carrying
# these (or evidence_gap=True) force INSUFFICIENT_EVIDENCE, never ALLOW.
C_REQUEST_INVALID = "REQUEST_INVALID"
C_INFO_MISSING = "INFO_MISSING"
C_RULE_ERROR = "RULE_ERROR"


# -- request / result ---------------------------------------------------

@dataclass(frozen=True)
class TrainingWindow:
    start: str
    end: str


@dataclass(frozen=True)
class ValidationStrategy:
    type: str                       # random | time | group
    field: Optional[str] = None     # time: split field; group: entity field
    cutoff: Optional[str] = None    # time: split boundary (ISO)


@dataclass(frozen=True)
class TrainingAssessmentRequest:
    dataset_id: str
    target_field: str
    feature_fields: list[str]
    snapshot_id: Optional[int] = None
    purpose: str = TrainingPurpose.MODEL_TRAINING.value
    entity_id_fields: Optional[list[str]] = None
    prediction_time_field: Optional[str] = None
    label_time_field: Optional[str] = None
    training_window: Optional[TrainingWindow] = None
    validation_strategy: Optional[ValidationStrategy] = None
    sensitive_field_policy: str = SensitiveFieldPolicy.REVIEW.value


@dataclass(frozen=True)
class TrainingAssessmentFinding:
    code: str
    severity: str
    message: str
    field: Optional[str] = None
    related_fields: Optional[list[str]] = None
    observed: Optional[str] = None
    expected: Optional[str] = None
    evidence_reference: Optional[str] = None
    recommendation: Optional[str] = None
    # True when the rule could not be evaluated because required information
    # was missing or failed to load — such findings force INSUFFICIENT_EVIDENCE.
    evidence_gap: bool = False


@dataclass(frozen=True)
class TrainingAssessmentResult:
    assessment_id: str
    dataset_id: str
    snapshot_id: Optional[int]
    purpose: str
    status: str
    summary: str
    findings: list[TrainingAssessmentFinding] = field(default_factory=list)
    checked_fields: list[str] = field(default_factory=list)
    rule_version: str = ASSESSMENT_RULE_VERSION
    checked_at: str = ""
    raw_rows_returned: bool = False
    warnings: list[str] = field(default_factory=list)
    # Feature-driven rule gating (see cdxr.engine.RULE_FEATURE_MAP): rules
    # that ran vs rules that were explicitly disabled. Disabled rules are
    # NEVER reported as passed.
    checked_rules: list[str] = field(default_factory=list)
    disabled_rules: list[str] = field(default_factory=list)


# -- status aggregation (deterministic) ---------------------------------

INSUFFICIENT_CODES = frozenset({C_REQUEST_INVALID, C_INFO_MISSING, C_RULE_ERROR})


def aggregate_status(findings: list[TrainingAssessmentFinding]) -> AssessmentStatus:
    """Deterministic status from findings.

    Precedence (safety-first):
      1. any CRITICAL finding        -> BLOCK
      2. any evidence gap            -> INSUFFICIENT_EVIDENCE
      3. any HIGH finding            -> REVIEW
      4. otherwise                   -> ALLOW
    A definite blocker dominates evidence gaps (never downgrade a known
    leak because another check failed); gaps dominate HIGH concerns because
    they mean we cannot trust even the reviewed conclusion.
    """
    has_gap = any(f.evidence_gap or f.code in INSUFFICIENT_CODES for f in findings)
    for f in findings:
        if f.severity == FindingSeverity.CRITICAL.value:
            return AssessmentStatus.BLOCK
    if has_gap:
        return AssessmentStatus.INSUFFICIENT_EVIDENCE
    if any(f.severity == FindingSeverity.HIGH.value for f in findings):
        return AssessmentStatus.REVIEW
    return AssessmentStatus.ALLOW


def new_assessment_id(dataset_id: str, snapshot_id: Optional[int], purpose: str,
                      target_field: str, feature_fields: list[str],
                      checked_at: str) -> str:
    """Short, collision-resistant assessment id."""
    seed = "|".join([
        dataset_id, str(snapshot_id or ""), purpose, target_field,
        ",".join(sorted(feature_fields)), checked_at,
    ])
    return f"ast_{hashlib.sha1(seed.encode()).hexdigest()[:16]}"
