"""Governance Phase 5 tests — CDXR feature promotion gate.

Coverage manifest feature (round2.pipeline_cdxr_promotion_gate) is
exercised here and by experiments/e2e-governance-phase5.mts. CDXR is stubbed
(no real training data in unit tests).
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.cdxr_gate import CdxrPromotionGate  # noqa: E402


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


def _cdxr_stub(training_use: dict) -> dict:
    return {
        "status": "ALLOW" if training_use.get("leakageSafe") else "BLOCK",
        "checkedRules": ["TARGET_IN_FEATURES", "POST_OUTCOME_FEATURE"],
        "disabledRules": [],
        "warnings": [],
    }


def _training_use(**over) -> dict:
    t = {
        "predictionTarget": "default",
        "label": "is_default",
        "featureSet": ["feature_income", "feature_debt_ratio"],
        "observationTime": "event_time",
        "labelWindow": "30d",
        "trainValidationTestSplit": "80/10/10",
        "datasetAndSnapshot": "dws.feature_values@v3",
        "featureAvailabilityTime": "event_time",
        "leakageSafe": True,
    }
    t.update(over)
    return t


def test_candidate_triggers_cdxr_and_review(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3", _training_use())
    assert review["status"] == "PENDING_DECISION"
    assert review["cdxrAssessment"]["status"] == "ALLOW"
    # not consumable yet
    with pytest.raises(ValueError):
        g.require_approved(review["reviewId"])


def test_approve_reaches_ads(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3", _training_use())
    decided = g.decide(review["reviewId"], "APPROVE", os_actor="op@h")
    assert decided["status"] == "APPROVED_FOR_ADS"
    assert g.require_approved(review["reviewId"])["status"] == "APPROVED_FOR_ADS"


def test_blocked_cdxr_cannot_be_approved(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3",
                                    _training_use(leakageSafe=False))
    assert review["cdxrAssessment"]["status"] == "BLOCK"
    decided = g.decide(review["reviewId"], "REJECT", os_actor="op@h")
    assert decided["status"] == "REJECTED"
    with pytest.raises(ValueError):
        g.require_approved(review["reviewId"])


def test_change_request_invalidates_old_approval(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3", _training_use())
    g.decide(review["reviewId"], "APPROVE", os_actor="op@h")
    # a schema change request after approval invalidates it
    changed = g.request_change(review["reviewId"], os_actor="op@h", reason="leakage concern")
    assert changed["status"] == "CHANGES_REQUESTED"
    with pytest.raises(ValueError):
        g.require_approved(review["reviewId"])
    # re-run required: a NEW review id must be created (not the old one)
    assert g.re_run_required(review["reviewId"]) is True


def test_remove_feature_requires_new_cycle(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3", _training_use())
    with pytest.raises(ValueError):
        g.decide(review["reviewId"], "REMOVE_FEATURE", os_actor="op@h")


def test_waiver_allows_with_marker(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3",
                                    _training_use(leakageSafe=False))
    decided = g.decide(review["reviewId"], "ACCEPT_WITH_WAIVER", os_actor="op@h", comment="business override")
    assert decided["status"] == "APPROVED_FOR_ADS"
    assert decided["decision"] == "ACCEPT_WITH_WAIVER"


def test_double_decision_rejected(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3", _training_use())
    g.decide(review["reviewId"], "APPROVE", os_actor="op@h")
    with pytest.raises(ValueError):
        g.decide(review["reviewId"], "APPROVE", os_actor="op@h")
    # v1 remains PENDING (versioned immutability)
    v1 = repo.get("feature-promotion-review", review["reviewId"], 1)
    assert v1.content["status"] == "PENDING_DECISION"


# ---------------------------------------------------------------------------
# review-fix: CDXR gate strictness
# ---------------------------------------------------------------------------

def test_approve_blocked_by_block_status(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3",
                                    _training_use(leakageSafe=False))
    assert review["cdxrAssessment"]["status"] == "BLOCK"
    # plain APPROVE on a BLOCK must fail
    with pytest.raises(ValueError):
        g.decide(review["reviewId"], "APPROVE", os_actor="op@h")


def test_approve_blocked_by_insufficient_evidence(repo):
    def insuff(_tu):
        return {"status": "INSUFFICIENT_EVIDENCE", "checkedRules": [], "disabledRules": [], "warnings": []}
    g = CdxrPromotionGate(repo, cdxr_caller=insuff)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3", _training_use())
    with pytest.raises(ValueError):
        g.decide(review["reviewId"], "APPROVE", os_actor="op@h")


def test_no_caller_blocks_plain_approve(repo):
    g = CdxrPromotionGate(repo)  # no caller injected
    with pytest.raises(ValueError):
        g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3", _training_use())


def test_waiver_requires_comment(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    review = g.on_feature_candidate("pipeline_1", "run_1", "dws.feature_values@v3",
                                    _training_use(leakageSafe=False))
    with pytest.raises(ValueError):
        g.decide(review["reviewId"], "ACCEPT_WITH_WAIVER", os_actor="op@h")  # no comment


def test_dataset_binding_enforced(repo):
    g = CdxrPromotionGate(repo, cdxr_caller=_cdxr_stub)
    # trainingUse names dataset A, argument names dataset B → refused
    with pytest.raises(ValueError):
        g.on_feature_candidate("pipeline_1", "run_1", "dws.dataset_b",
                               _training_use(datasetAndSnapshot="dws.dataset_a"))
