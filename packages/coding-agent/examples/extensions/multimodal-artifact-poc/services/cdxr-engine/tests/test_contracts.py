"""Contract-level unit tests — deterministic status aggregation and finding
shapes. The engine core has no gateway / catalog / governance dependencies."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cdxr.contracts import (  # noqa: E402
    C_INFO_MISSING,
    C_REQUEST_INVALID,
    C_RULE_ERROR,
    AssessmentStatus,
    FindingSeverity,
    TrainingAssessmentFinding,
    aggregate_status,
)


def finding(code: str, severity: str) -> TrainingAssessmentFinding:
    return TrainingAssessmentFinding(code=code, severity=severity, message="m")


class TestStatusAggregation:
    def test_no_findings_allows(self):
        assert aggregate_status([]) == AssessmentStatus.ALLOW

    def test_critical_blocks(self):
        assert aggregate_status([
            finding("SOME_RULE", FindingSeverity.HIGH.value),
            finding("TARGET_IN_FEATURES", FindingSeverity.CRITICAL.value),
        ]) == AssessmentStatus.BLOCK

    def test_block_wins_over_insufficient(self):
        assert aggregate_status([
            finding(C_RULE_ERROR, FindingSeverity.HIGH.value),
            finding("TARGET_IN_FEATURES", FindingSeverity.CRITICAL.value),
        ]) == AssessmentStatus.BLOCK

    def test_high_reviews(self):
        assert aggregate_status([
            finding("SENSITIVE_FEATURE", FindingSeverity.HIGH.value),
        ]) == AssessmentStatus.REVIEW

    def test_insufficient_wins_over_review(self):
        # evidence gaps mean we cannot trust even the reviewed concerns
        assert aggregate_status([
            finding("SENSITIVE_FEATURE", FindingSeverity.HIGH.value),
            finding(C_INFO_MISSING, FindingSeverity.HIGH.value),
        ]) == AssessmentStatus.INSUFFICIENT_EVIDENCE

    @pytest.mark.parametrize("code", [C_INFO_MISSING, C_RULE_ERROR, C_REQUEST_INVALID])
    def test_evidence_gap_codes_are_insufficient(self, code):
        assert aggregate_status([finding(code, FindingSeverity.HIGH.value)]) \
            == AssessmentStatus.INSUFFICIENT_EVIDENCE

    def test_medium_findings_do_not_change_status(self):
        assert aggregate_status([
            finding("CONSTANT_FEATURE", FindingSeverity.MEDIUM.value),
        ]) == AssessmentStatus.ALLOW
