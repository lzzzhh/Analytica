"""Rule context shared by all rule modules.

A RuleContext carries everything a rule may need, pre-fetched and bounded by
the engine (see cdxr.engine). Rules are pure functions: given the context
they return a deterministic list of findings, and they never raise (any
data-fetch failure is surfaced earlier as a rule-error finding).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Set

from cdxr.config import AssessmentConfig
from cdxr.contracts import TrainingAssessmentRequest
from cdxr.ports import DatasetProfile, DatasetSchema, DistributionProfile, LineageInfo, TimeProfile


@dataclass(frozen=True)
class RuleContext:
    request: TrainingAssessmentRequest
    schema: DatasetSchema
    config: AssessmentConfig
    table_ref: str                                   # evidence reference base
    profile: Optional[DatasetProfile] = None
    sensitive: Dict[str, bool] = None                # field -> is_sensitive
    roles: Dict[str, Set[str]] = None                # field -> role markers
    time_profiles: Dict[str, TimeProfile] = None     # field -> profile
    distributions: Dict[str, Optional[DistributionProfile]] = None
    lineage: Optional[LineageInfo] = None
    warnings: list = None                            # engine-level notes
