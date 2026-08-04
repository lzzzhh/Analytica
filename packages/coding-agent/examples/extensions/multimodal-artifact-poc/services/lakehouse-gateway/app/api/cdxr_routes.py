"""CDXR training-assessment API (on-demand, single endpoint).

POST /v1/cdxr/training-assessments runs the cdxr-engine assessment for the
requested dataset/snapshot and returns a deterministic suitability verdict.
It never writes governance state, never returns raw rows, and is never
invoked by normal query execution (no scan, no startup hook).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.api.guard import _require
from app.features import get_default_resolver
from app.integrations.cdxr_lakehouse_adapter import LakehouseTrainingDatasetAdapter
from app.security.guard import AuditLog, RateLimiter
from cdxr.contracts import (
    TrainingAssessmentRequest as EngineRequest,
    TrainingAssessmentResult,
    ValidationStrategy,
)
from cdxr.engine import RULE_FEATURE_MAP, run_assessment
from cdxr.ports import TrainingDatasetPortError

router = APIRouter()

# Dependency container (wired from main.py — same pattern as routes.py).
_DEPS: dict[str, object] = {}


def _wire(adapter: LakehouseTrainingDatasetAdapter, limiter=None, audit=None) -> None:
    _DEPS["adapter"] = adapter
    if limiter is not None:
        _DEPS["limiter"] = limiter
    if audit is not None:
        _DEPS["audit"] = audit


def _adapter() -> LakehouseTrainingDatasetAdapter:
    return _DEPS["adapter"]  # type: ignore[return-value]


def _guard(request: Request) -> str:
    """Rate-limit guard shared with the query and governance APIs."""
    if "limiter" not in _DEPS:
        return request.client.host if request.client else "unknown"
    client = request.headers.get("x-client-id",
                                 request.client.host if request.client else "unknown")
    ok, _remaining = _DEPS["limiter"].allow(client)  # type: ignore[operator]
    if not ok:
        if "audit" in _DEPS:
            _DEPS["audit"].record("rate_limited", client=client)  # type: ignore[attr-defined]
        raise HTTPException(429, "rate limit exceeded")
    return client


class _TrainingWindowModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: str
    end: str


class _ValidationStrategyModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str
    field: Optional[str] = None
    cutoff: Optional[str] = None


class TrainingAssessmentRequestModel(BaseModel):
    """Request contract — strictly typed: no SQL, no arbitrary expressions
    (extra fields are rejected with 422), no free-form strings besides the
    documented field names."""
    model_config = ConfigDict(extra="forbid")

    datasetId: str
    targetField: str
    featureFields: list[str] = Field(min_length=1)
    snapshotId: Optional[int] = None
    purpose: str = "model_training"
    entityIdFields: Optional[list[str]] = None
    predictionTimeField: Optional[str] = None
    labelTimeField: Optional[str] = None
    trainingWindow: Optional[_TrainingWindowModel] = None
    validationStrategy: Optional[_ValidationStrategyModel] = None
    sensitiveFieldPolicy: str = "review"


def _to_engine_request(body: TrainingAssessmentRequestModel) -> EngineRequest:
    strategy = None
    if body.validationStrategy is not None:
        strategy = ValidationStrategy(
            type=body.validationStrategy.type,
            field=body.validationStrategy.field,
            cutoff=body.validationStrategy.cutoff,
        )
    return EngineRequest(
        dataset_id=body.datasetId,
        target_field=body.targetField,
        feature_fields=list(body.featureFields),
        snapshot_id=body.snapshotId,
        purpose=body.purpose,
        entity_id_fields=list(body.entityIdFields) if body.entityIdFields else None,
        prediction_time_field=body.predictionTimeField,
        label_time_field=body.labelTimeField,
        training_window=None,
        validation_strategy=strategy,
        sensitive_field_policy=body.sensitiveFieldPolicy,
    )


def _to_dict(result: TrainingAssessmentResult) -> dict:
    return {
        "assessmentId": result.assessment_id,
        "datasetId": result.dataset_id,
        "snapshotId": result.snapshot_id,
        "purpose": result.purpose,
        "status": result.status,
        "summary": result.summary,
        "checkedFields": result.checked_fields,
        "ruleVersion": result.rule_version,
        "checkedAt": result.checked_at,
        "rawRowsReturned": result.raw_rows_returned,
        "warnings": result.warnings,
        "checkedRules": result.checked_rules,
        "disabledRules": result.disabled_rules,
        "findings": [
            {
                "code": f.code,
                "severity": f.severity,
                "field": f.field,
                "relatedFields": f.related_fields,
                "message": f.message,
                "observed": f.observed,
                "expected": f.expected,
                "evidenceReference": f.evidence_reference,
                "recommendation": f.recommendation,
            }
            for f in result.findings
        ],
    }


@router.post("/v1/cdxr/training-assessments")
@_require("round3.cdxr_training")
async def create_training_assessment(body: TrainingAssessmentRequestModel,
                                     request: Request):
    client = _guard(request)
    adapter = _adapter()

    # input validation: dataset must exist, snapshot must exist
    try:
        _table, resolved_snapshot = adapter.resolve_snapshot(body.datasetId,
                                                             body.snapshotId)
    except TrainingDatasetPortError as exc:
        message = str(exc)
        if "not found" in message and "snapshot" not in message:
            raise HTTPException(404, message) from exc
        raise HTTPException(400, message) from exc

    engine_request = _to_engine_request(body)

    # Feature-driven rule gating: round3.cdxr_* features map to rule ids
    # (RULE_FEATURE_MAP). Disabled rules do not run and appear in
    # disabledRules — they are never reported as PASS.
    features = get_default_resolver()
    enabled_rules = {
        rule_id
        for feature_id, rule_ids in RULE_FEATURE_MAP.items()
        if features.is_effective(feature_id)
        for rule_id in rule_ids
    }
    result = run_assessment(engine_request, adapter, enabled_rules=enabled_rules)

    if "audit" in _DEPS:
        # structured metadata only — never raw rows or sensitive values
        _DEPS["audit"].record(  # type: ignore[attr-defined]
            "cdxr_training_assessment",
            client=client,
            assessment_id=result.assessment_id,
            dataset_id=result.dataset_id,
            snapshot_id=result.snapshot_id,
            status=result.status,
            finding_count=len(result.findings),
        )
    return _to_dict(result)
