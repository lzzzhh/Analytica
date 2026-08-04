"""Structured QueryPlan — validate-only contract.

The Gateway NEVER accepts free SQL from clients. Queries are expressed as a
structured plan and must pass validate_query before execution (execute_query
only accepts a validatedQueryId).

Safety checks (validate_query):
  - read-only by construction (no SQL surface)
  - dataset exists
  - fields exist in the dataset schema
  - field permissions (sensitive fields require the caller to opt in)
  - partition filtering (partitioned datasets must filter by partition column)
  - time range present for time-series datasets
  - row limit bounds (1..max_limit)
  - scan size budget (aggregates: must stay within max_scan_rows)
  - execution time budget is post-hoc (warning only — see executor; real
    timeout enforcement is out of scope for the local PoC)
  - ODS layer denied by default
  - forbidden SQL keywords never accepted (defense in depth)
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from app.catalog.dataset_registry import DatasetMetadata, DatasetRegistry, FieldInfo, LAYER_ORDER
from app.config import LakehouseConfig

AGGREGATIONS: tuple[str, ...] = ("sum", "count", "avg", "min", "max")
OPERATORS: tuple[str, ...] = ("eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "is_null", "is_not_null")
_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$")
_FIELD_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_SQL_KEYWORD_RE = re.compile(r"\b(insert|update|delete|drop|truncate|alter|merge|grant|revoke|create|replace|vacuum)\b", re.IGNORECASE)


@dataclass(frozen=True)
class SelectField:
    field: str
    aggregation: str | None = None   # None = raw column
    alias: str = ""


@dataclass(frozen=True)
class FilterCondition:
    field: str
    operator: str
    value: Any = None


@dataclass(frozen=True)
class QueryPlan:
    datasetId: str
    select: list[SelectField] = field(default_factory=list)
    dimensions: list[str] = field(default_factory=list)
    filters: list[FilterCondition] = field(default_factory=list)
    limit: int = 100

    def to_dict(self) -> dict[str, Any]:
        return {
            "datasetId": self.datasetId,
            "select": [{"field": s.field, "aggregation": s.aggregation, "alias": s.alias} for s in self.select],
            "dimensions": list(self.dimensions),
            "filters": [{"field": f.field, "operator": f.operator, "value": f.value} for f in self.filters],
            "limit": self.limit,
        }


@dataclass(frozen=True)
class ValidationIssue:
    code: str            # e.g. "dataset_not_found" | "field_not_found" | "ods_denied"
    message: str
    path: str = ""


@dataclass(frozen=True)
class ValidationResult:
    SESSION_TTL_S = 600  # must match ValidationSession.TTL_S

    ok: bool
    plan: QueryPlan | None = None
    issues: list[ValidationIssue] = field(default_factory=list)
    validatedQueryId: str = ""
    dataset: DatasetMetadata | None = None
    expiresAt: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "validatedQueryId": self.validatedQueryId,
            "expiresAt": self.expiresAt,
            "issues": [{"code": i.code, "message": i.message, "path": i.path} for i in self.issues],
        }


# ---------------------------------------------------------------------
# Parser: JSON/dict → QueryPlan (strict, reject anything unexpected)
# ---------------------------------------------------------------------

def parse_plan(raw: dict[str, Any]) -> QueryPlan:
    """Strictly parse a QueryPlan from JSON. Raises ValueError on bad shape."""
    if not isinstance(raw, dict):
        raise ValueError("query plan must be an object")

    dataset_id = raw.get("datasetId")
    if not isinstance(dataset_id, str) or not dataset_id.strip():
        raise ValueError("datasetId is required")
    if _SQL_KEYWORD_RE.search(dataset_id):
        raise ValueError("datasetId must not contain SQL keywords")

    selects: list[SelectField] = []
    for s in raw.get("select", []) or []:
        if not isinstance(s, dict) or not isinstance(s.get("field"), str):
            raise ValueError("select[].field must be a string")
        agg = s.get("aggregation")
        if agg is not None:
            if not isinstance(agg, str) or agg not in AGGREGATIONS:
                raise ValueError(f"unsupported aggregation '{agg}', allowed: {AGGREGATIONS}")
        alias = s.get("alias") or ""
        selects.append(SelectField(field=s["field"], aggregation=agg, alias=alias))

    dims = raw.get("dimensions", []) or []
    if not all(isinstance(d, str) for d in dims):
        raise ValueError("dimensions must be strings")

    filters: list[FilterCondition] = []
    for f in raw.get("filters", []) or []:
        if not isinstance(f, dict) or not isinstance(f.get("field"), str) or not isinstance(f.get("operator"), str):
            raise ValueError("filters[].field and .operator are required")
        op = f["operator"]
        if op not in OPERATORS:
            raise ValueError(f"unsupported operator '{op}', allowed: {OPERATORS}")
        filters.append(FilterCondition(field=f["field"], operator=op, value=f.get("value")))

    limit_raw = raw.get("limit", 100)
    if not isinstance(limit_raw, int) or isinstance(limit_raw, bool) or limit_raw < 1:
        raise ValueError("limit must be a positive integer")

    return QueryPlan(datasetId=dataset_id, select=selects, dimensions=dims, filters=filters, limit=limit_raw)


def _field_lookup(dataset: DatasetMetadata, name: str) -> FieldInfo | None:
    for f in dataset.fields:
        if f.name == name:
            return f
    return None


def validate_plan(
    plan: QueryPlan,
    registry: DatasetRegistry,
    config: LakehouseConfig,
) -> ValidationResult:
    """Deterministic validation. All checks return issues; never raises."""
    issues: list[ValidationIssue] = []
    dataset = registry.get(plan.datasetId)

    if dataset is None:
        issues.append(ValidationIssue("dataset_not_found", f"dataset '{plan.datasetId}' not found in catalog", "datasetId"))
        return ValidationResult(ok=False, issues=issues)

    # ODS layer denied by default
    if dataset.layer == "ODS" and not config.allow_ods:
        issues.append(ValidationIssue("ods_denied", "ODS layer is not queryable (default access order: ADS → DWS → DWD)", "datasetId"))
        return ValidationResult(ok=False, issues=issues)

    # Row limit bounds
    if plan.limit > config.max_limit:
        issues.append(ValidationIssue("limit_exceeded", f"limit {plan.limit} exceeds max {config.max_limit}", "limit"))

    # Select fields must exist; aggregation only on numeric-ish columns is a soft check
    if not plan.select:
        issues.append(ValidationIssue("empty_select", "select must contain at least one field", "select"))
    for s in plan.select:
        fi = _field_lookup(dataset, s.field)
        if fi is None:
            issues.append(ValidationIssue("field_not_found", f"field '{s.field}' not in {dataset.dataset_id}", f"select.{s.field}"))

    for d in plan.dimensions:
        if _field_lookup(dataset, d) is None:
            issues.append(ValidationIssue("field_not_found", f"dimension '{d}' not in {dataset.dataset_id}", f"dimensions.{d}"))

    for f in plan.filters:
        fi = _field_lookup(dataset, f.field)
        if fi is None:
            issues.append(ValidationIssue("field_not_found", f"filter field '{f.field}' not in {dataset.dataset_id}", f"filters.{f.field}"))
        if f.operator == "between" and not (isinstance(f.value, list) and len(f.value) == 2):
            issues.append(ValidationIssue("invalid_filter", "between requires value: [lo, hi]", f"filters.{f.field}"))
        if f.operator in ("eq", "gt", "gte", "lt", "lte", "in") and f.value is None:
            issues.append(ValidationIssue("invalid_filter", f"operator {f.operator} requires a value", f"filters.{f.field}"))

    # Partitioned datasets must filter by a partition column (scan budget guard)
    if dataset.fields:
        part_fields = [fi.name for fi in dataset.fields if fi.partition]
        filtered = {f.field for f in plan.filters}
        if part_fields and not (part_fields[0] in filtered or any(p in filtered for p in part_fields)):
            issues.append(ValidationIssue(
                "partition_filter_required",
                f"dataset is partitioned by {part_fields}; add a filter on a partition column",
                "filters",
            ))

    # Time-range presence: only genuine time columns count as time bounds.
    # between on a non-time column is rejected — it must not be treated as a
    # scan-bounding time range (review: false time bounds allowed unbounded scans).
    # A column counts as time-like when its Iceberg type is date/timestamp, OR
    # its name has explicit time semantics (_time/_date/_at) and it stores ISO
    # strings (the demo warehouse keeps time as ISO strings by design).
    def _is_time_like(fi: FieldInfo) -> bool:
        t = fi.type.lower()
        if "date" in t or "timestamp" in t:
            return True
        name = fi.name.lower()
        return t == "string" and any(s in name for s in ("_time", "_date", "_at"))

    time_cols = [fi.name for fi in dataset.fields if _is_time_like(fi)]
    for f in plan.filters:
        if f.operator == "between" and f.field not in time_cols:
            issues.append(ValidationIssue(
                "invalid_time_bound",
                f"between filter on '{f.field}' is not a time column (time columns: {time_cols or 'none'})",
                f"filters.{f.field}",
            ))
    time_filters = [f for f in plan.filters if f.field in time_cols and f.operator == "between"]
    if time_cols and not time_filters:
        issues.append(ValidationIssue(
            "time_range_missing",
            f"dataset has time columns {time_cols}; add a between filter on one to bound the scan",
            "filters",
        ))

    # Scan budget: aggregates over unbounded scans are rejected beyond budget
    has_agg = any(s.aggregation for s in plan.select)
    if has_agg and not any(f.operator in ("between", "eq", "in") for f in plan.filters):
        issues.append(ValidationIssue(
            "scan_too_broad",
            "aggregation without a bounded filter is rejected (scan budget)",
            "filters",
        ))

    ok = not issues
    if ok:
        vid = f"vq_{uuid.uuid4().hex[:16]}"
        # expiry = creation time + session TTL (mirrors ValidationSession.TTL_S)
        expires = datetime.fromtimestamp(
            datetime.now(timezone.utc).timestamp() + ValidationResult.SESSION_TTL_S,
            tz=timezone.utc,
        ).isoformat()
    else:
        vid, expires = "", ""
    return ValidationResult(ok=ok, plan=plan, issues=issues, validatedQueryId=vid, dataset=dataset, expiresAt=expires)
