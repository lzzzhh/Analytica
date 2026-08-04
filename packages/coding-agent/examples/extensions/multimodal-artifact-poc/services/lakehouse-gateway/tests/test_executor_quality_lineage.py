"""Tests: executor (query result schema / limit / masking / spill), quality, lineage."""
from __future__ import annotations

import json

import pytest

from app.catalog.dataset_registry import DatasetRegistry
from app.config import LakehouseConfig
from app.lineage.lineage import LineageRegistry
from app.query.executor import QueryExecutor, ValidationSession, mask_rows
from app.query.plan import parse_plan, validate_plan

AGG_PLAN = {
    "datasetId": "ads_sales_daily",
    "select": [{"field": "revenue", "aggregation": "sum", "alias": "total_revenue"},
               {"field": "orders", "aggregation": "count", "alias": "order_count"}],
    "dimensions": ["region"],
    "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25", "2026-07-31"]}],
    "limit": 100,
}

RAW_PLAN = {
    "datasetId": "ads_sales_daily",
    "select": [{"field": "region"}, {"field": "revenue"}, {"field": "customer_id"}],
    "dimensions": [],
    "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25", "2026-07-26"]}],
    "limit": 100,
}


def _validate_and_run(plan: dict, registry, config, executor: QueryExecutor, session: ValidationSession) -> dict:
    v = validate_plan(parse_plan(plan), registry, config)
    assert v.ok, [i.message for i in v.issues]
    session.put(v.validatedQueryId, v.plan)
    return executor.execute(v.validatedQueryId)


class TestExecutor:
    def test_query_result_schema(self, registry, config, executor: QueryExecutor, session: ValidationSession):
        r = _validate_and_run(AGG_PLAN, registry, config, executor, session)
        d = r.to_dict()
        for key in ("queryId", "datasetId", "datasetLayer", "snapshotId", "dataVersion",
                    "dataTimestamp", "columns", "rows", "rowCount", "qualityStatus",
                    "lineageReference", "warnings"):
            assert key in d, f"missing {key}"
        assert d["datasetId"] == "ads.ads_sales_daily"  # canonical namespaced id
        assert d["datasetLayer"] == "ADS"
        assert d["snapshotId"] is not None
        assert d["dataVersion"].startswith("v")
        assert d["rowCount"] == 2           # east + west
        assert d["qualityStatus"] in ("PASS", "WARN", "FAIL")
        assert d["lineageReference"].startswith("lineage://")

    def test_aggregation_values(self, registry, config, executor: QueryExecutor, session: ValidationSession):
        r = _validate_and_run(AGG_PLAN, registry, config, executor, session)
        # column order: dimensions first, then aggregates
        assert r.columns == ["region", "total_revenue", "order_count"]
        by_region = {row[0]: row[1] for row in r.rows}
        assert by_region["east"] == 300.0   # 100 + 200
        assert by_region["west"] == 150.0   # 150 + null → sum ignores null

    def test_raw_select(self, registry, config, executor: QueryExecutor, session: ValidationSession):
        r = _validate_and_run(RAW_PLAN, registry, config, executor, session)
        assert r.rowCount == 2
        assert r.columns == ["region", "revenue", "customer_id"]

    def test_limit_enforcement(self, registry, config, executor: QueryExecutor, session: ValidationSession):
        plan = {**RAW_PLAN, "limit": 1}
        r = _validate_and_run(plan, registry, config, executor, session)
        assert r.rowCount <= 1

    def test_sensitive_field_masked(self, registry, config, executor: QueryExecutor, session: ValidationSession):
        r = _validate_and_run(RAW_PLAN, registry, config, executor, session)
        idx = r.columns.index("customer_id")
        for row in r.rows:
            assert row[idx] in ("***", None), "customer_id must be masked"
        assert any("sensitive" in w for w in r.warnings)

    def test_execute_rejects_unvalidated_id(self, executor: QueryExecutor, session: ValidationSession):
        with pytest.raises(LookupError):
            executor.execute("vq_0000000000000000")
        with pytest.raises(ValueError):
            executor.execute("SELECT 1")

    def test_invalid_field_rejected_before_execution(self, registry, config, executor, session):
        v = validate_plan(parse_plan({**RAW_PLAN, "select": [{"field": "bogus"}]}), registry, config)
        assert not v.ok
        assert any(i.code == "field_not_found" for i in v.issues)

    def test_spill_to_artifact(self, registry, config, executor: QueryExecutor, session: ValidationSession, tmp_path):
        cfg = LakehouseConfig(mode="local", warehouse_path=config.warehouse_path, catalog_type="local",
                              gateway_url="http://t", max_result_bytes=60, artifacts_dir=str(tmp_path / "art"))
        exec_small = QueryExecutor(cfg, registry, session)
        r = _validate_and_run(RAW_PLAN, registry, cfg, exec_small, session)
        assert r.truncated is True
        assert r.artifactId.startswith("artifact://")
        assert len(r.rows) <= 20


class TestMaskRows:
    def test_column_level(self):
        rows = mask_rows(["region", "customer_id"], [["east", "c1"]], ("customer_id",))
        assert rows == [["east", "***"]]

    def test_eav_value_level(self):
        rows = mask_rows(
            ["image_type", "field_name", "field_value"],
            [["identity_document", "name", "John Doe"],
             ["identity_document", "id_number", "AB12345"]],
            ("id_number", "id_card"),
            label_col="field_name",
            value_col="field_value",
        )
        assert rows[0][2] == "John Doe"      # name not sensitive
        assert rows[1][2] == "***"           # id_number value masked

    def test_no_eav_columns(self):
        rows = mask_rows(["a", "b"], [["1", "2"]], ("id_number",))
        assert rows == [["1", "2"]]


class TestQuality:
    def test_quality_response(self, registry, config):
        from app.quality.checks import assess_quality
        from app.quality.profile import profile_structured
        tbl = registry._get_catalog().load_table("ads.ads_sales_daily").scan().to_arrow()
        profile = profile_structured("sales_daily", tbl.to_pylist())
        quality = assess_quality(tbl, config)
        assert quality.status in ("PASS", "WARN", "FAIL")
        assert quality.checks[0].check == "row_count"
        assert quality.checks[0].status == "PASS"
        # profile provides missing rate for customer_id (1/4 missing)
        cust = next(c for c in profile.columns if c.column_name == "customer_id")
        assert cust.missing_rate == 0.25


class TestLineage:
    def test_layer_links(self, lineage: LineageRegistry, registry: DatasetRegistry):
        result = lineage.explain("ads_sales_daily")
        upstream = {e.source for e in result.upstream}
        assert "dws.dws_sales_daily" in upstream
        assert result.dataset_id == "ads.ads_sales_daily"

    def test_manual_edges(self, lineage: LineageRegistry, registry: DatasetRegistry):
        lineage.register_edge("ads_sales_daily", "sales_report_v2")
        result = lineage.explain("ads_sales_daily")
        # manual edge canonicalized at registration; still resolves on explain
        assert any(e.target == "sales_report_v2" for e in result.downstream)

    def test_unknown_dataset(self, lineage: LineageRegistry):
        with pytest.raises(LookupError):
            lineage.explain("ghost")
