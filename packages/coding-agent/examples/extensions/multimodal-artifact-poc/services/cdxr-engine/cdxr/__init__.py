"""cdxr-engine: on-demand training-data suitability assessment.

The engine core (this package) is dependency-free by design: no FastAPI,
no gateway APIs, no catalogs, no governance stores. It talks to the outside
world only through cdxr.ports.TrainingDatasetPort.
"""
from cdxr.config import AssessmentConfig
from cdxr.contracts import (
    AssessmentStatus,
    TrainingAssessmentFinding,
    TrainingAssessmentRequest,
    TrainingAssessmentResult,
)
from cdxr.engine import run_assessment

__all__ = [
    "AssessmentConfig",
    "AssessmentStatus",
    "TrainingAssessmentFinding",
    "TrainingAssessmentRequest",
    "TrainingAssessmentResult",
    "run_assessment",
]
