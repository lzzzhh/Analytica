"""Explicit assessment thresholds — the engine never hardcodes rule limits."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AssessmentConfig:
    # SAMPLE_SIZE
    min_sample_rows: int = 1000
    # TARGET_DISTRIBUTION
    target_missing_threshold: float = 0.5       # missing label rate
    min_positive_ratio: float = 0.05            # minority class ratio (binary)
    # FEATURE_MISSINGNESS
    feature_missing_threshold: float = 0.2
    # LABEL_DERIVED_FEATURE: the explicit role marker (port-provided, never
    # inferred from field names)
    label_derived_role: str = "label_derived"
