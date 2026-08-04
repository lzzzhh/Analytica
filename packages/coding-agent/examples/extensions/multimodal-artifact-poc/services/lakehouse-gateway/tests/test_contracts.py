"""Contract tests — JSON Schema datasetId patterns (review round-4.1 P4).

Formal datasetId is `namespace.table` (e.g. ads.model_metrics); a short id is
only ever an alias resolved when globally unique. The schema pattern must
reject leading/trailing/duplicate dots and uppercase segments.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"

VALID_DATASET_IDS = [
    "ads.model_metrics",
    "dws.feature_values",
    "model_metrics",  # un-namespaced still allowed by the pattern
]

INVALID_DATASET_IDS = [
    ".ads",              # leading dot
    "ads.",              # trailing dot
    "ADS.model_metrics",  # uppercase segment
    "ads..model_metrics",  # duplicate separator
]


@pytest.mark.parametrize("schema_file", ["dataset.schema.json", "query-plan.schema.json"])
def test_dataset_id_pattern(schema_file: str):
    schema = json.loads((CONTRACTS / schema_file).read_text())
    pattern = schema["properties"]["datasetId"]["pattern"]
    rx = re.compile(pattern)
    for ds in VALID_DATASET_IDS:
        assert rx.fullmatch(ds), f"{ds!r} should match {pattern!r}"
    for ds in INVALID_DATASET_IDS:
        assert not rx.fullmatch(ds), f"{ds!r} should NOT match {pattern!r}"
