"""Tests: query plan parsing and validate_query checks."""
from __future__ import annotations

import pytest

from app.catalog.dataset_registry import DatasetRegistry
from app.config import LakehouseConfig
from app.query.plan import parse_plan, validate_plan

OK_PLAN = {
    "datasetId": "ads_sales_daily",
    "select": [{"field": "revenue", "aggregation": "sum", "alias": "total_revenue"}],
    "dimensions": ["region"],
    "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25", "2026-07-31"]}],
    "limit": 100,
}


class TestParsePlan:
    def test_ok(self):
        p = parse_plan(OK_PLAN)
        assert p.datasetId == "ads_sales_daily"
        assert p.select[0].aggregation == "sum"
        assert p.limit == 100

    def test_missing_dataset_id(self):
        with pytest.raises(ValueError):
            parse_plan({"select": []})

    def test_bad_aggregation(self):
        with pytest.raises(ValueError):
            parse_plan({**OK_PLAN, "select": [{"field": "x", "aggregation": "product"}]})

    def test_bad_operator(self):
        with pytest.raises(ValueError):
            parse_plan({**OK_PLAN, "filters": [{"field": "region", "operator": "like", "value": "e%"}]})

    def test_bad_limit(self):
        with pytest.raises(ValueError):
            parse_plan({**OK_PLAN, "limit": 0})

    def test_sql_keyword_dataset_id_rejected(self):
        with pytest.raises(ValueError):
            parse_plan({**OK_PLAN, "datasetId": "sales; drop table x"})


class TestValidatePlan:
    def test_ok(self, registry: DatasetRegistry, config: LakehouseConfig):
        r = validate_plan(parse_plan(OK_PLAN), registry, config)
        assert r.ok, [i.message for i in r.issues]
        assert r.validatedQueryId.startswith("vq_")

    def test_dataset_not_found(self, registry: DatasetRegistry, config: LakehouseConfig):
        r = validate_plan(parse_plan({**OK_PLAN, "datasetId": "nope"}), registry, config)
        assert not r.ok
        assert r.issues[0].code == "dataset_not_found"

    def test_ods_denied(self, registry: DatasetRegistry, config: LakehouseConfig):
        r = validate_plan(parse_plan({**OK_PLAN, "datasetId": "ods_sales_ingest"}), registry, config)
        assert not r.ok
        assert r.issues[0].code == "ods_denied"

    def test_ods_allowed_when_configured(self, registry: DatasetRegistry, config: LakehouseConfig):
        cfg = LakehouseConfig(mode="local", warehouse_path=config.warehouse_path, catalog_type="local",
                              gateway_url="http://t", allow_ods=True)
        ods_plan = {
            "datasetId": "ods_sales_ingest",
            "select": [{"field": "event_date", "aggregation": "count", "alias": "n"}],
            "dimensions": [],
            "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25", "2026-07-26"]}],
            "limit": 10,
        }
        r = validate_plan(parse_plan(ods_plan), registry, cfg)
        assert r.ok, [i.message for i in r.issues]

    def test_invalid_field_rejected(self, registry: DatasetRegistry, config: LakehouseConfig):
        r = validate_plan(parse_plan({**OK_PLAN, "select": [{"field": "not_a_column"}]}), registry, config)
        assert not r.ok
        assert any(i.code == "field_not_found" for i in r.issues)

    def test_limit_enforcement(self, registry: DatasetRegistry, config: LakehouseConfig):
        r = validate_plan(parse_plan({**OK_PLAN, "limit": 5000}), registry, config)
        assert not r.ok
        assert any(i.code == "limit_exceeded" for i in r.issues)

    def test_partition_filter_required(self, registry: DatasetRegistry, config: LakehouseConfig):
        # sales_daily is partitioned by event_date; filter on region only → issue
        plan = {**OK_PLAN, "filters": [{"field": "region", "operator": "eq", "value": "east"}]}
        r = validate_plan(parse_plan(plan), registry, config)
        assert not r.ok
        assert any(i.code == "partition_filter_required" for i in r.issues)

    def test_aggregation_without_bounded_filter(self, registry: DatasetRegistry, config: LakehouseConfig):
        plan = {**OK_PLAN, "filters": []}
        r = validate_plan(parse_plan(plan), registry, config)
        assert not r.ok
        assert any(i.code == "scan_too_broad" for i in r.issues)

    def test_between_requires_pair(self, registry: DatasetRegistry, config: LakehouseConfig):
        plan = {**OK_PLAN, "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25"]}]}
        r = validate_plan(parse_plan(plan), registry, config)
        assert not r.ok
        assert any(i.code == "invalid_filter" for i in r.issues)
