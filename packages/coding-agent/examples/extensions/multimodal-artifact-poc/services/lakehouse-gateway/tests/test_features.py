"""Feature Flag & Ablation Framework — gateway tests (spec §14 parity + rule
gating).

  - Python resolver parity with TS (same default policy + hash)
  - legacy env aliases honored centrally
  - feature-driven rule gating through the API: round3.cdxr_training OFF →
    rules land in disabledRules, are never reported PASS, and a target-leak
    dataset must NOT get ALLOW; round3.cdxr_training ON → target_in_features
    blocks (covered in test_cdxr_training.py)
  - unsafe ablations: production refusal, EVALUATION_MODE gating
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features import (  # noqa: E402
    BUILD_FEATURE_MANIFEST,
    FeatureResolver,
    _set_default_resolver,
    feature_hash,
    load_registry,
    resolve_runtime_settings,
)

from tests.test_cdxr_training import module_client  # noqa: E402,F401

REGISTRY = load_registry()
DEFAULT_EFF_HASH = "1900a97a922ed9de"  # must match TS (tests/features.test.mts)


def _resolver(env: dict[str, str]) -> FeatureResolver:
    runtime = resolve_runtime_settings(REGISTRY, env)
    return FeatureResolver(registry=REGISTRY, build_manifest=BUILD_FEATURE_MANIFEST,
                           runtime=runtime, env=env)


def _patch_resolver(env: dict[str, str]) -> dict[str, str]:
    _set_default_resolver(_resolver(env))
    return env


class TestResolverParity:
    def test_default_policy_matches_ts(self):
        f = _resolver({})
        for fid in ("round1.multimodal", "round1.quality_gate",
                    "round2.lakehouse", "round2.pipeline",
                    "round3.cdxr_training",
                    "round4.requirement_planning", "round4.data_analysis",
                    "legacy.cdxr_governance_cli"):
            assert f.is_effective(fid), f"{fid} must be ON by default"
        assert f.get_effective_feature_snapshot().effectiveFeatureHash == DEFAULT_EFF_HASH

    def test_hash_deterministic_and_feature_keyed(self):
        a = _resolver({"ENABLE_LAKEHOUSE": "true"})
        b = _resolver({"ENABLE_LAKEHOUSE": "true"})
        c = _resolver({"ENABLE_LAKEHOUSE": "false"})
        assert a.get_effective_feature_snapshot().effectiveFeatureHash == \
            b.get_effective_feature_snapshot().effectiveFeatureHash
        assert a.get_effective_feature_snapshot().effectiveFeatureHash != \
            c.get_effective_feature_snapshot().effectiveFeatureHash

    def test_legacy_alias_enable_cdxr_training_tool(self):
        # alias maps to round3.cdxr_training; depends on round2.lakehouse
        f = _resolver({"ENABLE_LAKEHOUSE": "true", "ENABLE_CDXR_TRAINING_TOOL": "true"})
        assert f.is_effective("round3.cdxr_training")
        assert f.is_effective("round3.cdxr_target_leakage")
        # without the lakehouse dependency it must NOT be effective
        g = _resolver({"ENABLE_CDXR_TRAINING_TOOL": "true", "ENABLE_LAKEHOUSE": "false"})
        assert not g.is_effective("round3.cdxr_training")

    def test_legacy_alias_enable_legacy_governance(self):
        f = _resolver({"ENABLE_LEGACY_CDXR_GOVERNANCE": "true"})
        assert f.is_effective("legacy.cdxr_governance_cli")
        assert f.is_effective("legacy.cdxr_governance_tools")

    def test_runtime_cannot_enable_unbuilt_feature(self):
        f = _resolver({"ABLATE_QUERY_VALIDATION": "true", "EVALUATION_MODE": "true"})
        assert not f.is_effective("ablate.query_validation")
        assert f.states["ablate.query_validation"].disabledReason == "NOT_BUILT"

    def test_unsafe_in_production_refused(self):
        with pytest.raises(RuntimeError, match="refusing to start"):
            _resolver({"APP_ENV": "production", "EVALUATION_MODE": "true",
                       "ABLATE_QUERY_VALIDATION": "true"})

    def test_hash_format_matches_ts(self):
        # TS: sha256 of canonical JSON, first 16 hex chars — verify shape here
        h = _resolver({}).get_effective_feature_snapshot().effectiveFeatureHash
        assert len(h) == 16
        assert all(ch in "0123456789abcdef" for ch in h)


class TestRuleGating:
    """Feature-driven rule gating through the API (round3.cdxr_* → rule ids)."""

    def test_rules_disabled_when_round3_off(self, module_client):
        client, _wh = module_client
        _patch_resolver({"ENABLE_CDXR_TRAINING": "false"})
        try:
            # round3.cdxr_training off → the whole CDXR API is feature-gated
            # and answers 404 FEATURE_DISABLED (never executes).
            r = client.post("/v1/cdxr/training-assessments", json={
                "datasetId": "dws.dws_sales_daily",
                "targetField": "orders",
                "featureFields": ["revenue", "region"],
                "predictionTimeField": "event_date",
            })
            assert r.status_code == 404
            assert r.json()["detail"].startswith("FEATURE_DISABLED")
        finally:
            _set_default_resolver(None)

    def test_target_leak_without_rule_never_allows(self, module_client):
        client, _wh = module_client
        # round3 on, but the target-leakage RULE feature off → rule disabled,
        # API still executes, and the verdict must never be ALLOW.
        _patch_resolver({
            "ENABLE_LAKEHOUSE": "true",
            "ENABLE_CDXR_TRAINING": "true",
            "ENABLE_CDXR_TARGET_LEAKAGE": "false",
        })
        try:
            # target field also listed as a feature → would be BLOCK via
            # target_in_features if the rule ran. With the rule disabled the
            # remaining evidence must NOT produce ALLOW.
            r = client.post("/v1/cdxr/training-assessments", json={
                "datasetId": "dws.dws_sales_daily",
                "targetField": "orders",
                "featureFields": ["revenue", "region", "orders"],
                "predictionTimeField": "event_date",
            })
            assert r.status_code == 200
            body = r.json()
            assert "target_in_features" in body["disabledRules"]
            assert body["status"] != "ALLOW", \
                "ALLOW must never be issued while evidence-gap rules are disabled"
        finally:
            _set_default_resolver(None)

    def test_rules_checked_when_round3_on(self, module_client):
        client, _wh = module_client
        _patch_resolver({"ENABLE_LAKEHOUSE": "true", "ENABLE_CDXR_TRAINING": "true"})
        try:
            r = client.post("/v1/cdxr/training-assessments", json={
                "datasetId": "dws.dws_sales_daily",
                "targetField": "orders",
                "featureFields": ["revenue", "region"],
                "predictionTimeField": "event_date",
            })
            assert r.status_code == 200
            body = r.json()
            assert body["disabledRules"] == []
            assert "target_in_features" in body["checkedRules"]
            assert "traceability" in body["checkedRules"]
        finally:
            _set_default_resolver(None)


class TestDisabledApis:
    """Disabled APIs return 404 FEATURE_DISABLED without executing (spec §6)."""

    def test_round2_apis_disabled_when_lakehouse_off(self, module_client):
        client, _wh = module_client
        _patch_resolver({"ENABLE_LAKEHOUSE": "false"})
        try:
            r = client.get("/v1/catalog/search?query=sales")
            assert r.status_code == 404
            assert r.json()["detail"].startswith("FEATURE_DISABLED")
            r = client.post("/v1/query/validate", json={
                "datasetId": "dws.dws_sales_daily",
                "fields": ["revenue"],
                "filters": [],
            })
            assert r.status_code == 404
            assert r.json()["detail"].startswith("FEATURE_DISABLED")
        finally:
            _set_default_resolver(None)

    def test_round2_apis_enabled_when_lakehouse_on(self, module_client):
        client, _wh = module_client
        _patch_resolver({"ENABLE_LAKEHOUSE": "true"})
        try:
            r = client.get("/v1/catalog/search?query=sales")
            assert r.status_code == 200
        finally:
            _set_default_resolver(None)
