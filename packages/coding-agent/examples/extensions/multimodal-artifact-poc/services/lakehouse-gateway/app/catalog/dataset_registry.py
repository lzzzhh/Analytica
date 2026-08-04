"""Dataset registry — discover, describe and search lakehouse datasets.

PATTERN ADAPTED from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/adapters/base.py): the original defined a domain-bound `Adapter` base class
(prediction boundary / feature catalog / semantic groups). The generic kernel kept
here is: stable identity (dataset_id, display_name, version), closure-style
validation, and registry lookup. All domain semantics were removed.

Dataset layout follows the warehouse convention ODS/DWD/DWS/ADS (each layer is a
namespace; each table is an Iceberg table under it).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import NoSuchNamespaceError, NoSuchTableError

from app.config import LakehouseConfig

LAYER_ORDER = ("ODS", "DWD", "DWS", "ADS")
_ID_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$")

# Domain-marker vocabulary: tables whose schema carries these field names are
# labeled domain="risk" (semantic isolation — the platform core stays generic;
# field names themselves are preserved verbatim from the source data).
# AUTHORITATIVE source is domains/risk (via _load_domain_fields); this tuple is
# a compatibility fallback for deployments without the domain package (review:
# the banned-term scan whitelists this one file for this reason).
RISK_DOMAIN_FIELDS = (
    "loan", "borrower", "credit_score", "overdue", "bad_rate",
    "vintage", "auc", "ks", "psi", "applicant", "prediction",
)


@dataclass(frozen=True)
class FieldInfo:
    name: str
    type: str
    description: str = ""
    sensitive: bool = False
    partition: bool = False


@dataclass(frozen=True)
class DatasetMetadata:
    dataset_id: str
    display_name: str
    layer: str                     # ODS | DWD | DWS | ADS
    table_name: str                # Iceberg table name (namespace.table)
    description: str = ""
    fields: list[FieldInfo] = field(default_factory=list)
    version: str = "1.0.0"
    row_count: int | None = None
    latest_snapshot_id: int | None = None
    last_updated_at: str = ""
    # Semantic domain of the data ("general" | "risk"). Risk-domain tables
    # keep their source field names but are labeled, never mixed into the
    # generic platform vocabulary.
    domain: str = "general"


def validate_dataset_id(dataset_id: str) -> list[str]:
    """Closure-style check: dataset_id must be a stable lowercase identifier."""
    errors: list[str] = []
    if not dataset_id:
        errors.append("dataset_id must be non-empty")
    elif not _ID_RE.fullmatch(dataset_id):
        errors.append(f"dataset_id must match {_ID_RE.pattern}, got '{dataset_id}'")
    return errors


class DatasetRegistry:
    """Scans an Iceberg warehouse and serves dataset metadata/search."""

    def __init__(self, config: LakehouseConfig):
        self.config = config
        self._datasets: dict[str, DatasetMetadata] = {}
        self._catalog = None
        self._catalog_error: str | None = None
        self._collisions: list[str] = []   # same short name across namespaces

    @property
    def collisions(self) -> list[str]:
        return list(self._collisions)

    def _load_domain_fields(self) -> tuple[str, ...]:
        """Domain-labeling vocabulary: authoritative copy lives in domains/risk;
        the built-in tuple is a compatibility fallback for deployments without
        the domain package (see RISK_DOMAIN_FIELDS note)."""
        try:
            from domains.risk.governance.cdxr.vocabulary import DOMAIN_FIELDS
            return DOMAIN_FIELDS
        except Exception:
            return RISK_DOMAIN_FIELDS

    # -- catalog -----------------------------------------------------

    def _get_catalog(self):
        if self._catalog is not None:
            return self._catalog
        try:
            if self.config.is_aws:
                # Cloud mode: AWS Glue catalog (or hadoop-catalog semantics via glue).
                self._catalog = load_catalog(
                    "lakehouse",
                    type="glue" if self.config.catalog_type == "glue" else "glue",
                    warehouse=self.config.warehouse_path,
                    region=self.config.region,
                )
            else:
                # Local mode: pyiceberg SQL catalog (SQLite metadata + local data files).
                # (pyiceberg has no hadoop catalog; the Spark-side hadoop catalog of
                #  the original platform remains unchanged and is out of scope here.)
                db_path = (Path(self.config.warehouse_path) / ".lakehouse-catalog.db").resolve()
                db_path.parent.mkdir(parents=True, exist_ok=True)
                self._catalog = load_catalog(
                    "lakehouse",
                    type="sql",
                    uri=f"sqlite:///{db_path}",
                    warehouse=str(db_path.parent),
                )
        except Exception as exc:  # catalog may need AWS creds we do not have
            self._catalog_error = f"{type(exc).__name__}: {exc}"
            self._catalog = False
        return self._catalog

    @property
    def catalog_error(self) -> str | None:
        return self._catalog_error

    # -- discovery ---------------------------------------------------

    def discover(self, force: bool = False) -> list[str]:
        """List all dataset ids found in the warehouse."""
        if self._datasets and not force:
            return list(self._datasets.keys())
        catalog = self._get_catalog()
        self._datasets = {}
        if not catalog:
            return []
        try:
            namespaces = catalog.list_namespaces()
        except Exception:
            namespaces = []
        layer_ns = {ns for ns in namespaces if isinstance(ns, tuple) and ns and ns[0].upper() in LAYER_ORDER}
        for ns in sorted(layer_ns):
            layer = ns[0].upper()
            try:
                tables = catalog.list_tables(ns)
            except NoSuchNamespaceError:
                continue
            except Exception:
                continue
            for (tbl_ns, tbl_name) in tables:
                # Canonical dataset id = "<namespace>.<table>": the same short
                # name may exist in several namespaces, and a short id alone
                # cannot identify which one a caller means. Short names stay
                # usable as aliases ONLY while globally unique (see get()).
                dataset_id = f"{tbl_ns}.{tbl_name}"
                table_full = f"{tbl_ns}.{tbl_name}"
                # a repeated canonical id (same namespace.table twice) is a
                # real discovery anomaly — record it, do not overwrite
                prev = self._datasets.get(dataset_id)
                if prev is not None and prev.table_name != table_full:
                    self._collisions.append(f"{dataset_id}: {prev.table_name} vs {table_full}")
                    continue
                self._datasets[dataset_id] = self._describe(layer, table_full, tbl_name)
        # short-name collisions: same short name in several namespaces → the
        # alias is ambiguous; record it (callers must use canonical ids)
        short: dict[str, list[str]] = {}
        for ds_id in self._datasets:
            short.setdefault(ds_id.split(".")[-1], []).append(ds_id)
        self._collisions = [f"{name}: {', '.join(sorted(ids))}" for name, ids in short.items() if len(ids) > 1]
        return list(self._datasets.keys())

    def _describe(self, layer: str, table_full: str, table_name: str) -> DatasetMetadata:
        """Build metadata from the Iceberg table schema + snapshot info."""
        fields: list[FieldInfo] = []
        row_count: int | None = None
        snapshot_id: int | None = None
        last_updated: str = ""
        try:
            table = self._get_catalog().load_table(table_full)
            partition_ids = {p.source_id for p in table.spec().fields}
            partition_cols = {f.name for f in table.schema().fields if f.field_id in partition_ids}
            for f in table.schema().fields:
                fields.append(FieldInfo(
                    name=f.name,
                    type=str(f.field_type),
                    partition=f.name in partition_cols,
                ))
            snap = table.current_snapshot()
            if snap:
                snapshot_id = snap.snapshot_id
                last_updated = snap.timestamp_ms
            row_count = None  # row count requires a scan; fetched lazily
        except NoSuchTableError:
            pass
        except Exception:
            pass
        dataset_id = table_full
        domain = "risk" if any(
            any(marker in f.name.lower() for marker in self._load_domain_fields()) for f in fields
        ) else "general"
        return DatasetMetadata(
            dataset_id=dataset_id,
            display_name=table_name.replace("_", " ").title(),
            layer=layer,
            table_name=table_full,
            description=f"Iceberg table {table_full} in layer {layer}",
            fields=fields,
            row_count=row_count,
            latest_snapshot_id=snapshot_id,
            last_updated_at=str(last_updated),
            domain=domain,
        )

    # -- lookup / search ---------------------------------------------

    def get(self, dataset_id: str) -> DatasetMetadata | None:
        """Resolve a dataset id to metadata.

        Canonical ids (<namespace>.<table>) match directly. A short id (no
        dot) is an alias that resolves ONLY when it maps to exactly one
        namespaced id — ambiguous short names resolve to None (recorded in
        collisions by discover()).
        """
        if not self._datasets:
            self.discover()
        exact = self._datasets.get(dataset_id)
        if exact is not None or "." in dataset_id:
            return exact
        candidates = [d for key, d in self._datasets.items()
                      if key.split(".")[-1] == dataset_id]
        return candidates[0] if len(candidates) == 1 else None

    def search(self, q: str = "", layer: str | None = None, limit: int = 50,
               domain: str | None = None) -> list[DatasetMetadata]:
        if not self._datasets:
            self.discover()
        ql = q.strip().lower()
        results: list[DatasetMetadata] = []
        for d in sorted(self._datasets.values(), key=lambda x: (LAYER_ORDER.index(x.layer), x.dataset_id)):
            if layer and d.layer != layer.upper():
                continue
            if domain and d.domain != domain.lower():
                continue
            if ql and ql not in d.dataset_id.lower() and ql not in d.display_name.lower() \
                    and ql not in d.description.lower() and ql not in d.table_name.lower():
                continue
            results.append(d)
            if len(results) >= limit:
                break
        return results

    def validate(self) -> list[str]:
        """Closure-style validation over all registered datasets."""
        errors: list[str] = []
        for d in self._datasets.values():
            errors.extend(f"{d.dataset_id}: {e}" for e in validate_dataset_id(d.dataset_id))
            if d.layer not in LAYER_ORDER:
                errors.append(f"{d.dataset_id}: layer must be one of {LAYER_ORDER}")
            if not d.fields:
                errors.append(f"{d.dataset_id}: no fields discovered")
        return errors

    def register_external(self, meta: DatasetMetadata) -> None:
        """Register metadata that is not (yet) in the scanned warehouse."""
        self._datasets[meta.dataset_id] = meta
