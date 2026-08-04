"""Engine unit tests — deterministic assessment outcomes over a fake port.

Covers the required cases: ALLOW on a safe plan, BLOCK on target/future-time
leakage, REVIEW on sensitive features / target distribution problems, and
INSUFFICIENT_EVIDENCE whenever required information is missing or a rule
cannot be evaluated. No raw rows are ever part of an assessment result.
"""
from __future__ import annotations

import sys
from dataclasses import asdict
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cdxr.contracts import (  # noqa: E402
    C_REQUEST_INVALID,
    C_RULE_ERROR,
    R_CONSTANT_FEATURE,
    R_FEATURE_MISSINGNESS,
    R_LABEL_DERIVED_FEATURE,
    R_POST_OUTCOME_FEATURE,
    R_SAMPLE_SIZE,
    R_SENSITIVE_FEATURE,
    R_TARGET_DISTRIBUTION,
    R_TARGET_IN_FEATURES,
    R_VALIDATION_LEAKAGE,
    AssessmentStatus,
    TrainingAssessmentRequest,
    ValidationStrategy,
)
from cdxr.engine import run_assessment  # noqa: E402
from tests.fake_port import FakeTrainingDatasetPort  # noqa: E402


def safe_request(**overrides) -> TrainingAssessmentRequest:
    base = dict(
        dataset_id="dwd.dwd_loan_events",
        snapshot_id=12345,
        purpose="model_training",
        target_field="default_flag",
        feature_fields=["credit_score", "loan_amount"],
        entity_id_fields=None,
        prediction_time_field="event_date",
        label_time_field=None,
        training_window=None,
        validation_strategy=None,
        sensitive_field_policy="review",
    )
    base.update(overrides)
    return TrainingAssessmentRequest(**base)


class TestSafePlanAllows:
    def test_safe_plan_returns_allow(self):
        res = run_assessment(safe_request(), FakeTrainingDatasetPort())
        assert res.status == AssessmentStatus.ALLOW.value
        assert res.raw_rows_returned is False
        assert res.snapshot_id == 12345
        assert res.rule_version  # traceability: rule version present

    def test_safe_plan_with_disabled_rules_never_allows(self):
        # Feature-gated runs (round3.cdxr_* off) disable rules. ALLOW must be
        # downgraded — unexecuted checks are an evidence gap (spec §14 test 19).
        res = run_assessment(safe_request(), FakeTrainingDatasetPort(),
                             enabled_rules={"traceability"})
        assert res.status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value
        assert "target_in_features" in res.disabled_rules
        assert len(res.checked_rules) == 1
        assert any("ALLOW downgraded" in w for w in res.warnings)

    def test_no_raw_data_in_result_payload(self):
        res = run_assessment(safe_request(), FakeTrainingDatasetPort())
        payload = asdict(res)
        assert res.raw_rows_returned is False
        # no row-array / raw-data keys anywhere in the payload
        assert "rows" not in payload and "values" not in payload
        assert all(isinstance(f["observed"], (str, type(None))) for f in payload["findings"])
        # the raw sensitive field and its cell values never appear in the
        # result (the fake port holds customer_id values c1..c50)
        assert "customer_id" not in str(payload)
        assert "c50" not in str(payload)


class TestTargetLeakage:
    def test_target_in_features_blocks(self):
        res = run_assessment(
            safe_request(feature_fields=["credit_score", "default_flag"]),
            FakeTrainingDatasetPort(),
        )
        assert res.status == AssessmentStatus.BLOCK.value
        assert any(f.code == R_TARGET_IN_FEATURES and f.severity == "CRITICAL"
                   for f in res.findings)


class TestTemporalLeakage:
    def test_future_time_feature_blocks(self):
        port = FakeTrainingDatasetPort()
        port.time_profiles["credit_score"] = port.time_profiles["credit_score"].__class__(
            "credit_score", "2026-07-01", "2026-07-15", temporal=True,
        )
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.BLOCK.value
        assert any(f.code == R_POST_OUTCOME_FEATURE and f.severity == "CRITICAL"
                   for f in res.findings)

    def test_missing_prediction_time_field_is_insufficient(self):
        res = run_assessment(safe_request(prediction_time_field=None), FakeTrainingDatasetPort())
        assert res.status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value
        assert any(f.code == R_POST_OUTCOME_FEATURE for f in res.findings)


class TestSensitiveFeatures:
    def test_sensitive_feature_review_policy(self):
        port = FakeTrainingDatasetPort()
        port.sensitive["credit_score"] = True
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.REVIEW.value
        assert any(f.code == R_SENSITIVE_FEATURE for f in res.findings)

    def test_sensitive_feature_block_policy(self):
        port = FakeTrainingDatasetPort()
        port.sensitive["credit_score"] = True
        res = run_assessment(safe_request(sensitive_field_policy="block"), port)
        assert res.status == AssessmentStatus.BLOCK.value
        assert any(f.code == R_SENSITIVE_FEATURE for f in res.findings)

    def test_sensitive_target_is_checked(self):
        port = FakeTrainingDatasetPort()
        port.sensitive["default_flag"] = True
        res = run_assessment(safe_request(), port)
        assert any(f.code == R_SENSITIVE_FEATURE for f in res.findings)


