"""CDXR training-assessment API tests — on-demand, read-only, deterministic.

Covers: safe plans (ALLOW/REVIEW) with no raw rows, target leakage BLOCK,
sensitive-policy BLOCK, historical snapshot pinning, input validation
(unknown dataset 404 / unknown snapshot 400 / extra fields 422), the
requirement that normal query execution never triggers CDXR, and that a
training assessment never writes governance state.
"""
from __future__ import annotations

import datetime as dt
import os
import sys
from pathlib import Path

import pyarrow as pa
import pytest
from pyiceberg.catalog import load_catalog

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import reload_config  # noqa: E402

AUDIT_LOG = Path(".data/audit.log")


@pytest.fixture(scope="module")
def module_client(tmp_path_factory):
    """One shared warehouse for the whole module, with the gateway app wired
    to it. app.main is imported once per process and other test modules may
    have already pointed it at their own warehouse, so this fixture rebuilds
    the module-level dependencies (same wiring as app.main).

    The append-heavy demo table (ads.ads_cdxr_demo) is created here so that
    other modules' assertions on the shared tables (4 rows) stay unaffected.
    """
    warehouse = tmp_path_factory.mktemp("wh")
    from tests.conftest import build_test_warehouse
    build_test_warehouse(warehouse)
    # dedicated demo table: 4 base rows, then 996 more -> 2 snapshots,
    # 1000 rows. Used only by this module.
    catalog = load_catalog(
        "lakehouse", type="sql",
        uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
        warehouse=str(warehouse))
    from pyiceberg.schema import Schema
    from pyiceberg.types import DateType, DoubleType, LongType, NestedField, StringType
    demo_schema = Schema(
        NestedField(1, "event_date", DateType(), required=False),
        NestedField(2, "region", StringType(), required=False),
        NestedField(3, "revenue", DoubleType(), required=False),
        NestedField(4, "orders", LongType(), required=False),
        NestedField(5, "customer_id", StringType(), required=False),
    )
    catalog.create_table("ads.ads_cdxr_demo", schema=demo_schema)
    base = pa.table({
        "event_date": [dt.date.fromisoformat("2026-07-25")] * 4,
        "region": ["east", "east", "west", "west"],
        "revenue": [100.0, 200.0, 150.0, None],
        "orders": [10, 20, 15, 5],
        "customer_id": ["c1", "c2", "c3", None],
    })
    catalog.load_table("ads.ads_cdxr_demo").append(base)
    extra = pa.table({
        "event_date": [dt.date.fromisoformat("2026-05-01")] * 996,
        "region": ["east"] * 498 + ["west"] * 498,
        "revenue": [10.0] * 996,
        "orders": [0] * 800 + [1] * 196,
        "customer_id": pa.array([None] * 996, type=pa.string()),
    })
    catalog.load_table("ads.ads_cdxr_demo").append(extra)

    os.environ["LAKEHOUSE_MODE"] = "local"
    os.environ["LAKEHOUSE_WAREHOUSE_PATH"] = str(warehouse)
    cfg = reload_config()
    import app.main as main
    from app.api.cdxr_routes import _wire as _wire_cdxr
    from app.api.governance_routes import _wire as _wire_gov
    from app.api.routes import _wire
    from app.catalog.dataset_registry import DatasetRegistry
    from app.governance.reader import GovernanceReader
    from app.integrations.cdxr_lakehouse_adapter import LakehouseTrainingDatasetAdapter
    from app.lineage.lineage import LineageRegistry
    from app.query.executor import QueryExecutor, ValidationSession
    main._config = cfg
    main._registry = DatasetRegistry(cfg)
    main._session = ValidationSession()
    main._executor = QueryExecutor(cfg, main._registry, main._session)
    main._lineage = LineageRegistry(main._registry)
    _wire(cfg, main._registry, main._session, main._executor,
          main._lineage, main._audit, main._limiter)
    _wire_gov(GovernanceReader(main._registry._get_catalog()),
              limiter=main._limiter, audit=main._audit)
    _wire_cdxr(LakehouseTrainingDatasetAdapter(main._registry, cfg, main._lineage),
               limiter=main._limiter, audit=main._audit)
    from fastapi.testclient import TestClient
    return TestClient(main.app), warehouse


def _assess(client, **overrides):
    body = {
        "datasetId": "dws.dws_sales_daily",
        "targetField": "orders",
        "featureFields": ["revenue", "region"],
        "predictionTimeField": "event_date",
        **overrides,
    }
    return client.post("/v1/cdxr/training-assessments", json=body)


def _audit_lines() -> str:
    return AUDIT_LOG.read_text() if AUDIT_LOG.exists() else ""


