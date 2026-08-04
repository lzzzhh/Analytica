"""Deterministic fake TrainingDatasetPort for engine unit tests."""
from __future__ import annotations

from cdxr.ports import (
    DatasetProfile,
    DatasetSchema,
    DistributionProfile,
    FieldSchema,
    FieldStats,
    LineageInfo,
    TimeProfile,
)


class FakeTrainingDatasetPort:
    """Serves a fixed dataset; every method overridable per-test."""

    def __init__(self):
        self.dataset_id = "dwd.dwd_loan_events"
        self.snapshot_id = 12345
        self.row_count = 5000
        # name -> (type, null_count, distinct_count)
        self.fields: dict[str, tuple[str, int, int]] = {
            "event_id": ("long", 0, 5000),
            "event_date": ("date", 0, 900),
            "default_flag": ("string", 5, 2),
            "credit_score": ("int", 10, 900),
            "loan_amount": ("double", 0, 500),
            "customer_id": ("string", 0, 50),
        }
        self.distributions: dict[str, dict[str, int] | None] = {
            "default_flag": {"0": 4200, "1": 795},
            "event_date": None,   # unavailable — never requested by tests
        }
        self.time_profiles: dict[str, TimeProfile] = {
            "event_date": TimeProfile("event_date", "2026-01-01", "2026-06-30", temporal=True),
            "default_flag": TimeProfile("default_flag", "0", "1", temporal=False),
            "credit_score": TimeProfile("credit_score", "300", "850", temporal=False),
            "loan_amount": TimeProfile("loan_amount", "1.0", "50000.0", temporal=False),
        }
        self.sensitive: dict[str, bool] = {
            "customer_id": True,
            "event_id": False,
            "event_date": False,
            "default_flag": False,
            "credit_score": False,
            "loan_amount": False,
        }
        self.roles: dict[str, set[str]] = {}
        self.lineage = LineageInfo(
            dataset_id=self.dataset_id,
            reference="lineage://dwd.dwd_loan_events?snapshot=12345",
            upstream=("ods.ods_loan_events",),
        )
        # failure injection
        self.raise_on: set[str] = set()   # method names to raise inside

    def _maybe_raise(self, method: str):
        if method in self.raise_on:
            raise RuntimeError(f"injected failure in {method}")

    def get_schema(self, dataset_id: str, snapshot_id: int | None = None) -> DatasetSchema:
        self._maybe_raise("get_schema")
        return DatasetSchema(
            dataset_id=dataset_id,
            snapshot_id=self.snapshot_id if snapshot_id is None else snapshot_id,
            fields=tuple(
                FieldSchema(name=name, type=typ)
                for name, (typ, _null, _distinct) in sorted(self.fields.items())
            ),
        )

    def get_profile(self, dataset_id: str, snapshot_id: int | None = None,
                    fields: list[str] | None = None) -> DatasetProfile:
        self._maybe_raise("get_profile")
        names = fields or list(self.fields)
        stats = tuple(
            FieldStats(name=f, null_count=self.fields[f][1], distinct_count=self.fields[f][2])
            for f in names if f in self.fields
        )
        return DatasetProfile(
            dataset_id=dataset_id,
            snapshot_id=self.snapshot_id,
            row_count=self.row_count,
            fields=stats,
        )

    def get_time_profile(self, dataset_id: str, fields: list[str],
                         snapshot_id: int | None = None) -> tuple[TimeProfile, ...]:
        self._maybe_raise("get_time_profile")
        return tuple(self.time_profiles[f] for f in fields if f in self.time_profiles)

    def get_value_distribution(self, dataset_id: str, field: str,
                               snapshot_id: int | None = None) -> DistributionProfile:
        self._maybe_raise("get_value_distribution")
        return DistributionProfile(field=field, counts=self.distributions.get(field))

    def get_sensitive_classification(self, dataset_id: str, fields: list[str],
                                     snapshot_id: int | None = None) -> dict[str, bool]:
        self._maybe_raise("get_sensitive_classification")
        return {f: self.sensitive.get(f, False) for f in fields}

    def get_field_roles(self, dataset_id: str, fields: list[str],
                        snapshot_id: int | None = None) -> dict[str, set[str]]:
        self._maybe_raise("get_field_roles")
        return {f: set(self.roles.get(f, ())) for f in fields}

    def get_lineage(self, dataset_id: str, snapshot_id: int | None = None) -> LineageInfo | None:
        self._maybe_raise("get_lineage")
        return self.lineage
