"""POST /v1/query/materialize — artifact-only materialization tests.

Round 4: Data Analysis Subagent input materialization.
- accepts only validatedQueryId (no raw SQL);
- caller binding applies;
- returns metadata only (no rows to the agent);
- feature-gated: round4.analysis_input_materialization off → 404;
- produces a real parquet artifact on disk.
"""
import json
from pathlib import Path

import pytest

from tests.test_cdxr_training import module_client  # noqa: E402,F401


def _validate(client) -> dict:
    return client.post("/v1/query/validate", json={
        "datasetId": "ads_sales_daily",
        "select": [{"field": "revenue", "aggregation": "sum", "alias": "total_revenue"}],
        "dimensions": ["region"],
        "filters": [{"field": "event_date", "operator": "between", "value": ["2026-07-25", "2026-07-31"]}],
        "limit": 100,
    }).json()


def _on(client):
    """Enable lakehouse + data analysis features for the test body."""
    from app.features import _set_default_resolver
    from app.features import resolve_runtime_settings, load_registry, FeatureResolver
    from app.generated.build_features import BUILD_FEATURE_MANIFEST
    reg = load_registry()
    runtime = resolve_runtime_settings(reg, {
        "ENABLE_LAKEHOUSE": "true",
        "ENABLE_DATA_ANALYSIS": "true",
        "ENABLE_ANALYSIS_INPUT_MATERIALIZATION": "true",
    })
    _set_default_resolver(FeatureResolver(registry=reg, build_manifest=BUILD_FEATURE_MANIFEST,
                                          runtime=runtime, env={}))


class TestMaterialize:
    def test_materialize_parquet_metadata_only(self, module_client):
        client, _wh = module_client
        _on(client)
        try:
            v = _validate(client)
            r = client.post("/v1/query/materialize", json={
                "validatedQueryId": v["validatedQueryId"], "format": "parquet",
            })
            assert r.status_code == 200
            body = r.json()
            assert body["artifactId"].startswith("art_")
            assert body["queryId"].startswith("q_")
            assert body["rowCount"] == 2
            assert body["columns"] == ["region", "total_revenue"]
            assert body["masked"] is True
            assert body["format"] == "PARQUET"
            assert body["contentHash"]
            assert "rows" not in body, "materialize must not return rows"
            assert "artifactPath" not in body, "storage path must not reach the agent"
        finally:
            from app.features import _set_default_resolver
            _set_default_resolver(None)

    def test_materialize_arrow(self, module_client):
        client, _wh = module_client
        _on(client)
        try:
            v = _validate(client)
            r = client.post("/v1/query/materialize", json={
                "validatedQueryId": v["validatedQueryId"], "format": "arrow",
            })
            assert r.status_code == 200
            assert r.json()["format"] == "ARROW"
        finally:
            from app.features import _set_default_resolver
            _set_default_resolver(None)

    def test_materialize_persists_trusted_registry_entry(self, module_client):
        client, _wh = module_client
        _on(client)
        try:
            v = _validate(client)
            body = client.post("/v1/query/materialize", json={
                "validatedQueryId": v["validatedQueryId"], "format": "parquet",
            }).json()
            from app.api.routes import _DEPS
            inputs = Path(_DEPS["executor"].config.artifacts_dir) / "inputs"
            data_path = inputs / f"{body['artifactId']}.data"
            registry_path = inputs / f"{body['artifactId']}.json"
            assert data_path.is_file()
            assert registry_path.is_file()
            registered = json.loads(registry_path.read_text(encoding="utf-8"))
            assert registered["artifactId"] == body["artifactId"]
            assert registered["contentHash"] == body["contentHash"]
            assert registered["contentType"] == "application/vnd.apache.parquet"
        finally:
            from app.features import _set_default_resolver
            _set_default_resolver(None)

    def test_materialize_rejects_bad_format(self, module_client):
        client, _wh = module_client
        _on(client)
        try:
            v = _validate(client)
            r = client.post("/v1/query/materialize", json={
                "validatedQueryId": v["validatedQueryId"], "format": "csv",
            })
            assert r.status_code == 400
        finally:
            from app.features import _set_default_resolver
            _set_default_resolver(None)

    def test_materialize_unknown_validated_id_404(self, module_client):
        client, _wh = module_client
        r = client.post("/v1/query/materialize", json={
            "validatedQueryId": "missing", "format": "parquet",
        })
        assert r.status_code in (400, 404)

    def test_materialize_feature_off_404(self, module_client):
        client, _wh = module_client
        # materialization explicitly off → route gated
        from app.features import _set_default_resolver, FeatureResolver, load_registry, resolve_runtime_settings
        from app.generated.build_features import BUILD_FEATURE_MANIFEST
        reg = load_registry()
        runtime = resolve_runtime_settings(reg, {"ENABLE_ANALYSIS_INPUT_MATERIALIZATION": "false"})
        _set_default_resolver(FeatureResolver(registry=reg, build_manifest=BUILD_FEATURE_MANIFEST,
                                              runtime=runtime, env={}))
        try:
            r = client.post("/v1/query/materialize", json={
                "validatedQueryId": "whatever", "format": "parquet",
            })
            assert r.status_code == 404
            assert "FEATURE_DISABLED" in r.json().get("detail", "")
        finally:
            _set_default_resolver(None)

    def test_materialize_does_not_write_business_tables(self, module_client):
        """Artifacts live outside the warehouse catalog."""
        client, _wh = module_client
        _on(client)
        try:
            v = _validate(client)
            client.post("/v1/query/materialize", json={
                "validatedQueryId": v["validatedQueryId"], "format": "parquet",
            })
            # warehouse still serves queries normally
            r = client.post("/v1/query/validate", json={
                "datasetId": "ads_sales_daily",
                "select": [{"field": "revenue", "aggregation": "sum", "alias": "r"}],
                "limit": 10,
            })
            assert r.status_code == 200
        finally:
            from app.features import _set_default_resolver
            _set_default_resolver(None)

    def test_materialize_refuses_truncated_sample(self, module_client, monkeypatch):
        """An oversized result must fail explicitly — never materialize the
        20-row agent summary as analysis input."""
        client, _wh = module_client
        _on(client)
        from app.api.routes import _DEPS
        from app.config import LakehouseConfig
        executor = _DEPS["executor"]
        small = LakehouseConfig(**{**executor.config.__dict__, "max_result_bytes": 64})
        monkeypatch.setattr(executor, "config", small)  # force spill
        try:
            v = _validate(client)
            r = client.post("/v1/query/materialize", json={
                "validatedQueryId": v["validatedQueryId"], "format": "parquet",
            })
            assert r.status_code == 400
            assert "refusing to materialize a truncated sample" in r.json().get("detail", "")
        finally:
            from app.features import _set_default_resolver
            _set_default_resolver(None)