class TestSafePlans:
    def test_small_safe_plan_reviews_without_raw_rows(self, module_client):
        client, _wh = module_client
        r = _assess(client)
        assert r.status_code == 200
        body = r.json()
        # 4 rows < min sample size -> REVIEW (not ALLOW, not BLOCK)
        assert body["status"] == "REVIEW"
        assert body["rawRowsReturned"] is False
        assert "rows" not in body and "values" not in body
        assert body["checkedFields"] == ["orders", "revenue", "region"]
        assert body["ruleVersion"]
        assert body["assessmentId"].startswith("ast_")
        assert any(f["code"] == "SAMPLE_SIZE" for f in body["findings"])

    def test_large_safe_plan_allows(self, module_client):
        client, _wh = module_client
        # ads.ads_cdxr_demo holds 1000 rows (4 base + 996 appended in fixture)
        r = _assess(client, datasetId="ads.ads_cdxr_demo")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ALLOW"
        assert body["rawRowsReturned"] is False
        assert body["findings"] == []

    def test_historical_snapshot_is_pinned(self, module_client):
        client, _wh = module_client
        snaps = client.get("/v1/snapshots/ads.ads_cdxr_demo").json()["snapshots"]
        assert len(snaps) >= 2
        old = min(snaps, key=lambda s: s["timestampMs"])
        new = max(snaps, key=lambda s: s["timestampMs"])
        assert old["snapshotId"] != new["snapshotId"]
        # historical snapshot: 4 rows -> REVIEW; latest: 1000 rows -> ALLOW
        r_old = _assess(client, datasetId="ads.ads_cdxr_demo",
                        snapshotId=old["snapshotId"])
        assert r_old.status_code == 200
        assert r_old.json()["snapshotId"] == old["snapshotId"]
        assert r_old.json()["status"] == "REVIEW"
        r_new = _assess(client, datasetId="ads.ads_cdxr_demo",
                        snapshotId=new["snapshotId"])
        assert r_new.json()["snapshotId"] == new["snapshotId"]
        assert r_new.json()["status"] == "ALLOW"


class TestBlocks:
    def test_target_in_features_blocks(self, module_client):
        client, _wh = module_client
        r = _assess(client, featureFields=["revenue", "orders"])
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "BLOCK"
        assert any(f["code"] == "TARGET_IN_FEATURES" and f["severity"] == "CRITICAL"
                   for f in body["findings"])

    def test_sensitive_feature_policy_review_then_block(self, module_client):
        client, _wh = module_client
        r = _assess(client, featureFields=["customer_id", "revenue"])
        assert r.json()["status"] == "REVIEW"
        assert any(f["code"] == "SENSITIVE_FEATURE" for f in r.json()["findings"])
        r2 = _assess(client, featureFields=["customer_id", "revenue"],
                     sensitiveFieldPolicy="block")
        assert r2.json()["status"] == "BLOCK"
        assert any(f["code"] == "SENSITIVE_FEATURE" for f in r2.json()["findings"])


class TestInputValidation:
    def test_unknown_dataset_404(self, module_client):
        client, _wh = module_client
        r = _assess(client, datasetId="ods.does_not_exist")
        assert r.status_code == 404

    def test_unknown_snapshot_400(self, module_client):
        client, _wh = module_client
        r = _assess(client, snapshotId=999_999_999)
        assert r.status_code == 400

    def test_extra_fields_rejected_422(self, module_client):
        client, _wh = module_client
        # SQL / arbitrary expressions are not part of the contract
        r = _assess(client, sql="SELECT * FROM dws_sales_daily")
        assert r.status_code == 422
        r2 = _assess(client, featureFields=["revenue + 1"])
        assert r2.status_code == 200
        assert r2.json()["status"] == "INSUFFICIENT_EVIDENCE"

    def test_missing_feature_field_is_insufficient(self, module_client):
        client, _wh = module_client
        r = _assess(client, featureFields=["revenue", "nope_missing"])
        assert r.status_code == 200
        assert r.json()["status"] == "INSUFFICIENT_EVIDENCE"


class TestNoSideEffects:
    def test_execute_query_does_not_trigger_cdxr(self, module_client):
        client, _wh = module_client
        before = _audit_lines()
        v = client.post("/v1/query/validate", json={
            "datasetId": "ads_sales_daily",
            "select": [{"field": "revenue", "aggregation": "sum", "alias": "total_revenue"}],
            "dimensions": ["region"],
            "filters": [{"field": "event_date", "operator": "between",
                         "value": ["2026-07-25", "2026-07-31"]}],
            "limit": 100,
        }).json()
        assert v["ok"] is True
        r = client.post("/v1/query/execute",
                        json={"validatedQueryId": v["validatedQueryId"]})
        assert r.status_code == 200
        after = _audit_lines()
        new_lines = after[len(before):]
        # a normal query run never produces CDXR assessment records
        assert "cdxr_training_assessment" not in new_lines
        # and the governance pipeline was not triggered either
        g = client.get("/v1/governance/cdxr/datasets/ads.ads_sales_daily/profile")
        assert g.status_code == 404

    def test_assessment_does_not_write_governance(self, module_client):
        client, _wh = module_client
        r = _assess(client)
        assert r.status_code == 200
        # governance tables stay untouched (no profile, no findings)
        g = client.get("/v1/governance/cdxr/datasets/dws.dws_sales_daily/profile")
        assert g.status_code == 404
        g2 = client.get("/v1/governance/cdxr/findings")
        assert g2.status_code == 200
        assert g2.json()["count"] == 0
        # audit records metadata only — no raw values (no customer_id key,
        # no region/customer values like east/west/c1 anywhere in the line)
        import json as _json
        lines = [ln for ln in _audit_lines().splitlines()
                 if '"cdxr_training_assessment"' in ln]
        record = _json.loads(lines[-1])
        assert record["action"] == "cdxr_training_assessment"
        assert record["dataset_id"] == "dws.dws_sales_daily"
        assert record["status"] in ("ALLOW", "REVIEW", "BLOCK", "INSUFFICIENT_EVIDENCE")
        assert "customer_id" not in record
        assert "east" not in lines[-1]
        assert '"customer_id"' not in lines[-1]
