"""Lakehouse TrainingDatasetPort adapter — read-only aggregate access.

Implements cdxr.ports.TrainingDatasetPort over the existing Iceberg catalog
(via DatasetRegistry) and LineageRegistry. Hard constraints:
  - no raw row data is ever returned (aggregates only; value distributions
    are withheld for sensitive fields and capped at MAX_DISTRIBUTION_BINS)
  - no SQL is accepted or generated; only selected_fields projection + counts
  - no writes of any kind
  - scans are bounded: max_scan_rows is estimated from metadata before any
    data is loaded, and max_execution_ms is enforced after the scan
  - a snapshot reference pins every read (engine rejects non-snapshot reads
    via TRACEABILITY)
"""
from __future__ import annotations

import time
from typing import Any, Optional, Set

import pyarrow.compute as pc

from cdxr.ports import (
    DatasetProfile,
    DatasetSchema,
    DistributionProfile,
    FieldSchema,
    FieldStats,
    LineageInfo,
    TimeProfile,
    TrainingDatasetPortError,
)
from app.catalog.dataset_registry import DatasetRegistry
from app.config import LakehouseConfig, get_config

MAX_DISTRIBUTION_BINS = 50
_TIME_TYPE_MARKERS = ("timestamp", "date")


class LakehouseTrainingDatasetAdapter:
    def __init__(self, registry: DatasetRegistry,
                 config: Optional[LakehouseConfig] = None,
                 lineage=None):
        self.registry = registry
        self.config = config or get_config()
        self.lineage = lineage

    # -- public resolution (used by the API route for input validation) --

    def resolve_snapshot(self, dataset_id: str,
                         snapshot_id: Optional[int] = None) -> tuple[Any, Optional[int]]:
        """Load the table and resolve the effective snapshot id.

        Raises TrainingDatasetPortError when the dataset or the requested
        snapshot does not exist (or the catalog is unavailable).
        """
        meta = self.registry.get(dataset_id)
        if meta is None:
            raise TrainingDatasetPortError(f"dataset '{dataset_id}' not found")
        catalog = self.registry._get_catalog()  # noqa: SLF001 (same package)
        if not catalog:
            raise TrainingDatasetPortError(
                f"catalog unavailable: {self.registry.catalog_error or 'unknown'}")
        try:
            table = catalog.load_table(meta.table_name)
        except Exception as exc:
            raise TrainingDatasetPortError(
                f"cannot load table '{meta.table_name}': {type(exc).__name__}") from exc
        if snapshot_id is not None:
            known = {s.snapshot_id for s in table.snapshots()}
            if snapshot_id not in known:
                raise TrainingDatasetPortError(
                    f"snapshot {snapshot_id} not found for dataset '{dataset_id}'")
            return table, snapshot_id
        snap = table.current_snapshot()
        return table, (snap.snapshot_id if snap else None)

    # -- TrainingDatasetPort -------------------------------------------

    def get_schema(self, dataset_id: str,
                   snapshot_id: Optional[int] = None) -> Optional[DatasetSchema]:
        table, resolved = self.resolve_snapshot(dataset_id, snapshot_id)
        return DatasetSchema(
            dataset_id=dataset_id,
            snapshot_id=resolved,
            fields=tuple(
                FieldSchema(name=f.name, type=str(f.field_type))
                for f in table.schema().fields
            ),
        )

    def get_profile(self, dataset_id: str, snapshot_id: Optional[int] = None,
                    fields: Optional[list] = None) -> Optional[DatasetProfile]:
        table, resolved = self.resolve_snapshot(dataset_id, snapshot_id)
        schema_names = {f.name for f in table.schema().fields}
        names = [f for f in (fields or []) if f in schema_names]
        if not names:
            return DatasetProfile(dataset_id=dataset_id, snapshot_id=resolved,
                                  row_count=0, fields=())
        tbl = self._bounded_scan(table, resolved, names)
        row_count = tbl.num_rows
        stats = []
        for name in names:
            arr = tbl[name]
            null_count = int(arr.null_count)
            distinct = int(pc.count_distinct(arr).as_py()) \
                if null_count < arr.length() else 0
            stats.append(FieldStats(name=name, null_count=null_count,
                                    distinct_count=distinct))
        return DatasetProfile(dataset_id=dataset_id, snapshot_id=resolved,
                              row_count=row_count, fields=tuple(stats))

    def get_time_profile(self, dataset_id: str, fields: list,
                         snapshot_id: Optional[int] = None) -> tuple:
        table, resolved = self.resolve_snapshot(dataset_id, snapshot_id)
        schema_by_name = {f.name: f for f in table.schema().fields}
        names = [f for f in fields if f in schema_by_name]
        tbl = self._bounded_scan(table, resolved, names) if names else None
        profiles = []
        for field in fields:
            field_schema = schema_by_name.get(field)
            if field_schema is None:
                continue
            typ = str(field_schema.field_type).lower()
            temporal = any(m in typ for m in _TIME_TYPE_MARKERS)
            if tbl is None or field not in tbl.column_names:
                profiles.append(TimeProfile(field=field, min_value=None,
                                            max_value=None, temporal=temporal))
                continue
            arr = tbl[field]
            if arr.length() == 0 or arr.null_count == arr.length():
                profiles.append(TimeProfile(field=field, min_value=None,
                                            max_value=None, temporal=temporal))
                continue
            mn = pc.min(arr).as_py()
            mx = pc.max(arr).as_py()
            profiles.append(TimeProfile(
                field=field, min_value=str(mn), max_value=str(mx),
                temporal=temporal))
        return tuple(profiles)

    def get_value_distribution(self, dataset_id: str, field: str,
                               snapshot_id: Optional[int] = None) -> Optional[DistributionProfile]:
        table, resolved = self.resolve_snapshot(dataset_id, snapshot_id)
        if field in self.config.sensitive_fields:
            # sensitive field: never expose its values, even as counts
            return DistributionProfile(field=field, counts=None)
        schema_names = {f.name for f in table.schema().fields}
        if field not in schema_names:
            return DistributionProfile(field=field, counts=None)
        tbl = self._bounded_scan(table, resolved, [field])
        arr = tbl[field]
        if arr.length() == 0 or arr.null_count == arr.length():
            return DistributionProfile(field=field, counts={})
        vc = pc.value_counts(arr)
        counts: dict[str, int] = {}
        for i in range(len(vc)):
            value = vc.field(0)[i].as_py()
            count = int(vc.field(1)[i].as_py())
            counts[str(value)] = count
            if len(counts) >= MAX_DISTRIBUTION_BINS:
                break
        return DistributionProfile(field=field, counts=counts)

    def get_sensitive_classification(self, dataset_id: str, fields: list,
                                     snapshot_id: Optional[int] = None) -> dict:
        return {f: f in self.config.sensitive_fields for f in fields}

    def get_field_roles(self, dataset_id: str, fields: list,
                        snapshot_id: Optional[int] = None) -> dict:
        # No explicit role metadata exists in this deployment (roles would
        # come from a configured column-role catalog, not from name guessing).
        # LABEL_DERIVED_FEATURE therefore never fires here — it stays
        # deterministic and explicit, ready for deployments that carry roles.
        return {}

    def get_lineage(self, dataset_id: str,
                    snapshot_id: Optional[int] = None) -> Optional[LineageInfo]:
        if self.lineage is None:
            return None
        try:
            result = self.lineage.explain(dataset_id)
        except LookupError:
            return None
        reference = f"lineage://{dataset_id}?snapshot={snapshot_id or 'none'}"
        return LineageInfo(
            dataset_id=dataset_id,
            reference=reference,
            upstream=tuple(e.source for e in result.upstream),
        )

    # -- internals ------------------------------------------------------

    def _bounded_scan(self, table, snapshot_id: Optional[int], names: list):
        kwargs: dict[str, Any] = {}
        if snapshot_id is not None:
            kwargs["snapshot_id"] = snapshot_id
        if names:
            kwargs["selected_fields"] = names
        scan = table.scan(**kwargs)
        est_rows = sum(task.file.record_count for task in scan.plan_files())
        if est_rows > self.config.max_scan_rows:
            raise TrainingDatasetPortError(
                f"scan would read {est_rows} rows > max_scan_rows "
                f"{self.config.max_scan_rows}")
        started = time.monotonic()
        tbl = scan.to_arrow()
        elapsed = time.monotonic() - started
        if elapsed > self.config.max_execution_ms / 1000.0:
            raise TrainingDatasetPortError(
                f"scan took {elapsed:.1f}s > max_execution_ms "
                f"{self.config.max_execution_ms}")
        return tbl
