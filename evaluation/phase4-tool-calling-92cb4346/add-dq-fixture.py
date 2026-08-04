from pathlib import Path

from pyiceberg.catalog import load_catalog
from pyiceberg.schema import Schema
from pyiceberg.types import LongType, NestedField, StringType

warehouse = Path(__file__).resolve().parent / "runtime" / "gateway-warehouse"
catalog = load_catalog(
    "lakehouse", type="sql",
    uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
    warehouse=str(warehouse),
)
catalog.create_table(
    "dws.dws_quality_fail",
    schema=Schema(
        NestedField(1, "id", LongType(), required=False),
        NestedField(2, "value", StringType(), required=False),
    ),
)
print("dws.dws_quality_fail")
