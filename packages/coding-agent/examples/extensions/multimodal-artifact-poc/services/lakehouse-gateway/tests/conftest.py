"""Test fixtures: build a small local Iceberg warehouse (tmp dir) for tests.

The test warehouse is created with pyiceberg (hadoop catalog, file://). No
production credentials or resources are involved.
"""
from __future__ import annotations

import datetime as dt
import os
import sys
from pathlib import Path

import pyarrow as pa
import pytest
from pyiceberg.catalog import load_catalog
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import DayTransform
from pyiceberg.types import DateType, DoubleType, LongType, NestedField, StringType

# Feature flags: the test suite exercises the full safe surface (lakehouse
# on, legacy governance API on, CDXR training API on). Per spec §11 the
# runtime defaults are OFF — tests opt in here, BEFORE any app import, so
# the process-wide resolver (app/features.py) is built with these values.
# Single source of truth: config/features/registry.json.
os.environ.setdefault("ENABLE_LAKEHOUSE", "true")
os.environ.setdefault("ENABLE_LEGACY_CDXR_GOVERNANCE_TOOLS", "true")
os.environ.setdefault("ENABLE_LEGACY_CDXR_GOVERNANCE_CLI", "true")
os.environ.setdefault("ENABLE_CDXR_TRAINING", "true")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# cdxr-engine is a separate package (services/cdxr-engine) imported by the
# gateway adapter and API module.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "cdxr-engine"))

from app.catalog.dataset_registry import DatasetRegistry  # noqa: E402
from app.config import LakehouseConfig  # noqa: E402
from app.lineage.lineage import LineageRegistry  # noqa: E402
from app.query.executor import QueryExecutor, ValidationSession  # noqa: E402


def build_test_warehouse(warehouse: Path) -> None:
    """Create ads.sales_daily + dwd.sales_raw + ods.sales_ingest with rows."""
    warehouse.mkdir(parents=True, exist_ok=True)
    # NOTE: catalog_name + db filename must match DatasetRegistry (".lakehouse-catalog.db")
    # — pyiceberg SQL catalog isolates records by catalog_name AND by sqlite file.
    catalog = load_catalog(
        "lakehouse",
        type="sql",
        uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
        warehouse=str(warehouse),
    )

    sales_schema = Schema(
        NestedField(1, "event_date", DateType(), required=False),
        NestedField(2, "region", StringType(), required=False),
        NestedField(3, "revenue", DoubleType(), required=False),
        NestedField(4, "orders", LongType(), required=False),
        NestedField(5, "customer_id", StringType(), required=False),
    )
    raw_schema = Schema(
        NestedField(1, "event_date", DateType(), required=False),
        NestedField(2, "region", StringType(), required=False),
        NestedField(3, "amount", DoubleType(), required=False),
        NestedField(4, "customer_id", StringType(), required=False),
    )
    ods_schema = Schema(
        NestedField(1, "event_date", DateType(), required=False),
        NestedField(2, "raw_payload", StringType(), required=False),
    )

    for ns in ("ods", "dwd", "dws", "ads"):
        catalog.create_namespace(ns)

    spec = PartitionSpec(
        PartitionField(source_id=1, field_id=1000, transform=DayTransform(), name="event_date_day")
    )
    catalog.create_table("ads.ads_sales_daily", schema=sales_schema, partition_spec=spec)
    catalog.create_table("dwd.dwd_sales_raw", schema=raw_schema)
    catalog.create_table("dws.dws_sales_daily", schema=sales_schema)
    catalog.create_table("ods.ods_sales_ingest", schema=ods_schema)

    def _date(s: str) -> dt.date:
        return dt.date.fromisoformat(s)

    sales = pa.table({
        "event_date": [_date("2026-07-25"), _date("2026-07-26"), _date("2026-07-27"), _date("2026-07-28")],
        "region": ["east", "east", "west", "west"],
        "revenue": [100.0, 200.0, 150.0, None],
        "orders": [10, 20, 15, 5],
        "customer_id": ["c1", "c2", "c3", None],
    })
    catalog.load_table("ads.ads_sales_daily").append(sales)
    catalog.load_table("dws.dws_sales_daily").append(sales)

    raw = pa.table({
        "event_date": [_date("2026-07-25"), _date("2026-07-26")],
        "region": ["east", "west"],
        "amount": [99.0, 151.0],
        "customer_id": ["c1", "c3"],
    })
    catalog.load_table("dwd.dwd_sales_raw").append(raw)

    ingest = pa.table({
        "event_date": [_date("2026-07-25")],
        "raw_payload": ["{json}"],
    })
    catalog.load_table("ods.ods_sales_ingest").append(ingest)
    return catalog


@pytest.fixture()
def warehouse(tmp_path: Path):
    warehouse = tmp_path / "wh"
    catalog = build_test_warehouse(warehouse)
    yield warehouse
    # dispose SQLAlchemy engine to avoid unclosed-sqlite ResourceWarnings
    try:
        catalog.engine.dispose()
    except Exception:
        pass


@pytest.fixture()
def config(warehouse: Path) -> LakehouseConfig:
    return LakehouseConfig(
        mode="local",
        warehouse_path=str(warehouse),
        catalog_type="local",
        gateway_url="http://test",
        default_limit=100,
        max_limit=1000,
        max_scan_rows=1_000_000,
        max_execution_ms=30_000,
        allow_ods=False,
        max_result_bytes=256 * 1024,
        artifacts_dir=str(warehouse.parent / "artifacts"),
    )


@pytest.fixture()
def registry(config: LakehouseConfig) -> DatasetRegistry:
    r = DatasetRegistry(config)
    r.discover()
    return r


@pytest.fixture()
def session() -> ValidationSession:
    return ValidationSession()


@pytest.fixture()
def executor(config: LakehouseConfig, registry: DatasetRegistry, session: ValidationSession) -> QueryExecutor:
    return QueryExecutor(config, registry, session)


@pytest.fixture()
def lineage(registry: DatasetRegistry) -> LineageRegistry:
    return LineageRegistry(registry)
