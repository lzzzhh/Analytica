"""TrainingDatasetPort — the only interface the cdxr-engine core depends on.

Implementations live outside the engine (e.g. the lakehouse gateway adapter)
and are responsible for bounding scans, applying snapshot/time limits and
never returning raw row values: carriers below only transport aggregates.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol, Tuple, Dict, Set, List

from cdxr.contracts import TrainingAssessmentRequest


@dataclass(frozen=True)
class FieldSchema:
    name: str
    type: str


@dataclass(frozen=True)
class DatasetSchema:
    dataset_id: str
    snapshot_id: Optional[int]
    fields: Tuple[FieldSchema, ...]


@dataclass(frozen=True)
class FieldStats:
    name: str
    null_count: Optional[int]
    distinct_count: Optional[int]


@dataclass(frozen=True)
class DatasetProfile:
    dataset_id: str
    snapshot_id: Optional[int]
    row_count: Optional[int]
    fields: Tuple[FieldStats, ...]


@dataclass(frozen=True)
class TimeProfile:
    field: str
    min_value: Optional[str]
    max_value: Optional[str]
    temporal: bool        # field has time semantics (date/timestamp); only
                          # temporal fields participate in future-info checks


@dataclass(frozen=True)
class DistributionProfile:
    field: str
    counts: Optional[Dict[str, int]]   # bounded value->count map; None when
                                       # unavailable (e.g. sensitive field)


@dataclass(frozen=True)
class LineageInfo:
    dataset_id: str
    reference: str                       # traceable provenance reference
    upstream: Tuple[str, ...] = ()


class TrainingDatasetPort(Protocol):
    """Read-only, aggregate-only access to a training candidate dataset."""

    def get_schema(self, dataset_id: str, snapshot_id: Optional[int] = None) -> Optional[DatasetSchema]:
        """Resolve dataset + snapshot; None when the snapshot is unknown."""

    def get_profile(self, dataset_id: str, snapshot_id: Optional[int] = None,
                    fields: Optional[List[str]] = None) -> Optional[DatasetProfile]:
        """Row count + per-field null/distinct counts (aggregates only)."""

    def get_time_profile(self, dataset_id: str, fields: List[str],
                         snapshot_id: Optional[int] = None) -> Tuple[TimeProfile, ...]:
        """Min/max per field; temporal=True only for date/timestamp-like fields."""

    def get_value_distribution(self, dataset_id: str, field: str,
                               snapshot_id: Optional[int] = None) -> Optional[DistributionProfile]:
        """Bounded value->count map; None when unavailable or sensitive."""

    def get_sensitive_classification(self, dataset_id: str, fields: List[str],
                                     snapshot_id: Optional[int] = None) -> Dict[str, bool]:
        """Explicit sensitivity classification per field (never guessed)."""

    def get_field_roles(self, dataset_id: str, fields: List[str],
                        snapshot_id: Optional[int] = None) -> Dict[str, Set[str]]:
        """Explicit role markers per field (e.g. {'label_derived'}); empty
        when the deployment carries no explicit role metadata. The engine
        never infers roles from field names."""

    def get_lineage(self, dataset_id: str, snapshot_id: Optional[int] = None) -> Optional[LineageInfo]:
        """Provenance reference for traceability."""


class TrainingDatasetPortError(Exception):
    """Raised by port implementations when data cannot be read (limits,
    catalog failures, timeout). The engine converts this into a rule-error
    finding -> INSUFFICIENT_EVIDENCE."""
