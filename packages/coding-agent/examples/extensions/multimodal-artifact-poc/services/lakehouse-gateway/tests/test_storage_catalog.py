"""Tests: storage profile, config, catalog search, dataset inspection."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.catalog.dataset_registry import DatasetRegistry, validate_dataset_id
from app.config import LakehouseConfig
from app.storage.profile import CatalogBackend, StorageBackend, StorageProfile


# -- local storage -----------------------------------------------------

class TestLocalStorage:
    def test_local_dev_default(self, tmp_path: Path):
        p = StorageProfile.local_dev(str(tmp_path / "wh"))
        assert p.backend == StorageBackend.LOCAL
        assert "file://" in p.warehouse
        assert p.warehouse_path == str(tmp_path / "wh")

    def test_local_spark_configs_no_s3(self):
        p = StorageProfile.local_dev("/tmp/wh")
        configs = p.spark_configs()
        assert configs["spark.sql.catalog.lakehouse.type"] == "hadoop"
        assert "s3" not in str(configs)

    def test_local_flink_ddl(self):
        p = StorageProfile.local_dev("/tmp/wh")
        ddl = p.flink_sql_catalog_ddl()
        assert "CREATE CATALOG lakehouse" in ddl
        assert "hadoop" in ddl

    def test_cloud_profile(self):
        p = StorageProfile.cloud(warehouse="s3://my-bucket/wh", region="us-east-2")
        assert p.backend == StorageBackend.S3
        assert p.catalog_backend == CatalogBackend.GLUE
        configs = p.spark_configs()
        assert "S3FileIO" in configs["spark.sql.catalog.lakehouse.io-impl"]
        assert configs["spark.sql.catalog.lakehouse.client.region"] == "us-east-2"

    def test_cloud_checkpoint_defaults_use_bucket(self):
        p = StorageProfile.cloud(warehouse="s3://my-bucket/wh")
        assert "my-bucket" in p.checkpoint_dir


class TestConfig:
    def test_local_defaults(self, monkeypatch):
        monkeypatch.delenv("LAKEHOUSE_WAREHOUSE_PATH", raising=False)
        monkeypatch.delenv("LAKEHOUSE_MODE", raising=False)
        c = LakehouseConfig.from_env()
        assert c.mode == "local" and not c.is_aws
        assert c.catalog_type == "local"
        assert c.max_limit == 1000 and c.default_limit == 100

    def test_aws_requires_s3_warehouse(self, monkeypatch):
        monkeypatch.setenv("LAKEHOUSE_MODE", "aws")
        monkeypatch.delenv("LAKEHOUSE_S3_WAREHOUSE", raising=False)
        with pytest.raises(ValueError):
            LakehouseConfig.from_env()

    def test_aws_mode(self, monkeypatch):
        monkeypatch.setenv("LAKEHOUSE_MODE", "aws")
        monkeypatch.setenv("LAKEHOUSE_S3_WAREHOUSE", "s3://bucket/wh")
        monkeypatch.setenv("LAKEHOUSE_CATALOG_TYPE", "glue")
        c = LakehouseConfig.from_env()
        assert c.is_aws and c.warehouse_path == "s3://bucket/wh"
        assert c.catalog_backend == CatalogBackend.GLUE


# -- dataset id closure ------------------------------------------------

class TestDatasetId:
    def test_valid_ids(self):
        assert validate_dataset_id("sales_daily") == []
        assert validate_dataset_id("a1_b2") == []

    def test_invalid_ids(self):
        assert validate_dataset_id("") != []
        assert validate_dataset_id("Sales-Daily") != []
        assert validate_dataset_id("with space") != []


# -- catalog search / inspection ---------------------------------------

class TestCatalog:
    def test_discover_layers(self, registry: DatasetRegistry):
        ids = registry.discover()
        assert "ads.ads_sales_daily" in ids
        assert "dwd.dwd_sales_raw" in ids
        assert "ods.ods_sales_ingest" in ids
        layers = {registry.get(i).layer for i in ids}
        assert layers == {"ADS", "DWD", "ODS", "DWS"}

    def test_inspect_dataset(self, registry: DatasetRegistry):
        d = registry.get("ads_sales_daily")
        assert d is not None
        assert d.layer == "ADS"
        assert d.table_name == "ads.ads_sales_daily"
        field_names = {f.name for f in d.fields}
        assert {"event_date", "region", "revenue", "orders", "customer_id"} <= field_names
        assert d.latest_snapshot_id is not None
        # partition info from spec
        part = [f for f in d.fields if f.partition]
        assert part and part[0].name == "event_date"

    def test_search_by_name(self, registry: DatasetRegistry):
        r = registry.search(q="sales_daily")
        # ordered by layer (DWS before ADS); canonical namespaced ids
        assert [d.dataset_id for d in r] == ["dws.dws_sales_daily", "ads.ads_sales_daily"]

    def test_search_by_layer(self, registry: DatasetRegistry):
        r = registry.search(layer="DWD")
        assert [d.dataset_id for d in r] == ["dwd.dwd_sales_raw"]

    def test_search_no_match(self, registry: DatasetRegistry):
        assert registry.search(q="zzz_nothing") == []

    def test_validate_closure(self, registry: DatasetRegistry):
        errors = registry.validate()
        assert errors == []
