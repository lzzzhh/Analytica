"""CDXR governance tests (spec §13 Python areas).

Covers: engine verbatim behaviour, rule registry, finding creation, evidence
association, snapshot binding, quality/lineage references, confidence,
severity, duplicate dedup, finding lifecycle, review action, trust profile
aggregation, domain rule isolation, EMPTY_DATASET, ODS raw evidence not
exposed via agent-facing reads, and the CLI entry point.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pyarrow as pa
import pytest
from pyiceberg.schema import Schema
from pyiceberg.types import NestedField, StringType

from app.governance.cdxr.aggregate import (
    build_trust_profile,
    compute_governance_score,
    severity_weight,
)
from app.governance.cdxr.contracts import FindingStatus, GovernanceFindingV1, ReviewActionV1
from app.governance.cdxr.engine import (
    assess_detectability,
    assess_validity,
    evaluate_feature,
)
from app.governance.cdxr.runner import run_governance
from app.governance.cdxr.rules import (
    Vocabulary,
    build_default_policies,
    build_default_registry,
)
from app.governance.cdxr.store import GOVERNANCE_TABLES, ensure_governance_tables
from app.governance.reader import GovernanceReader as ReadOnlyGovernanceReader


# ---------------------------------------------------------------------
# 1. CDXR engine — verbatim migration behaviour (original TestCDXREngine)
# ---------------------------------------------------------------------

def _role(**kw) -> dict:
    base = {"business_stage": "pre_prediction", "semantic_role": "feature",
            "time_role": "static", "feature_eligibility": "ALLOW", "confidence": 1.0,
            "table_id": "ods.test"}
    base.update(kw)
    return base


class TestCDXREngine:
    def test_outcome_blocked(self):
        """label/post_outcome features are BLOCKED (original behaviour)."""
        for stage in ("post_outcome", "label_derived"):
            a = evaluate_feature("f_label", _role(business_stage=stage), {})
            assert a.decision == "BLOCK"
            assert a.validity["available_at_prediction_time"] is False
            assert a.repair["strategy"] == "DROP_FEATURE"
            assert a.confidence == 0.95  # reason codes present

    def test_normal_allowed(self):
        a = evaluate_feature("f_income", _role(), {})
        assert a.decision == "ALLOW"
        assert a.confidence == 0.7  # no reason codes
        assert a.repair["strategy"] == "NONE"

    def test_low_confidence_review(self):
        a = evaluate_feature("f_x", _role(confidence=0.5), {})
        assert a.decision == "NEEDS_REVIEW"

    def test_validity_reason_codes(self):
        v = assess_validity("f", _role(business_stage="post_outcome",
                                       time_role="outcome_time_dependent",
                                       feature_eligibility="BLOCK"), {})
        assert v["status"] == "FAIL"
        assert set(v["reason_codes"]) == {"POST_OUTCOME_SOURCE", "FUTURE_TIMESTAMP",
                                          "SOURCE_STAGE_MISMATCH"}

    def test_detectability_signals_and_threshold(self):
        # domain-neutral name pattern triggers signals
        d = assess_detectability("final_label", _role(semantic_role="outcome"), {})
        assert d["score"] > 0.5  # > 0.5 → NEEDS_REVIEW
        # injected vocabulary adds risk_indicator signal (original hardcoded list)
        d2 = assess_detectability("c_overdue", _role(), {},
                                  risk_indicators=("default", "delinquent", "overdue", "bad"))
        assert "risk_indicator" in d2["signals"]
        assert d2["score"] == pytest.approx(0.3)
        # without injection the generic kernel sees nothing
        d3 = assess_detectability("c_overdue", _role(), {}, risk_indicators=())
        assert d3["signals"] == []

    def test_reason_codes_table(self):
        from app.governance.cdxr.engine import REASON_CODES
        assert len(REASON_CODES) == 12
        assert REASON_CODES["POST_OUTCOME_SOURCE"]["default_action"] == "BLOCK"
        assert REASON_CODES["OCR_LOW_CONFIDENCE"]["severity"] == "MEDIUM"


# ---------------------------------------------------------------------
# 2. Rule registry / policy registry
# ---------------------------------------------------------------------

class TestRuleRegistry:
    def test_default_rules_registered(self):
        reg = build_default_registry()
        assert set(reg.list()) == {
            "empty_dataset_check", "freshness_check", "sensitive_field_check",
            "domain_field_check", "quality_reference_check", "lineage_reference_check",
            "schema_confidence_check", "leakage_check", "ocr_confidence_check",
        }

    def test_policies(self):
        pol = build_default_policies()
        std = pol.get("standard")
        assert "freshness_check" in std["rules"]
        assert std["params"]["staleness_seconds"] == 172800
        assert "lineage_reference_check" in pol.get("with_lineage")["rules"]

    def test_custom_rule_registration(self):
        reg = build_default_registry()
        reg.register(type("RS", (), {"rule_id": "custom_check", "dimension": "x",
                                     "description": "d", "default_severity": "LOW",
                                     "fn": lambda ctx: []})())
        assert "custom_check" in reg.list()


# ---------------------------------------------------------------------
# 3-8. Runner: finding creation / evidence / snapshot / references / confidence
# ---------------------------------------------------------------------

class TestGovernanceRun:
    def test_finding_creation_and_evidence(self, warehouse):
        catalog = ensure_catalog(warehouse)
        res = run_governance(catalog, "ads.ads_sales_daily", "latest",
                             vocabulary=_vocab(), time_column="event_date",
                             now="2026-08-01T00:00:00Z", lineage_upstream=["dws.dws_sales_daily"])
        assert len(res.findings) >= 2  # sensitive + domain (+ freshness)
        f = next(f for f in res.findings if f.rule_id == "sensitive_field_check")
        assert f.dataset_id == "ads.ads_sales_daily"
        assert f.status == FindingStatus.OPEN.value
        assert f.severity.value == "HIGH"
        assert f.confidence == 0.95
        # evidence association
        assert f.evidence_refs and f.evidence_refs[0].startswith("evidence:")
        assert any(e.finding_id == f.finding_id and e.source_type == "profile"
                   for e in res.evidence)
        # snapshot binding
        snap = catalog.load_table("ads.ads_sales_daily").current_snapshot()
        assert f.snapshot_id == str(snap.snapshot_id)
        assert f.data_version == str(snap.snapshot_id)
        # quality + lineage references
        assert f.quality_reference == f"quality://ads.ads_sales_daily?snapshot={snap.snapshot_id}"
        assert f.lineage_reference == "lineage://ads.ads_sales_daily"
        assert res.profile["quality_status"] == "PASS"

    def test_freshness_severity_and_score(self, warehouse):
        catalog = ensure_catalog(warehouse)
        res = run_governance(catalog, "ads.ads_sales_daily", "latest",
                             vocabulary=Vocabulary(), time_column="event_date",
                             now="2026-08-01T00:00:00Z")
        f = next(f for f in res.findings if f.rule_id == "freshness_check")
        assert f.severity.value == "HIGH" and f.risk_type == "NO_FRESH_DATA"
        assert res.profile["governance_score"] == pytest.approx(75.0)
        assert res.profile["status"] == "CONDITIONAL"

    def test_empty_dataset_finding(self, warehouse):
        catalog = ensure_catalog(warehouse)
        catalog.create_table("dws.dws_empty_events",
                             Schema(NestedField(1, "event_id", StringType(), required=False)))
        res = run_governance(catalog, "dws.dws_empty_events", "latest",
                             vocabulary=Vocabulary(), now="2026-08-01T00:00:00Z")
        assert any(f.risk_type == "EMPTY_DATASET" and f.severity.value == "CRITICAL"
                   for f in res.findings)
        # EMPTY_DATASET (40) + quality FAIL reference (25) — empty scan ⇒ FAIL
        assert res.profile["governance_score"] == 35.0
        assert res.profile["status"] == "UNTRUSTED"

    def test_quality_reference_finding(self, warehouse):
        catalog = ensure_catalog(warehouse)
        # table with a 100%-missing column → quality FAIL → reference finding
        catalog.create_table("dws.dws_bad_quality",
                             Schema(NestedField(1, "a", StringType(), required=False)))
        tbl = catalog.load_table("dws.dws_bad_quality")
        tbl.append(pa.table({"a": pa.array([None, None, None], type=pa.string())}))
        res = run_governance(catalog, "dws.dws_bad_quality", "latest",
                             vocabulary=Vocabulary(), now="2026-08-01T00:00:00Z")
        assert res.profile["quality_status"] == "FAIL"
        assert any(f.rule_id == "quality_reference_check" and f.severity.value == "HIGH"
                   and f.quality_reference for f in res.findings)

    def test_duplicate_finding_dedup(self, warehouse):
        """Same rule+dataset+field across runs → reader surfaces the latest only."""
        catalog = ensure_catalog(warehouse)
        run_governance(catalog, "ads.ads_sales_daily", "latest",
                       vocabulary=_vocab(), time_column="event_date",
                       now="2026-08-01T00:00:00Z")
        run_governance(catalog, "ads.ads_sales_daily", "latest",
                       vocabulary=_vocab(), time_column="event_date",
                       now="2026-08-01T00:00:00Z")
        reader = ReadOnlyGovernanceReader(catalog)
        findings = reader.list_findings(dataset_id="ads.ads_sales_daily")
        keys = {(f["ruleId"], f["datasetId"], f["fieldName"]) for f in findings}
        assert len(keys) == len(findings)  # deduped to one per key
        # history is preserved in the table (append-only)
        rows = catalog.load_table("governance_dwd.cdxr_finding").scan().to_arrow().num_rows
        assert rows >= len(findings) * 2


# ---------------------------------------------------------------------
# 9-11. Lifecycle / review action / trust profile
# ---------------------------------------------------------------------

class TestLifecycleAndAggregation:
    def test_finding_lifecycle(self):
        f = GovernanceFindingV1(finding_id="fnd_1", run_id="run_1", dataset_id="d",
                                rule_id="r", severity="MEDIUM", status=FindingStatus.OPEN.value,
                                first_detected_at="2026-08-01T00:00:00Z")
        assert f.status == "OPEN"
        f.status = FindingStatus.UNDER_REVIEW.value
        assert f.status == "UNDER_REVIEW"
        f.status = FindingStatus.RESOLVED.value
        assert f.status == "RESOLVED"

    def test_review_action_contract(self):
        a = ReviewActionV1(review_id="rev_1", finding_id="fnd_1", action="RESOLVE",
                           previous_status="OPEN", new_status="RESOLVED",
                           reviewer="human", reason="verified", created_at="2026-08-01T00:00:00Z")
        assert a.action == "RESOLVE" and a.new_status == "RESOLVED"
        # write path is NOT exposed through the gateway (spec §9: first version)
        from app.api.governance_routes import router
        for route in router.routes:
            methods = route.methods or set()
            assert not (methods & {"POST", "PUT", "DELETE", "PATCH"}), route.path

    def test_trust_profile_aggregation(self):
        findings = [
            GovernanceFindingV1(finding_id="f1", run_id="r", dataset_id="d", rule_id="freshness_check",
                                severity="HIGH", status="OPEN", first_detected_at="x"),
            GovernanceFindingV1(finding_id="f2", run_id="r", dataset_id="d", rule_id="domain_field_check",
                                severity="MEDIUM", status="OPEN", first_detected_at="x"),
            GovernanceFindingV1(finding_id="f3", run_id="r", dataset_id="d", rule_id="sensitive_field_check",
                                severity="HIGH", status="RESOLVED", first_detected_at="x"),
        ]
        profile = build_trust_profile("d", "snap1", findings, "PASS",
                                      "quality://d", "lineage://d",
                                      {"freshness_check": "freshness",
                                       "domain_field_check": "domain",
                                       "sensitive_field_check": "sensitive"},
                                      "2026-08-01T00:00:00Z")
        assert profile.governance_score == 100 - 25 - 10  # resolved finding not penalized
        assert profile.status == "UNTRUSTED"  # 65 < 70 → untrusted
        assert profile.open_finding_count == 2
        assert profile.highest_severity == "HIGH"
        assert profile.dimension_scores == {"freshness": 75.0, "domain": 90.0}
        assert profile.finding_ids == ["f1", "f2", "f3"]
        score, status = compute_governance_score([])
        assert score == 100.0 and status == "TRUSTED"

    def test_severity_weights(self):
        assert severity_weight("CRITICAL") == 40
        assert severity_weight("HIGH") == 25
        assert severity_weight("MEDIUM") == 10
        assert severity_weight("LOW") == 5


# ---------------------------------------------------------------------
# 12-14. Domain isolation / governance table layout / ODS evidence guard
# ---------------------------------------------------------------------

BANNED = ("loan", "borrower", "credit_score", "overdue", "bad_rate", "vintage", "auc", "ks", "psi")


class TestDomainIsolation:
    def test_generic_platform_has_no_banned_terms(self):
        """Review: the isolation scan now covers the WHOLE generic platform
        (app/), not just the governance kernel. The only whitelist is the
        domain-labeling fallback vocabulary in dataset_registry.py (metadata
        labeling; the authoritative vocabulary lives in domains/risk)."""
        root = Path(__file__).resolve().parents[1] / "app"
        import re
        words = re.compile(r"\b(" + "|".join(BANNED) + r")\b", re.IGNORECASE)
        offenders = []
        for path in root.rglob("*.py"):
            if path.name == "dataset_registry.py":
                continue  # domain-labeling fallback vocabulary (documented)
            text = path.read_text(encoding="utf-8")
            for m in words.finditer(text):
                offenders.append(f"{path.relative_to(root)}:{m.group(0)}")
        assert offenders == [], f"banned terms leaked into generic platform: {offenders}"

    def test_risk_vocabulary_lives_in_domains(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # repo root (domains/)
        from domains.risk.governance.cdxr.vocabulary import RISK_VOCABULARY
        assert "overdue" in RISK_VOCABULARY.risk_indicators
        assert "auc" in RISK_VOCABULARY.domain_fields
        assert "id_number" in RISK_VOCABULARY.sensitive_fields

    def test_domain_rule_isolation(self, warehouse):
        """Domain vocabulary changes findings; empty vocabulary finds nothing."""
        catalog = ensure_catalog(warehouse)
        res_plain = run_governance(catalog, "ads.ads_sales_daily", "latest",
                                   vocabulary=Vocabulary(), time_column="event_date",
                                   now="2026-08-01T00:00:00Z")
        assert not any(f.rule_id in ("sensitive_field_check", "domain_field_check")
                       for f in res_plain.findings)
        res_risk = run_governance(catalog, "ads.ads_sales_daily", "latest",
                                  vocabulary=_vocab(), time_column="event_date",
                                  now="2026-08-01T00:00:00Z")
        assert any(f.rule_id == "sensitive_field_check" for f in res_risk.findings)

    def test_governance_table_layout(self):
        assert len(GOVERNANCE_TABLES) == 17
        namespaces = {t.split(".")[0] for t in GOVERNANCE_TABLES}
        assert namespaces == {"governance_meta", "governance_ods", "governance_dwd",
                              "governance_dws", "governance_ads"}

    def test_ods_raw_evidence_not_exposed_via_agent_reads(self, warehouse):
        """governance_ods raw payloads are never read by the gateway's reader."""
        catalog = ensure_catalog(warehouse)
        run_governance(catalog, "ads.ads_sales_daily", "latest",
                       vocabulary=_vocab(), time_column="event_date",
                       now="2026-08-01T00:00:00Z")
        reader = ReadOnlyGovernanceReader(catalog)
        # agent-facing surfaces: profile / findings / evidence / run / queue
        assert reader.get_profile("ads.ads_sales_daily") is not None
        assert reader.list_findings()  # reads DWD only
        # raw table exists and is written by the run
        from app.governance.cdxr.store import GOVERNANCE_TABLES
        from pyiceberg.catalog import load_catalog
        raw = load_catalog("lakehouse", type="sql",
                           uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                           warehouse=str(warehouse))
        assert raw.load_table("governance_ods.cdxr_evidence_raw").scan().to_arrow().num_rows > 0
        assert "governance_ods.cdxr_evidence_raw" in GOVERNANCE_TABLES
        # but none of the reader's public methods touch the ODS raw tables
        public = {m for m in dir(reader) if not m.startswith("_")}
        assert "get_evidence_raw" not in public and "get_run_raw" not in public


