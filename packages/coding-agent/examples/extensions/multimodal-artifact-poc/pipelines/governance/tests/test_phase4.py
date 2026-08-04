"""Governance Phase 4 tests — placement planning and approval.

Coverage manifest feature (round2.pipeline_placement_governance) is
exercised here and by experiments/e2e-governance-phase4.mts.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.placement import (  # noqa: E402
    CONTROLLED_TARGETS,
    PlacementGovernance,
)


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


def _plan(**over) -> dict:
    p = {
        "placementPlanId": "pp_test_001",
        "version": 1,
        "sourceDataset": "source.events",
        "targetLayer": "DWD",
        "targetDataset": "dwd.loan_application_detail",
        "rationale": "clean loan detail for downstream analysis",
        "grainDetail": "per loan application",
        "derivation": "RAW",
        "targetSchemaRef": "schema-spec:schema_001@1",
        "primaryKey": ["application_id"],
        "partitioning": ["event_time"],
        "writeMode": "INCREMENTAL",
        "schemaEvolutionPolicy": "ADDITIVE",
        "retentionPolicy": "90d",
        "backfillRequired": False,
        "affectedDownstream": ["dws.feature_values"],
        "qualityGateRefs": [],
        "assumptions": [],
        "risks": [],
        "status": "DRAFT",
    }
    p.update(over)
    return p


def test_dwd_valid(repo):
    g = PlacementGovernance(repo)
    assert g.validate_plan(_plan()) == []


def test_ods_rejects_derived_metrics(repo):
    g = PlacementGovernance(repo)
    # structured derivation declaration replaces rationale string matching
    plan = _plan(targetLayer="ODS", targetDataset="ods.streaming_events",
                 rationale="final metric", primaryKey=[], derivation="DERIVED")
    errors = g.validate_plan(plan)
    assert any("ODS must be RAW" in e for e in errors)
    # legacy rationale-string bypass attempt no longer works either
    plan2 = _plan(targetLayer="ODS", targetDataset="ods.streaming_events",
                  rationale="final metric", primaryKey=[])
    errors2 = g.validate_plan(plan2)
    assert not any("ODS must be RAW" in e for e in errors2) or plan2.get("derivation") != "RAW"


def test_layer_namespace_mismatch_rejected(repo):
    g = PlacementGovernance(repo)
    # ADS declared but targeting a DWS dataset → refused regardless of rationale
    plan = _plan(targetLayer="ADS", targetDataset="dws.feature_values",
                 rationale="a very explicit consumption purpose for reports")
    errors = g.validate_plan(plan)
    assert any("layer/namespace mismatch" in e for e in errors)
    # DWS declared but targeting ads.* → refused
    plan2 = _plan(targetLayer="DWS", targetDataset="ads.model_metrics")
    errors2 = g.validate_plan(plan2)
    assert any("layer/namespace mismatch" in e for e in errors2)


def test_dwd_requires_structured_grain(repo):
    g = PlacementGovernance(repo)
    # missing grainDetail → refused (primary key alone is not enough)
    plan = _plan(grainDetail="")
    errors = g.validate_plan(plan)
    assert any("grainDetail" in e for e in errors)
    # aggregate grain declared on a DWD plan → refused (belongs in DWS)
    plan2 = _plan(grainDetail="daily total per region")
    errors2 = g.validate_plan(plan2)
    assert any("aggregation/summary grains belong in DWS" in e for e in errors2)
    # detail grain passes
    assert g.validate_plan(_plan()) == []


def test_ads_requires_purpose(repo):
    g = PlacementGovernance(repo)
    plan = _plan(targetLayer="ADS", targetDataset="ads.model_metrics", rationale="short")
    errors = g.validate_plan(plan)
    assert any("ADS requires an explicit consumption purpose" in e for e in errors)


def test_feature_store_requires_entity_and_time(repo):
    g = PlacementGovernance(repo)
    plan = _plan(targetLayer="FEATURE_STORE", targetDataset="dws.feature_values",
                 partitioning=["region"], primaryKey=[])
    errors = g.validate_plan(plan)
    assert any("FEATURE_STORE requires an entity key" in e for e in errors)
    assert any("FEATURE_STORE requires event-time partitioning" in e for e in errors)


def test_merge_without_key_rejected(repo):
    g = PlacementGovernance(repo)
    plan = _plan(writeMode="MERGE", primaryKey=[])
    errors = g.validate_plan(plan)
    assert any("MERGE requires a primary key" in e for e in errors)


def test_uncontrolled_target_rejected(repo):
    g = PlacementGovernance(repo)
    plan = _plan(targetDataset="some.arbitrary.table")
    errors = g.validate_plan(plan)
    assert any("not a controlled harness target" in e for e in errors)


def test_approval_gate(repo):
    g = PlacementGovernance(repo)
    plan = g.propose(_plan())
    assert plan["status"] == "DRAFT"
    with pytest.raises(ValueError):
        g.require_approved(plan["placementPlanId"])
    approved = g.approve(plan["placementPlanId"], os_actor="op@h")
    assert approved["status"] == "APPROVED"
    assert g.require_approved(plan["placementPlanId"])["status"] == "APPROVED"
    # double decision rejected (versioned: v1 stays DRAFT)
    with pytest.raises(ValueError):
        g.approve(plan["placementPlanId"], os_actor="op@h")
    v1 = repo.get("placement-plan", plan["placementPlanId"], 1)
    assert v1.content["status"] == "DRAFT"


def test_reject_terminal(repo):
    g = PlacementGovernance(repo)
    plan = g.propose(_plan())
    g.reject(plan["placementPlanId"], os_actor="op@h")
    with pytest.raises(ValueError):
        g.require_approved(plan["placementPlanId"])


def test_controlled_targets_are_harness_only():
    assert "some.arbitrary.table" not in CONTROLLED_TARGETS
    assert "dwd.loan_application_detail" in CONTROLLED_TARGETS
