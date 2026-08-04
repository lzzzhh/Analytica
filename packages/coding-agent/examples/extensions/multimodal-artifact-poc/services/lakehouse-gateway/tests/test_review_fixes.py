"""Regression tests for code-review fixes (round-3 review).

Covers: EAV value-only masking bypass, filter pushdown + scan-size guard,
between restricted to time columns, validatedQueryId caller binding, and
real expiresAt.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pytest
from pyiceberg.schema import Schema
from pyiceberg.types import DateType, NestedField, StringType

from app.config import LakehouseConfig
from app.query.executor import QueryExecutor, ValidationSession
from app.query.plan import QueryPlan, parse_plan, validate_plan


def _build_eav_table(catalog) -> str:
    """Create an EAV-style table with sensitive label/value pairs."""
    catalog.create_table("ods.ods_ocr_eav", Schema(
        NestedField(1, "image_id", StringType(), required=False),
        NestedField(2, "field_name", StringType(), required=False),
        NestedField(3, "field_value", StringType(), required=False),
        NestedField(4, "confidence", StringType(), required=False),
    ))
    tbl = catalog.load_table("ods.ods_ocr_eav")
    tbl.append(pa.table({
        "image_id": ["img1", "img1", "img2", "img2"],
        "field_name": ["name", "id_number", "name", "id_number"],
        "field_value": ["zhang", "AB12345", "li", "CD67890"],
        "confidence": ["0.95", "0.88", "0.99", "0.82"],
    }))
    return "ods.ods_ocr_eav"


def _eav_config(warehouse) -> LakehouseConfig:
    return LakehouseConfig(
        mode="local", warehouse_path=str(warehouse), catalog_type="local",
        gateway_url="http://test", default_limit=100, max_limit=1000,
        max_scan_rows=1_000_000, max_execution_ms=30_000, allow_ods=True,
        max_result_bytes=256 * 1024, artifacts_dir=str(Path(warehouse).parent / "artifacts"),
    )


class TestEAVMasking:
    """Review P1-1: value-only EAV queries must not leak sensitive values."""

    def test_value_only_query_is_masked(self, warehouse, registry, session):
        cfg = _eav_config(warehouse)
        registry.config = cfg
        registry.discover(force=True)
        catalog = registry._get_catalog()
        _build_eav_table(catalog)
        registry.discover(force=True)

        plan = parse_plan({
            "datasetId": "ods_ocr_eav",
            "select": [{"field": "field_value"}],
            "filters": [{"field": "field_name", "operator": "eq", "value": "id_number"}],
            "limit": 10,
        })
        result = validate_plan(plan, registry, cfg)
        assert result.ok, [i.message for i in result.issues]
        vq = result.validatedQueryId
        session.put(vq, plan)
        out = QueryExecutor(cfg, registry, session).execute(vq)

        # values must be masked even though field_name was not projected
        assert out.columns == ["field_value"]
        assert all(v == "***" for row in out.rows for v in row), out.rows
        assert out.rowCount == 2

    def test_no_label_filter_value_still_masked(self, warehouse, registry, session):
        """Review round-4 P0-1: filtering on a NON-label column must not bypass
        EAV masking — the label column is attached internally by the scan."""
        cfg = _eav_config(warehouse)
        registry.config = cfg
        registry.discover(force=True)
        catalog = registry._get_catalog()
        _build_eav_table(catalog)
        registry.discover(force=True)

        plan = parse_plan({
            "datasetId": "ods_ocr_eav",
            "select": [{"field": "field_value"}],
            "filters": [{"field": "image_id", "operator": "eq", "value": "img1"}],
            "limit": 10,
        })
        result = validate_plan(plan, registry, cfg)
        assert result.ok, [i.message for i in result.issues]
        session.put(result.validatedQueryId, plan)
        out = QueryExecutor(cfg, registry, session).execute(result.validatedQueryId)

        # label not projected; sensitive id_number value masked, name value intact
        assert out.columns == ["field_value"]
        assert ["***"] in out.rows, out.rows          # id_number → AB12345 masked
        assert ["zhang"] in out.rows, out.rows        # name → zhang stays

    def test_aggregated_value_masked_before_aggregation(self, warehouse, registry, session):
        """Review round-4 P0-2: min/max over the EAV value column must not leak
        sensitive strings through the aggregated (renamed) column."""
        cfg = _eav_config(warehouse)
        registry.config = cfg
        registry.discover(force=True)
        catalog = registry._get_catalog()
        _build_eav_table(catalog)
        registry.discover(force=True)

        plan = parse_plan({
            "datasetId": "ods_ocr_eav",
            "select": [{"field": "field_value", "aggregation": "min"}],
            "filters": [{"field": "field_name", "operator": "eq", "value": "id_number"}],
            "limit": 10,
        })
        result = validate_plan(plan, registry, cfg)
        assert result.ok, [i.message for i in result.issues]
        session.put(result.validatedQueryId, plan)
        out = QueryExecutor(cfg, registry, session).execute(result.validatedQueryId)

        assert out.columns == ["field_value_min"]
        assert out.rows == [["***"]], out.rows

    def test_both_columns_query_still_masked(self, warehouse, registry, session):
        cfg = _eav_config(warehouse)
        registry.config = cfg
        registry.discover(force=True)
        catalog = registry._get_catalog()
        _build_eav_table(catalog)
        registry.discover(force=True)

        plan = parse_plan({
            "datasetId": "ods_ocr_eav",
            "select": [{"field": "field_name"}, {"field": "field_value"}],
            "filters": [{"field": "field_name", "operator": "eq", "value": "id_number"}],
            "limit": 10,
        })
        result = validate_plan(plan, registry, cfg)
        assert result.ok
        vq = result.validatedQueryId
        session.put(vq, plan)
        out = QueryExecutor(cfg, registry, session).execute(vq)
        id_rows = [r for r in out.rows if r[0] == "id_number"]
        assert id_rows and all(r[1] == "***" for r in id_rows)


class TestScanPushdown:
    """Review P1-4: filters pushed down, scan size pre-estimated, no full load."""

    def test_filter_pushdown_reduces_scan(self, warehouse, config, registry, session, executor):
        registry.discover(force=True)
        catalog = registry._get_catalog()
        import datetime as _dt
        catalog.load_table("dws.dws_sales_daily").append(pa.table({
            "event_date": pa.array([_dt.date(2026, 7, 29)] * 200, type=pa.date32()),
            "region": pa.array(["north"] * 200, type=pa.string()),
            "revenue": pa.array([1.0] * 200, type=pa.float64()),
            "orders": pa.array([1] * 200, type=pa.int64()),
            "customer_id": pa.array([None] * 200, type=pa.string()),
        }))
        plan = parse_plan({
            "datasetId": "dws_sales_daily",
            "select": [{"field": "revenue", "aggregation": "avg", "alias": "avg_rev"}],
            "dimensions": ["region"],
            "filters": [{"field": "event_date", "operator": "between",
                         "value": ["2026-07-25", "2026-07-26"]}],
            "limit": 10,
        })
        result = validate_plan(plan, registry, config)
        assert result.ok, [i.message for i in result.issues]
        session.put(result.validatedQueryId, plan)
        out = executor.execute(result.validatedQueryId)
        # only 2 of 204 rows match the window; aggregated by region → 1 group
        assert out.rowCount == 1
        assert out.rows == [["east", 150.0]]

    def test_scan_size_guard_rejects_before_load(self, warehouse, registry, session):
        cfg = LakehouseConfig(
            mode="local", warehouse_path=str(warehouse), catalog_type="local",
            max_scan_rows=1, max_limit=1000, allow_ods=True,
        )
        registry.config = cfg
        registry.discover(force=True)
        plan = parse_plan({
            "datasetId": "ads_sales_daily",
            "select": [{"field": "region"}],
            "limit": 1000,
        })
        # 4 rows estimated from metadata > max_scan_rows=1 → rejected before load
        with pytest.raises(ValueError, match="scan would read"):
            QueryExecutor(cfg, registry, session)._run(plan, "vq_" + "a" * 16)

    def test_between_on_non_time_column_rejected(self, warehouse, config, registry, session):
        registry.discover(force=True)
        plan = parse_plan({
            "datasetId": "ads_sales_daily",
            "select": [{"field": "revenue", "aggregation": "avg", "alias": "avg_rev"}],
            "filters": [{"field": "region", "operator": "between", "value": ["a", "z"]}],
            "limit": 10,
        })
        result = validate_plan(plan, registry, config)
        assert not result.ok
        assert any(i.code == "invalid_time_bound" for i in result.issues)


class TestGovernanceSnapshot:
    """Review P1-2: a named historical snapshot must be scanned, not the current one."""

    def _hist_table(self, catalog) -> tuple[str, int, int]:
        catalog.create_table("dws.dws_hist_events", Schema(
            NestedField(1, "event_date", DateType(), required=False),
            NestedField(2, "payload", StringType(), required=False),
        ))
        tbl = catalog.load_table("dws.dws_hist_events")
        tbl.append(pa.table({
            "event_date": pa.array([__import__("datetime").date(2026, 7, 1)] * 5, type=pa.date32()),
            "payload": pa.array(["old"] * 5, type=pa.string()),
        }))
        snap_a = tbl.current_snapshot().snapshot_id
        tbl.append(pa.table({
            "event_date": pa.array([__import__("datetime").date(2026, 7, 30)] * 5, type=pa.date32()),
            "payload": pa.array(["new"] * 5, type=pa.string()),
        }))
        snap_b = tbl.current_snapshot().snapshot_id
        return "dws.dws_hist_events", snap_a, snap_b

    def test_historical_snapshot_scans_historical_data(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import Vocabulary
        from app.governance.cdxr.store import ensure_governance_tables
        from pyiceberg.catalog import load_catalog
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        ensure_governance_tables(catalog)
        ds, snap_a, snap_b = self._hist_table(catalog)

        # old snapshot (data ends 07-01) → stale at 07-31 → NO_FRESH_DATA
        res_a = run_governance(catalog, ds, str(snap_a), vocabulary=Vocabulary(),
                               time_column="event_date", now="2026-07-31T00:00:00Z")
        assert any(f.risk_type == "NO_FRESH_DATA" for f in res_a.findings)
        assert all(f.snapshot_id == str(snap_a) for f in res_a.findings), \
            "finding must be bound to the scanned historical snapshot"
        assert res_a.run.snapshot_id == str(snap_a)

        # current snapshot (data ends 07-30) → fresh → no freshness finding
        res_b = run_governance(catalog, ds, "latest", vocabulary=Vocabulary(),
                               time_column="event_date", now="2026-07-31T00:00:00Z")
        assert not any(f.risk_type == "NO_FRESH_DATA" for f in res_b.findings)
        assert res_b.run.snapshot_id == str(snap_b)
        assert snap_a != snap_b

    def test_missing_snapshot_raises(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from pyiceberg.catalog import load_catalog
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        with pytest.raises(LookupError, match="snapshot"):
            run_governance(catalog, "ads.ads_sales_daily", "9999999999999999999",
                           now="2026-07-31T00:00:00Z")


class TestGovernanceRuleFailure:
    """Review P1-5: rule ERROR must not produce COMPLETED / TRUSTED."""

    def test_failed_rule_degrades_run_and_profile(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import PolicyRegistry, RuleSpec, Vocabulary, build_default_registry
        from app.governance.cdxr.store import ensure_governance_tables
        from pyiceberg.catalog import load_catalog

        def _boom(ctx):
            raise RuntimeError("simulated rule failure")

        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        ensure_governance_tables(catalog)
        registry = build_default_registry()
        registry.register(RuleSpec("exploding_check", "always fails", "schema", "HIGH", _boom))
        pol = PolicyRegistry()
        pol.register("failing", ["exploding_check"])

        res = run_governance(catalog, "ads.ads_sales_daily", "latest",
                             vocabulary=Vocabulary(), registry=registry,
                             policies=pol, policy="failing", time_column="event_date",
                             now="2026-08-01T00:00:00Z")
        assert res.run.status == "FAILED"
        assert "exploding_check" in res.run.error
        assert res.profile["failed_rule_count"] == 1
        assert res.profile["status"] == "INSUFFICIENT_EVIDENCE"  # never TRUSTED
        assert res.profile["governance_score"] == 100.0  # score alone would say TRUSTED


class TestGovernanceLifecycle:
    """Review P1-6: stable finding identity + status inheritance / reopen."""

    def _run_twice_and_find(self, warehouse, now1, now2):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import Vocabulary
        from app.governance.cdxr.store import ensure_governance_tables
        from pyiceberg.catalog import load_catalog
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        ensure_governance_tables(catalog)
        vocab = Vocabulary(sensitive_fields=("customer_id",))
        res1 = run_governance(catalog, "ads.ads_sales_daily", "latest", vocabulary=vocab,
                              time_column="event_date", now=now1)
        res2 = run_governance(catalog, "ads.ads_sales_daily", "latest", vocabulary=vocab,
                              time_column="event_date", now=now2)
        f1 = next(f for f in res1.findings if f.rule_id == "sensitive_field_check")
        f2 = next(f for f in res2.findings if f.rule_id == "sensitive_field_check")
        return catalog, f1, f2

    def test_stable_finding_id_and_detection_dates(self, warehouse):
        catalog, f1, f2 = self._run_twice_and_find(
            warehouse, "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z")
        assert f1.finding_id == f2.finding_id  # same problem, same finding
        assert f2.first_detected_at == f1.first_detected_at  # preserved
        assert f2.last_detected_at == "2026-08-02T00:00:00Z"  # updated
        assert f2.status == "OPEN"
        # table rows carry the stable id and both occurrences
        rows = catalog.load_table("governance_dwd.cdxr_finding").scan().to_arrow().to_pylist()
        ids = {r["finding_id"] for r in rows}
        assert f1.finding_id in ids

    def test_status_inheritance_and_reopen(self, warehouse):
        from app.governance.cdxr.runner import _candidate_to_finding
        from app.governance.cdxr.rules import FindingCandidate

        meta = {"snapshot_id": "s1", "data_version": "v1"}
        cand = FindingCandidate(rule_id="freshness_check", risk_type="NO_FRESH_DATA",
                                severity="HIGH", reason_codes=["NO_FRESH_DATA"],
                                summary="stale")

        # inherited: UNDER_REVIEW stays UNDER_REVIEW, WAIVED stays WAIVED
        f_u, _, _ = _candidate_to_finding(cand, "run_2", "d", meta, "q", "l", "2026-08-02T00:00:00Z",
                                          prev={"status": "UNDER_REVIEW", "first_detected_at": "2026-08-01T00:00:00Z"})
        assert f_u.status == "UNDER_REVIEW" and f_u.first_detected_at == "2026-08-01T00:00:00Z"
        f_w, _, _ = _candidate_to_finding(cand, "run_2", "d", meta, "q", "l", "2026-08-02T00:00:00Z",
                                          prev={"status": "WAIVED", "first_detected_at": "2026-08-01T00:00:00Z"})
        assert f_w.status == "WAIVED"

        # resolved that reappears → REOPEN (status OPEN + reopened flag)
        f_r, _, reopened = _candidate_to_finding(cand, "run_2", "d", meta, "q", "l", "2026-08-02T00:00:00Z",
                                                 prev={"status": "RESOLVED", "first_detected_at": "2026-08-01T00:00:00Z"})
        assert reopened and f_r.status == "OPEN"
        assert f_r.first_detected_at == "2026-08-01T00:00:00Z"  # history preserved

    def test_review_queue_contains_only_active_findings(self, warehouse):
        from app.governance.reader import GovernanceReader
        catalog, _, _ = self._run_twice_and_find(
            warehouse, "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z")
        queue = GovernanceReader(catalog).get_review_queue()
        queued = {i["findingId"] for i in queue}
        assert queued  # OPEN findings present
        # no RESOLVED/WAIVED entries are queued (lifecycle filter)
        rows = catalog.load_table("governance_dwd.cdxr_finding").scan().to_arrow().to_pylist()
        assert all(r["status"] in ("OPEN", "UNDER_REVIEW") or r["finding_id"] not in queued
                   for r in rows)


class TestFindingLifecyclePersistence:
    """Review round-4 P1: persisted RESOLVED → queue clear → REOPEN chain,
    latest-occurrence reads, evidence scoping, UNDER_REVIEW scoring."""

    def _catalog(self, warehouse):
        from pyiceberg.catalog import load_catalog
        from app.governance.cdxr.store import ensure_governance_tables
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        ensure_governance_tables(catalog)
        return catalog

    def _run(self, catalog, now, sensitive=("customer_id",)):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import Vocabulary
        vocab = Vocabulary(sensitive_fields=sensitive)
        return run_governance(catalog, "ads.ads_sales_daily", "latest", vocabulary=vocab,
                              time_column="event_date", now=now)

    def test_resolved_then_queue_clear_then_reopen(self, warehouse):
        from app.governance.reader import GovernanceReader
        catalog = self._catalog(warehouse)

        # 1. finding present → OPEN + queued
        self._run(catalog, "2026-08-01T00:00:00Z", sensitive=("customer_id",))
        reader = GovernanceReader(catalog)
        q1 = reader.get_review_queue("ads.ads_sales_daily")
        sens = [i for i in q1 if i.get("summary") and "customer_id" in str(i["summary"])]
        assert sens, q1
        fid = sens[0]["findingId"]
        assert reader.get_finding(fid)["status"] == "OPEN"

        # 2. problem disappears → RESOLVED occurrence persisted, queue clears
        self._run(catalog, "2026-08-02T00:00:00Z", sensitive=())
        finding = reader.get_finding(fid)
        assert finding is not None and finding["status"] == "RESOLVED", finding
        q2 = reader.get_review_queue("ads.ads_sales_daily")
        assert all(i["findingId"] != fid for i in q2), q2

        # 3. reappears → REOPEN (status OPEN again, queue re-lists it)
        self._run(catalog, "2026-08-03T00:00:00Z", sensitive=("customer_id",))
        finding3 = reader.get_finding(fid)
        assert finding3["status"] == "OPEN", finding3
        assert finding3["firstDetectedAt"] == "2026-08-01T00:00:00Z"  # history preserved
        q3 = reader.get_review_queue("ads.ads_sales_daily")
        assert any(i["findingId"] == fid for i in q3), q3

    def test_get_finding_returns_latest_occurrence(self, warehouse):
        from app.governance.reader import GovernanceReader
        catalog = self._catalog(warehouse)
        r1 = self._run(catalog, "2026-08-01T00:00:00Z", sensitive=("customer_id",))
        self._run(catalog, "2026-08-02T00:00:00Z", sensitive=("customer_id",))
        reader = GovernanceReader(catalog)
        f = reader.get_finding(r1.findings[0].finding_id)
        assert f["lastDetectedAt"] == "2026-08-02T00:00:00Z", f  # not the first row

    def test_evidence_ids_unique_per_run_and_scoped_to_latest(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import Vocabulary
        from app.governance.reader import GovernanceReader
        from pyiceberg.catalog import load_catalog
        catalog = self._catalog(warehouse)
        # two runs over two distinct snapshots
        tbl = catalog.load_table("ads.ads_sales_daily")
        snap_a = tbl.current_snapshot().snapshot_id
        tbl.append(pa.table({
            "event_date": pa.array([__import__("datetime").date(2026, 7, 29)] * 2, type=pa.date32()),
            "region": pa.array(["north"] * 2, type=pa.string()),
            "revenue": pa.array([1.0] * 2, type=pa.float64()),
            "orders": pa.array([1] * 2, type=pa.int64()),
            "customer_id": pa.array(["c9", "c8"] * 1, type=pa.string()),
        }))
        snap_b = tbl.current_snapshot().snapshot_id
        assert snap_a != snap_b
        vocab = Vocabulary(sensitive_fields=("customer_id",))
        r1 = run_governance(catalog, "ads.ads_sales_daily", str(snap_a), vocabulary=vocab,
                            time_column="event_date", now="2026-08-01T00:00:00Z")
        r2 = run_governance(catalog, "ads.ads_sales_daily", str(snap_b), vocabulary=vocab,
                            time_column="event_date", now="2026-08-02T00:00:00Z")
        assert r1.findings and r2.findings
        ids1 = {e.evidence_id for e in r1.evidence}
        ids2 = {e.evidence_id for e in r2.evidence}
        assert ids1 and ids2 and ids1.isdisjoint(ids2), "evidence ids must be unique per run"
        # reader scopes evidence to the latest occurrence's snapshot
        reader = GovernanceReader(catalog)
        ev = reader.get_finding_evidence(r2.findings[0].finding_id)
        assert ev and all(e["sourceSnapshot"] == str(snap_b) for e in ev), ev

    def test_under_review_finding_keeps_dataset_not_trusted(self, warehouse):
        """Review round-4 P1: active statuses = OPEN + UNDER_REVIEW — a HIGH
        finding under human review must not flip the dataset to TRUSTED."""
        from app.governance.cdxr.aggregate import (
            build_trust_profile, compute_governance_score,
            compute_dimension_scores, highest_severity,
        )
        from app.governance.cdxr.contracts import FindingStatus, GovernanceFindingV1
        from app.governance.cdxr.rules import FindingCandidate
        from app.governance.cdxr.runner import _candidate_to_finding

        meta = {"snapshot_id": "s1", "data_version": "v1"}
        cand = FindingCandidate(rule_id="freshness_check", risk_type="NO_FRESH_DATA",
                                severity="HIGH", reason_codes=["NO_FRESH_DATA"],
                                summary="stale")
        f, _, _ = _candidate_to_finding(cand, "run_1", "ads.ads_sales_daily", meta,
                                        "q", "l", "2026-08-01T00:00:00Z")
        assert f.status == FindingStatus.OPEN.value
        f.status = FindingStatus.UNDER_REVIEW.value  # human review in progress

        score, status = compute_governance_score([f])
        assert status != "TRUSTED", (score, status)
        assert highest_severity([f]) == "HIGH"
        profile = build_trust_profile("ads.ads_sales_daily", "s1", [f], "PASS", "q", "l",
                                      {"freshness_check": "freshness"},
                                      generated_at="2026-08-01T00:00:00Z")
        assert profile.open_finding_count == 1
        assert profile.dimension_scores["freshness"] < 90.0


class TestDatasetIdCompatibility:
    """Review P1-3: agent-chain short ids interoperate with governance ids."""

    def test_short_id_resolves_to_namespaced_governance_record(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import Vocabulary
        from app.governance.cdxr.store import ensure_governance_tables
        from app.governance.reader import GovernanceReader
        from pyiceberg.catalog import load_catalog
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        ensure_governance_tables(catalog)
        vocab = Vocabulary(sensitive_fields=("customer_id",), domain_fields=("revenue",))
        run_governance(catalog, "ads.ads_sales_daily", "latest", vocabulary=vocab,
                       time_column="event_date", now="2026-08-01T00:00:00Z")

        reader = GovernanceReader(catalog)
        full = reader.get_profile("ads.ads_sales_daily")
        short = reader.get_profile("ads_sales_daily")  # what search_catalog returns
        assert full is not None and short is not None
        assert full["datasetId"] == short["datasetId"] == "ads.ads_sales_daily"
        assert full["governanceScore"] == short["governanceScore"]
        # findings list works with the short id too
        assert len(reader.list_findings(dataset_id="ads_sales_daily")) >= 1

    def test_namespace_collision_is_recorded_not_silently_overwritten(self, warehouse):
        from pyiceberg.catalog import load_catalog
        from app.config import LakehouseConfig
        from app.catalog.dataset_registry import DatasetRegistry
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        catalog.create_table("ods.dup_table", Schema(
            NestedField(1, "x", StringType(), required=False)))
        catalog.create_table("dwd.dup_table", Schema(
            NestedField(1, "x", StringType(), required=False)))
        registry = DatasetRegistry(LakehouseConfig(mode="local", warehouse_path=str(warehouse)))
        registry.discover()
        # canonical namespaced ids both resolvable
        assert registry.get("ods.dup_table") is not None
        assert registry.get("dwd.dup_table") is not None
        # ambiguous short name does NOT resolve to either
        assert registry.get("dup_table") is None
        # collision recorded (not silently overwritten)
        assert registry.collisions, registry.collisions
        assert any("dup_table" in c for c in registry.collisions)

    def test_unique_short_name_resolves_as_alias(self, warehouse):
        from pyiceberg.catalog import load_catalog
        from app.config import LakehouseConfig
        from app.catalog.dataset_registry import DatasetRegistry
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        catalog.create_table("ods.unique_table", Schema(
            NestedField(1, "x", StringType(), required=False)))
        registry = DatasetRegistry(LakehouseConfig(mode="local", warehouse_path=str(warehouse)))
        registry.discover()
        # globally unique short name still works as an alias
        assert registry.get("unique_table") is not None
        assert registry.get("unique_table").dataset_id == "ods.unique_table"


class TestGovernanceSchemaEvolution:
    """Review round-4 P1: pre-existing governance tables (old schema) must be
    evolved, not recreated or appended-to-with-a-mismatch."""

    def test_old_schema_table_evolved_before_write(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import Vocabulary
        from app.governance.cdxr.store import ensure_governance_tables
        from app.governance.reader import GovernanceReader
        from pyiceberg.catalog import load_catalog
        from pyiceberg.schema import Schema
        from pyiceberg.types import DoubleType, LongType, NestedField, StringType

        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        for ns in ("governance_ads", "governance_dwd", "governance_ods",
                   "governance_dws", "governance_meta"):
            if tuple([ns]) not in {tuple(n) for n in catalog.list_namespaces()}:
                catalog.create_namespace(ns)
        # OLD schema: dataset_trust_profile without rule_count / failed_rule_count
        old = Schema(
            NestedField(1, "dataset_id", StringType(), required=False),
            NestedField(2, "snapshot_id", StringType(), required=False),
            NestedField(3, "governance_score", DoubleType(), required=False),
            NestedField(4, "status", StringType(), required=False),
            NestedField(5, "open_finding_count", LongType(), required=False),
            NestedField(6, "highest_severity", StringType(), required=False),
            NestedField(7, "dimension_scores", StringType(), required=False),
            NestedField(8, "quality_status", StringType(), required=False),
            NestedField(9, "quality_reference", StringType(), required=False),
            NestedField(10, "lineage_reference", StringType(), required=False),
            NestedField(11, "finding_ids", StringType(), required=False),
            NestedField(12, "generated_at", StringType(), required=False),
        )
        catalog.create_table("governance_ads.dataset_trust_profile", old)

        # running the runner must evolve the schema and write successfully
        res = run_governance(catalog, "ads.ads_sales_daily", "latest",
                             vocabulary=Vocabulary(sensitive_fields=("customer_id",)),
                             time_column="event_date", now="2026-08-01T00:00:00Z")
        assert res.profile["rule_count"] > 0
        evolved = catalog.load_table("governance_ads.dataset_trust_profile")
        names = {f.name for f in evolved.schema().fields}
        assert {"rule_count", "failed_rule_count"} <= names, names
        # reader sees the new fields on the old table
        profile = GovernanceReader(catalog).get_profile("ads.ads_sales_daily")
        assert profile is not None
        assert profile["ruleCount"] > 0


class TestSessionBinding:
    """Review P1-7: caller binding + real expiry."""

    def test_expires_at_is_future(self, warehouse, config, registry, session):
        registry.discover(force=True)
        plan = parse_plan({
            "datasetId": "ads_sales_daily",
            "select": [{"field": "region"}],
            "filters": [{"field": "event_date", "operator": "between",
                         "value": ["2026-07-25", "2026-07-28"]}],
            "limit": 10,
        })
        result = validate_plan(plan, registry, config)
        assert result.ok
        expires = datetime.fromisoformat(result.expiresAt)
        now = datetime.now(timezone.utc)
        delta = (expires - now).total_seconds()
        assert 550 <= delta <= 610  # ~10 minutes ahead, not "now"

    def test_caller_bound_session(self, warehouse, registry, session, executor):
        vq = "vq_" + "b" * 16
        plan = parse_plan({"datasetId": "ads_sales_daily", "select": [{"field": "region"}],
                           "filters": [{"field": "event_date", "operator": "between",
                                        "value": ["2026-07-25", "2026-07-28"]}],
                           "limit": 10})
        session.put(vq, plan, caller="alice")
        # same caller works (validation would have happened; execute only)
        assert session.get(vq, caller="alice") is plan
        # different caller is rejected
        assert session.get(vq, caller="bob") is None
        with pytest.raises(LookupError):
            executor.execute(vq, caller="bob")

    def test_caller_mismatch_does_not_delete(self, warehouse, registry, session, executor):
        """Review round-4 P2: a rejected caller must not delete the session
        entry — otherwise any other client could one-shot-DoS the legitimate
        caller (entry survives until TTL expiry)."""
        vq = "vq_" + "c" * 16
        plan = parse_plan({"datasetId": "ads_sales_daily", "select": [{"field": "region"}],
                           "filters": [{"field": "event_date", "operator": "between",
                                        "value": ["2026-07-25", "2026-07-28"]}],
                           "limit": 10})
        session.put(vq, plan, caller="alice")
        assert session.get(vq, caller="bob") is None
        # legitimate caller still executes afterwards
        assert session.get(vq, caller="alice") is plan
        out = executor.execute(vq, caller="alice")
        assert out.rowCount == 4


class TestFindingLifecycleDatasetScope:
    """Review round-4.1 P1: finding lifecycle must be scoped to the dataset
    being governed — running dataset B must not load, resolve or rewrite
    dataset A's findings."""

    def test_run_on_dataset_b_does_not_touch_dataset_a_findings(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import Vocabulary
        from app.governance.cdxr.store import ensure_governance_tables
        from app.governance.reader import GovernanceReader
        from pyiceberg.catalog import load_catalog
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        ensure_governance_tables(catalog)
        vocab = Vocabulary(sensitive_fields=("customer_id",))

        # 1. dataset A run → OPEN finding
        res_a = run_governance(catalog, "ads.ads_sales_daily", "latest", vocabulary=vocab,
                               time_column="event_date", now="2026-08-01T00:00:00Z")
        fid_a = next(f.finding_id for f in res_a.findings
                     if f.rule_id == "sensitive_field_check")

        # 2. dataset B run (different dataset, same sensitive column)
        run_governance(catalog, "dws.dws_sales_daily", "latest", vocabulary=vocab,
                       time_column="event_date", now="2026-08-02T00:00:00Z")
        reader = GovernanceReader(catalog)

        # 3a. A's finding still belongs to A and is still OPEN
        finding = reader.get_finding(fid_a)
        assert finding is not None and finding["datasetId"] == "ads.ads_sales_daily", finding
        assert finding["status"] == "OPEN", finding

        # 3b. no row with A's finding_id but dataset B; no RESOLVED occurrence
        rows = catalog.load_table("governance_dwd.cdxr_finding").scan().to_arrow().to_pylist()
        a_rows = [r for r in rows if r["finding_id"] == fid_a]
        assert a_rows, "A finding rows must still exist"
        for r in a_rows:
            assert r["dataset_id"] == "ads.ads_sales_daily", r
            assert r["status"] != "RESOLVED", r

        # 3c. A's review queue unaffected by B's run
        queue = reader.get_review_queue("ads.ads_sales_daily")
        assert any(i["findingId"] == fid_a for i in queue), queue


class TestOnlyEvaluatedRulesAutoResolve:
    """Review round-4.1 P2: a previous finding may only be auto-resolved when
    its rule was actually evaluated this run (PASS/FAIL). ERROR or omitted
    rules must not resolve anything."""

    def _catalog(self, warehouse):
        from pyiceberg.catalog import load_catalog
        from app.governance.cdxr.store import ensure_governance_tables
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        ensure_governance_tables(catalog)
        return catalog

    def test_rule_error_does_not_resolve_previous_finding(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import RuleSpec, Vocabulary, build_default_registry
        from app.governance.reader import GovernanceReader
        catalog = self._catalog(warehouse)
        vocab = Vocabulary(sensitive_fields=("customer_id",))

        # A. healthy run → OPEN finding
        res1 = run_governance(catalog, "ads.ads_sales_daily", "latest", vocabulary=vocab,
                              time_column="event_date", now="2026-08-01T00:00:00Z")
        fid = next(f.finding_id for f in res1.findings
                   if f.rule_id == "sensitive_field_check")

        # B. the same rule now explodes
        def _boom(ctx):
            raise RuntimeError("simulated rule failure")

        registry = build_default_registry()
        registry.register(RuleSpec("sensitive_field_check", "always fails",
                                   "sensitive", "HIGH", _boom))
        res2 = run_governance(catalog, "ads.ads_sales_daily", "latest", vocabulary=vocab,
                              registry=registry, time_column="event_date",
                              now="2026-08-02T00:00:00Z")

        # run degraded
        assert res2.run.status == "FAILED"
        assert res2.profile["status"] == "INSUFFICIENT_EVIDENCE"
        # original finding untouched: still OPEN, still queued, no RESOLVED row
        reader = GovernanceReader(catalog)
        finding = reader.get_finding(fid)
        assert finding is not None and finding["status"] == "OPEN", finding
        queue = reader.get_review_queue("ads.ads_sales_daily")
        assert any(i["findingId"] == fid for i in queue), queue
        rows = catalog.load_table("governance_dwd.cdxr_finding").scan().to_arrow().to_pylist()
        assert all(r["status"] != "RESOLVED" for r in rows if r["finding_id"] == fid), rows

    def test_policy_omission_does_not_resolve_previous_finding(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import PolicyRegistry, Vocabulary
        from app.governance.reader import GovernanceReader
        catalog = self._catalog(warehouse)
        vocab = Vocabulary(sensitive_fields=("customer_id",))

        res1 = run_governance(catalog, "ads.ads_sales_daily", "latest", vocabulary=vocab,
                              time_column="event_date", now="2026-08-01T00:00:00Z")
        fid = next(f.finding_id for f in res1.findings
                   if f.rule_id == "sensitive_field_check")

        # second run's policy does NOT include sensitive_field_check
        pol = PolicyRegistry()
        pol.register("minimal", ["freshness_check"])
        res2 = run_governance(catalog, "ads.ads_sales_daily", "latest", vocabulary=vocab,
                              policies=pol, policy="minimal", time_column="event_date",
                              now="2026-08-02T00:00:00Z")
        assert res2.run.status == "COMPLETED"

        reader = GovernanceReader(catalog)
        finding = reader.get_finding(fid)
        assert finding is not None and finding["status"] == "OPEN", finding
        rows = catalog.load_table("governance_dwd.cdxr_finding").scan().to_arrow().to_pylist()
        assert all(r["status"] != "RESOLVED" for r in rows if r["finding_id"] == fid), rows


class TestEvidenceOccurrenceBoundary:
    """Review round-4.1 P3: evidence must be scoped by the latest finding
    occurrence's evidenceReferences — two runs on the SAME snapshot produce
    different evidence ids, so snapshot filtering alone leaks stale evidence."""

    def test_same_snapshot_two_runs_returns_only_latest_evidence(self, warehouse):
        from app.governance.cdxr.runner import run_governance
        from app.governance.cdxr.rules import Vocabulary
        from app.governance.cdxr.store import ensure_governance_tables
        from app.governance.reader import GovernanceReader
        from pyiceberg.catalog import load_catalog
        catalog = load_catalog("lakehouse", type="sql",
                               uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
                               warehouse=str(warehouse))
        ensure_governance_tables(catalog)
        vocab = Vocabulary(sensitive_fields=("customer_id",))
        snap = str(catalog.load_table("ads.ads_sales_daily").current_snapshot().snapshot_id)

        r1 = run_governance(catalog, "ads.ads_sales_daily", snap, vocabulary=vocab,
                            time_column="event_date", now="2026-08-01T00:00:00Z")
        r2 = run_governance(catalog, "ads.ads_sales_daily", snap, vocabulary=vocab,
                            time_column="event_date", now="2026-08-02T00:00:00Z")

        f2 = next(f for f in r2.findings if f.rule_id == "sensitive_field_check")
        fid = f2.finding_id
        assert fid == next(f.finding_id for f in r1.findings
                           if f.rule_id == "sensitive_field_check")  # same problem
        ids1 = {e.evidence_id for e in r1.evidence if e.finding_id == fid}
        ids2 = {e.evidence_id for e in r2.evidence if e.finding_id == fid}
        assert ids1 and ids2 and ids1.isdisjoint(ids2), "evidence ids differ per run"

        ev = GovernanceReader(catalog).get_finding_evidence(fid)
        ev_ids = {e["evidenceId"] for e in ev}
        assert ev_ids == ids2, (ev_ids, ids2)
        assert not (ev_ids & ids1), "first run's evidence must not leak through"