# ---------------------------------------------------------------------
# 15. CLI entry point + governance API wiring
# ---------------------------------------------------------------------

class TestCLIAndAPI:
    def test_cli_main(self, warehouse, monkeypatch):
        monkeypatch.setenv("LAKEHOUSE_WAREHOUSE_PATH", str(warehouse))
        from app.governance.cdxr.run import main
        code = main(["--dataset-id", "ads.ads_sales_daily", "--snapshot", "latest",
                     "--time-column", "event_date", "--as-of", "2026-08-01T00:00:00Z"])
        assert code == 0

    def test_governance_api_routes_registered(self):
        from app.main import app
        paths = {r.path for r in app.routes}
        assert "/v1/governance/cdxr/datasets/{dataset_id}/profile" in paths
        assert "/v1/governance/cdxr/findings" in paths
        assert "/v1/governance/cdxr/findings/{finding_id}" in paths
        assert "/v1/governance/cdxr/findings/{finding_id}/evidence" in paths
        assert "/v1/governance/cdxr/runs/{run_id}" in paths
        assert "/v1/governance/cdxr/review-queue" in paths


# ---------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------

def _vocab() -> Vocabulary:
    return Vocabulary(sensitive_fields=("customer_id",), domain_fields=("revenue",),
                      risk_indicators=())


def ensure_catalog(warehouse) -> object:
    from app.governance.cdxr.store import ensure_governance_tables
    from pyiceberg.catalog import load_catalog
    catalog = load_catalog("lakehouse", type="sql",
                           uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                           warehouse=str(warehouse))
    ensure_governance_tables(catalog)
    return catalog
