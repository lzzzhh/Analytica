"""Data profiling models — deterministic, LLM-free data quality descriptors.

MIGRATED from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/agents/contracts/models.py — classes ColumnProfileV1 / TableProfileV1 /
DatasetProfileV1 extracted verbatim). The source file mixed these generic profile
models with the project's own agent-state-machine models; only the profile models
were extracted here. No field changes.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ColumnProfileV1(BaseModel):
    column_name: str = ""
    physical_type: str = ""
    logical_type_candidates: list[str] = Field(default_factory=list)
    missing_rate: float = 0.0
    unique_rate: float = 0.0
    value_patterns: list[str] = Field(default_factory=list)
    masked_samples: list[str] = Field(default_factory=list)
    min_value: float | None = None
    max_value: float | None = None
    distinct_count: int = 0


class TableProfileV1(BaseModel):
    table_id: str = ""
    row_count: int = 0
    columns: list[ColumnProfileV1] = Field(default_factory=list)
    candidate_keys: list[list[str]] = Field(default_factory=list)
    candidate_time_columns: list[str] = Field(default_factory=list)
    sample_rows_json: list[dict[str, Any]] = Field(default_factory=list)


class DatasetProfileV1(BaseModel):
    contract_version: str = "dataset-profile.v1"
    dataset_id: str = ""
    source_type: str = "structured"
    content_hash: str = ""
    tables: list[TableProfileV1] = Field(default_factory=list)
    relation_candidates: list[dict[str, Any]] = Field(default_factory=list)
    user_hints: dict[str, Any] = Field(default_factory=dict)
