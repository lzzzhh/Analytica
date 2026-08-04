"""API smoke tests — all read-only endpoints via FastAPI TestClient."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import reload_config  # noqa: E402


@pytest.fixture()
def client(warehouse: Path):
    os.environ["LAKEHOUSE_MODE"] = "local"
    os.environ["LAKEHOUSE_WAREHOUSE_PATH"] = str(warehouse)
    reload_config()
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


class TestApi:
    def test_health(self, client):
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["datasets"] >= 4

    def test_catalog_search(self, client):
        r = client.get("/v1/catalog/search", params={"q": "sales_daily"})
        assert r.status_code == 200
        ids = [d["datasetId"] for d in r.json()["results"]]
        assert "ads.ads_sales_daily" in ids

    def test_catalog_search_layer(self, client):
        r = client.get("/v1/catalog/search", params={"layer": "DWD"})
        assert r.status_code == 200
        assert [d["datasetId"] for d in r.json()["results"]] == ["dwd.dwd_sales_raw"]

    def test_inspect_dataset(self, client):
        r = client.get("/v1/datasets/ads_sales_daily")
        assert r.status_code == 200
        d = r.json()
        assert d["layer"] == "ADS"
        assert d["tableName"] == "ads.ads_sales_daily"
        assert any(f["name"] == "revenue" for f in d["fields"])

    def test_inspect_missing(self, client):
        assert client.get("/v1/datasets/ghost").status_code == 404

    def test_validate_ok(self, client):
        r = client.post("/v1/query/validate", json={
            "datasetId": "ads_sales_daily",
            "select": [{"field": "revenue", "aggregation": "sum", "alias": "total_revenue"}],
            "dimensions": ["region"],
            "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25", "2026-07-31"]}],
            "limit": 100,
        })
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert body["validatedQueryId"].startswith("vq_")

    def test_validate_rejects_ods(self, client):
        r = client.post("/v1/query/validate", json={
            "datasetId": "ods_sales_ingest",
            "select": [{"field": "event_date", "aggregation": "count", "alias": "n"}],
            "dimensions": [],
            "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25", "2026-07-26"]}],
            "limit": 10,
        })
        assert r.status_code == 200
        assert r.json()["ok"] is False
        assert r.json()["issues"][0]["code"] == "ods_denied"

    def test_validate_rejects_bad_shape(self, client):
        r = client.post("/v1/query/validate", json={"datasetId": "x", "limit": 0})
        assert r.status_code == 422

    def test_execute_flow(self, client):
        v = client.post("/v1/query/validate", json={
            "datasetId": "ads_sales_daily",
            "select": [{"field": "revenue", "aggregation": "sum", "alias": "total_revenue"}],
            "dimensions": ["region"],
            "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25", "2026-07-31"]}],
            "limit": 100,
        }).json()
        r = client.post("/v1/query/execute", json={"validatedQueryId": v["validatedQueryId"]})
        assert r.status_code == 200
        body = r.json()
        assert body["queryId"].startswith("q_")
        assert body["datasetId"] == "ads.ads_sales_daily"  # canonical namespaced id
        assert body["datasetLayer"] == "ADS"
        assert body["snapshotId"] is not None
        assert body["dataVersion"].startswith("v")
        assert body["dataTimestamp"]
        assert body["rowCount"] == 2
        assert body["qualityStatus"] in ("PASS", "WARN", "FAIL")
        assert body["lineageReference"].startswith("lineage://")
        assert body["warnings"] == []

    def test_execute_requires_validated_id(self, client):
        r = client.post("/v1/query/execute", json={"validatedQueryId": "vq_0000000000000000"})
        assert r.status_code == 404
        r = client.post("/v1/query/execute", json={"validatedQueryId": "SELECT 1"})
        assert r.status_code == 400  # invalid validatedQueryId format → executor rejects

    def test_execute_sensitive_masked(self, client):
        v = client.post("/v1/query/validate", json={
            "datasetId": "ads_sales_daily",
            "select": [{"field": "customer_id"}],
            "dimensions": [],
            "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25", "2026-07-26"]}],
            "limit": 100,
        }).json()
        body = client.post("/v1/query/execute", json={"validatedQueryId": v["validatedQueryId"]}).json()
        assert all(row[0] in ("***", None) for row in body["rows"])

    def test_quality_endpoint(self, client):
        r = client.get("/v1/quality/ads_sales_daily")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] in ("PASS", "WARN", "FAIL")
        assert body["profile"]["rowCount"] == 4
        cust = next(c for c in body["profile"]["columns"] if c["column"] == "customer_id")
        assert cust["missingRate"] == 0.25

    def test_lineage_endpoint(self, client):
        r = client.get("/v1/lineage/ads_sales_daily")
        assert r.status_code == 200
        body = r.json()
        upstream = {e["source"] for e in body["upstream"]}
        assert "dws.dws_sales_daily" in upstream

    def test_snapshots_endpoint(self, client):
        r = client.get("/v1/snapshots/ads_sales_daily")
        assert r.status_code == 200
        body = r.json()
        assert body["count"] >= 1
        assert body["snapshots"][0]["snapshotId"] is not None



    def test_lineage_single_prefix_auto_link(self):
        """Single-prefix naming (ods.x -> dwd.x) is linked automatically."""
        from app.lineage.lineage import LineageRegistry

        class _Meta:
            def __init__(self, ds):
                self.dataset_id = ds

        class _FakeRegistry:
            def __init__(self):
                self._datasets = {"ods.alpha": True, "dwd.alpha": True,
                                  "dws.alpha": True, "ads.alpha": True}

            def get(self, ds):
                return _Meta(ds) if ds in self._datasets else None

            def discover(self, force=False):
                return list(self._datasets.keys())

        lr = LineageRegistry(_FakeRegistry())
        r = lr.explain("ods.alpha")
        assert any(e.target == "dwd.alpha" for e in r.downstream)
        r2 = lr.explain("dwd.alpha")
        assert any(e.source == "ods.alpha" for e in r2.upstream)

    def test_lineage_edge_rejects_unknown(self, client):
        r = client.post("/v1/lineage/edges",
                        json={"source": "ods.nope", "target": "dwd.dwd_sales_raw"})
        assert r.status_code == 404