class TestTargetDistribution:
    def test_high_missing_rate_reviews(self):
        port = FakeTrainingDatasetPort()
        port.distributions["default_flag"] = {"0": 2200, "1": 300}
        port.fields["default_flag"] = ("string", 2500, 2)
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.REVIEW.value
        assert any(f.code == R_TARGET_DISTRIBUTION and f.severity == "HIGH"
                   for f in res.findings)

    def test_single_label_value_reviews(self):
        port = FakeTrainingDatasetPort()
        port.distributions["default_flag"] = {"0": 4995}
        port.fields["default_flag"] = ("string", 5, 1)
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.REVIEW.value
        assert any(f.code == R_TARGET_DISTRIBUTION for f in res.findings)

    def test_unavailable_distribution_is_insufficient(self):
        port = FakeTrainingDatasetPort()
        port.distributions["default_flag"] = None
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value


class TestSampleSize:
    def test_zero_rows_blocks(self):
        port = FakeTrainingDatasetPort()
        port.row_count = 0
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.BLOCK.value
        assert any(f.code == R_SAMPLE_SIZE and f.severity == "CRITICAL"
                   for f in res.findings)

    def test_below_minimum_reviews(self):
        port = FakeTrainingDatasetPort()
        port.row_count = 50
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.REVIEW.value
        assert any(f.code == R_SAMPLE_SIZE and f.severity == "HIGH" for f in res.findings)

    def test_unavailable_statistics_is_insufficient(self):
        port = FakeTrainingDatasetPort()
        port.row_count = None
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value
        assert any(f.code == R_SAMPLE_SIZE for f in res.findings)


class TestFeatureQuality:
    def test_high_missingness_finding(self):
        port = FakeTrainingDatasetPort()
        port.fields["credit_score"] = ("int", 4000, 900)
        res = run_assessment(safe_request(), port)
        assert any(f.code == R_FEATURE_MISSINGNESS for f in res.findings)

    def test_constant_feature_finding(self):
        port = FakeTrainingDatasetPort()
        port.fields["loan_amount"] = ("double", 0, 1)
        res = run_assessment(safe_request(), port)
        assert any(f.code == R_CONSTANT_FEATURE for f in res.findings)


class TestTraceability:
    def test_no_snapshot_is_insufficient(self):
        port = FakeTrainingDatasetPort()
        port.snapshot_id = None
        res = run_assessment(safe_request(snapshot_id=None), port)
        assert res.status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value
        assert any(f.code == "TRACEABILITY" for f in res.findings)


class TestValidationLeakage:
    def test_time_strategy_requires_field_or_cutoff(self):
        res = run_assessment(
            safe_request(validation_strategy=ValidationStrategy(type="time")),
            FakeTrainingDatasetPort(),
        )
        assert res.status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value
        assert any(f.code == C_REQUEST_INVALID for f in res.findings)

    def test_time_split_cutoff_below_min_reviews(self):
        port = FakeTrainingDatasetPort()
        port.time_profiles["event_date"] = port.time_profiles["event_date"].__class__(
            "event_date", "2021-01-01", "2026-06-30", temporal=True,
        )
        res = run_assessment(
            safe_request(validation_strategy=ValidationStrategy(
                type="time", field="event_date", cutoff="2020-01-01")),
            port,
        )
        assert res.status == AssessmentStatus.REVIEW.value
        assert any(f.code == R_VALIDATION_LEAKAGE and f.severity == "HIGH"
                   for f in res.findings)

    def test_group_strategy_constant_group_field_reviews(self):
        port = FakeTrainingDatasetPort()
        port.fields["customer_id"] = ("string", 0, 1)
        res = run_assessment(
            safe_request(feature_fields=["credit_score"], entity_id_fields=["customer_id"],
                         validation_strategy=ValidationStrategy(type="group", field="customer_id")),
            port,
        )
        assert res.status == AssessmentStatus.REVIEW.value
        assert any(f.code == R_VALIDATION_LEAKAGE for f in res.findings)


class TestRequestValidation:
    def test_unknown_feature_field_is_insufficient(self):
        res = run_assessment(safe_request(feature_fields=["credit_score", "nope_missing"]),
                             FakeTrainingDatasetPort())
        assert res.status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value
        assert any(f.code == C_REQUEST_INVALID for f in res.findings)

    def test_empty_feature_fields_is_insufficient(self):
        res = run_assessment(safe_request(feature_fields=[]), FakeTrainingDatasetPort())
        assert res.status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value


class TestRuleFailures:
    def test_port_failure_is_insufficient(self):
        port = FakeTrainingDatasetPort()
        port.raise_on = {"get_profile", "get_value_distribution"}
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.INSUFFICIENT_EVIDENCE.value
        assert any(f.code == C_RULE_ERROR for f in res.findings)

    def test_block_wins_over_insufficient(self):
        port = FakeTrainingDatasetPort()
        port.raise_on = {"get_profile"}
        res = run_assessment(
            safe_request(feature_fields=["credit_score", "default_flag"]), port)
        # definite blocker (target in features) dominates the failed rule
        assert res.status == AssessmentStatus.BLOCK.value
        assert any(f.code == R_TARGET_IN_FEATURES for f in res.findings)
        assert any(f.code == C_RULE_ERROR for f in res.findings)


class TestLabelDerived:
    def test_explicit_label_derived_role_reviews(self):
        port = FakeTrainingDatasetPort()
        port.roles = {"credit_score": {"label_derived"}}
        res = run_assessment(safe_request(), port)
        assert res.status == AssessmentStatus.REVIEW.value
        assert any(f.code == R_LABEL_DERIVED_FEATURE for f in res.findings)

    def test_no_explicit_roles_is_not_a_finding(self):
        res = run_assessment(safe_request(), FakeTrainingDatasetPort())
        assert not any(f.code == R_LABEL_DERIVED_FEATURE for f in res.findings)
