#!/usr/bin/env python3
"""Migrate the original RiskCloud warehouse (hadoop-catalog layout) into the
data-agent local lakehouse (pyiceberg SQL catalog).

READ-ONLY against the source warehouse (never writes there). Creates the same
tables under the data-agent warehouse, data + schema preserved verbatim
(field names are NOT renamed — the source tables carry domain field names
such as credit_score / auc / ks; the catalog layer marks those tables with
domain="risk" instead).

Usage:
    python3 scripts/migrate_warehouse.py \
        --source /path/to/LeakBench-RiskCloud/data/warehouse \
        --target ./../../.data/warehouse
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from pyiceberg.catalog import load_catalog
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import (
    BucketTransform, DayTransform, HourTransform, IdentityTransform,
    MonthTransform, TruncateTransform, YearTransform,
)
from pyiceberg.types import (
    BinaryType, BooleanType, DateType, DecimalType, DoubleType, FloatType,
    IntegerType, LongType, NestedField, StringType, TimestampType, TimestamptzType,
    UUIDType,
)

LAYERS = ("ods", "dwd", "dws", "ads")
SCALAR_TYPES = {
    "long": LongType, "int": IntegerType, "integer": IntegerType,
    "string": StringType, "double": DoubleType, "float": FloatType,
    "boolean": BooleanType, "date": DateType, "timestamp": TimestampType,
    "timestamptz": TimestamptzType, "binary": BinaryType, "uuid": UUIDType,
}


def parse_iceberg_type(type_str: str):
    """Iceberg type string → pyiceberg type (scalar only; complex → error)."""
    t = type_str.strip()
    if t.startswith("decimal"):
        # decimal(P, S)
        inner = t[len("decimal("):-1]
        p, s = inner.split(",")
        return DecimalType(int(p), int(s))
    if t.startswith("list") or t.startswith("struct") or t.startswith("map"):
        raise ValueError(f"complex type not supported by migration: {t}")
    if t not in SCALAR_TYPES:
        raise ValueError(f"unknown type: {t}")
    return SCALAR_TYPES[t]()


TRANSFORMS = {
    "identity": lambda: IdentityTransform(),
    "day": lambda: DayTransform(),
    "month": lambda: MonthTransform(),
    "hour": lambda: HourTransform(),
    "year": lambda: YearTransform(),
    "bucket": lambda: BucketTransform(16),
    "truncate": lambda: TruncateTransform(16),
}


def build_schema(meta: dict) -> Schema:
    schema = meta.get("schema") or (meta.get("schemas") or [{}])[-1]
    fields = []
    for f in schema["fields"]:
        fields.append(NestedField(
            field_id=f["id"],
            name=f["name"],
            field_type=parse_iceberg_type(f["type"]),
            required=bool(f.get("required", False)),
        ))
    return Schema(*fields)


def build_partition_spec(meta: dict, schema: Schema) -> PartitionSpec:
    spec = meta.get("partition-spec") or []
    if not spec:
        return PartitionSpec()
    fields = []
    for p in spec:
        transform = TRANSFORMS.get(p["transform"])
        if transform is None:
            raise ValueError(f"unsupported transform: {p['transform']}")
        fields.append(PartitionField(
            source_id=p["source-id"],
            field_id=p["field-id"],
            transform=transform(),
            name=p["name"],
        ))
    return PartitionSpec(*fields)


def migrate_table(catalog, layer: str, table_name: str, source: Path, target: Path) -> dict:
    tbl_dir = source / layer / table_name
    metas = sorted(glob.glob(str(tbl_dir / "metadata" / "v*.metadata.json")))
    if not metas:
        return {"table": f"{layer}.{table_name}", "status": "skipped_no_metadata"}
    meta = json.load(open(metas[-1]))

    schema = build_schema(meta)
    spec = build_partition_spec(meta, schema)

    full = f"{layer}.{table_name}"
    if full in [t[0] + "." + t[1] for t in catalog.list_tables(layer)]:
        return {"table": full, "status": "exists_skipped"}

    table = catalog.create_table(full, schema=schema, partition_spec=spec)

    parquet_files = sorted(glob.glob(str(tbl_dir / "data" / "*.parquet")))
    row_count = 0
    if parquet_files:
        tables = [pq.read_table(p) for p in parquet_files]
        arrow = pa.concat_tables(tables) if len(tables) > 1 else tables[0]
        row_count = arrow.num_rows
        table.append(arrow)

    snap = table.current_snapshot()
    return {
        "table": full,
        "status": "migrated",
        "rows": row_count,
        "snapshotId": snap.snapshot_id if snap else None,
        "fields": len(schema.fields),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True, help="source warehouse path (hadoop-catalog layout)")
    ap.add_argument("--target", required=True, help="target warehouse path (pyiceberg SQL catalog)")
    args = ap.parse_args()

    source = Path(args.source)
    target = Path(args.target)
    if not source.is_dir():
        print(f"source not found: {source}", file=sys.stderr)
        return 1
    target.mkdir(parents=True, exist_ok=True)

    catalog = load_catalog(
        "lakehouse",
        type="sql",
        uri=f"sqlite:///{target / '.lakehouse-catalog.db'}",
        warehouse=str(target),
    )
    for layer in LAYERS:
        try:
            catalog.create_namespace(layer)
        except Exception:
            pass

    print(f"source: {source}")
    print(f"target: {target}")
    results = []
    for layer in LAYERS:
        layer_dir = source / layer
        if not layer_dir.is_dir():
            continue
        for table_dir in sorted(layer_dir.iterdir()):
            if table_dir.is_dir():
                results.append(migrate_table(catalog, layer, table_dir.name, source, target))

    total_rows = 0
    print("\n== migration report ==")
    for r in results:
        if r["status"] == "migrated":
            total_rows += r["rows"]
        print(f"  {r['table']:<45} {r['status']:<18} "
              + (f"rows={r['rows']} snapshot={r['snapshotId']} fields={r['fields']}" if r["status"] == "migrated" else ""))
    print(f"\ntotal: {len(results)} tables, {total_rows} rows migrated")
    print(f"catalog db: {target / '.lakehouse-catalog.db'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
