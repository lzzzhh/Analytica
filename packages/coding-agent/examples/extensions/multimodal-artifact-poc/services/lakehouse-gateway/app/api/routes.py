"""Query Gateway API — read-only endpoints (spec §6).

Feature-gated: every endpoint maps to a round2.* feature. When the feature
is not effective the endpoint answers 404 (FEATURE_DISABLED) without running
any internal logic. The resolver is the single feature authority
(app/features.py); no env reads here.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.guard import _require
from app.catalog.dataset_registry import DatasetRegistry
from app.config import LakehouseConfig
from app.features import get_default_resolver
from app.lineage.lineage import LineageRegistry
from app.query.executor import QueryExecutor, ValidationSession
from app.query.plan import parse_plan, validate_plan
from app.security.guard import AuditLog, RateLimiter

router = APIRouter()

# Dependency container — APIRouter has no .state; routes read from here.
_DEPS: dict[str, object] = {}





class QueryPlanBody(BaseModel):
    datasetId: str
    select: list[dict[str, Any]] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    filters: list[dict[str, Any]] = Field(default_factory=list)
    limit: int = 100


class ExecuteBody(BaseModel):
    validatedQueryId: str


class MaterializeBody(BaseModel):
    validatedQueryId: str
    format: str = "parquet"  # parquet | arrow


def _wire(
    config: LakehouseConfig,
    registry: DatasetRegistry,
    session: ValidationSession,
    executor: QueryExecutor,
    lineage: LineageRegistry,
    audit: AuditLog,
    limiter: RateLimiter,
) -> None:
    """Attach dependencies to routes (called from main)."""
    _DEPS.update(config=config, registry=registry, session=session, executor=executor,
                 lineage=lineage, audit=audit, limiter=limiter)


def _guard(request: Request) -> str:
    """Rate-limit + client key. Returns client key."""
    client = request.headers.get("x-client-id", request.client.host if request.client else "unknown")
    ok, remaining = _DEPS["limiter"].allow(client)
    if not ok:
        _DEPS["audit"].record("rate_limited", client=client)
        raise HTTPException(429, "rate limit exceeded")
    return client


@router.get("/health")
async def health():
    registry: DatasetRegistry = _DEPS["registry"]
    catalog_status = "error" if registry.catalog_error else "ok"
    n = len(registry.discover())
    return {
        "status": "ok",
        "catalog": catalog_status,
        "datasets": n,
        "mode": _DEPS["config"].mode,
        "time": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/v1/catalog/search")
@_require("round2.catalog_tools")
async def search_catalog(request: Request, q: str = "", layer: str | None = None,
                         domain: str | None = None, limit: int = Query(50, ge=1, le=200)):
    _guard(request)
    return _search(q, layer, limit, domain)


def _search(q: str, layer: str | None, limit: int, domain: str | None = None):
    registry: DatasetRegistry = _DEPS["registry"]
    results = registry.search(q=q, layer=layer, limit=limit, domain=domain)
    return {
        "results": [
            {
                "datasetId": d.dataset_id,
                "displayName": d.display_name,
                "layer": d.layer,
                "tableName": d.table_name,
                "description": d.description,
                "domain": d.domain,
                "fields": [{"name": f.name, "type": f.type, "sensitive": f.sensitive, "partition": f.partition} for f in d.fields],
                "latestSnapshotId": d.latest_snapshot_id,
                "lastUpdatedAt": d.last_updated_at,
            }
            for d in results
        ],
        "count": len(results),
    }


@router.get("/v1/datasets/{dataset_id}")
@_require("round2.catalog_tools")
async def inspect_dataset(dataset_id: str):
    registry: DatasetRegistry = _DEPS["registry"]
    d = registry.get(dataset_id)
    if d is None:
        raise HTTPException(404, f"dataset '{dataset_id}' not found")
    return {
        "datasetId": d.dataset_id,
        "displayName": d.display_name,
        "layer": d.layer,
        "tableName": d.table_name,
        "description": d.description,
        "fields": [{"name": f.name, "type": f.type, "sensitive": f.sensitive, "partition": f.partition} for f in d.fields],
        "version": d.version,
        "latestSnapshotId": d.latest_snapshot_id,
        "lastUpdatedAt": d.last_updated_at,
    }


def _caller(request: Request) -> str:
    """Caller identity from the x-client-id header (informational — the caller
    can choose it, but validate/execute must use the same value; a mismatch is
    rejected). Defaults to "anon"."""
    return request.headers.get("x-client-id", "anon")


@router.post("/v1/query/validate")
@_require("round2.query_tools")
async def validate_query(body: QueryPlanBody, request: Request):
    _guard(request)
    caller = _caller(request)
    try:
        plan = parse_plan(body.model_dump())
    except ValueError as e:
        _DEPS["audit"].record("validate_rejected", datasetId=body.datasetId, reason=str(e))
        raise HTTPException(422, str(e))
    result = validate_plan(plan, _DEPS["registry"], _DEPS["config"])
    if result.ok:
        _DEPS["session"].put(result.validatedQueryId, plan, caller=caller)
    _DEPS["audit"].record("validate", datasetId=plan.datasetId, ok=result.ok,
                          validatedQueryId=result.validatedQueryId, caller=caller)
    return result.to_dict()


@router.post("/v1/query/execute")
@_require("round2.query_tools")
async def execute_query(body: ExecuteBody, request: Request):
    _guard(request)
    caller = _caller(request)
    try:
        result = _DEPS["executor"].execute(body.validatedQueryId, caller=caller)
    except LookupError as e:
        _DEPS["audit"].record("execute_rejected", validatedQueryId=body.validatedQueryId,
                              reason=str(e), caller=caller)
        raise HTTPException(404, str(e))
    except (ValueError, RuntimeError) as e:
        _DEPS["audit"].record("execute_failed", validatedQueryId=body.validatedQueryId,
                              reason=str(e), caller=caller)
        raise HTTPException(400, str(e))
    _DEPS["audit"].record("execute", validatedQueryId=body.validatedQueryId,
                          queryId=result.queryId, rows=result.rowCount, caller=caller)
    return result.to_dict()


@router.post("/v1/query/materialize")
@_require("round4.analysis_input_materialization")
async def materialize_query(body: MaterializeBody, request: Request):
    """Materialize a validated query into an immutable analysis artifact.

    Same pipeline as execute (validatedQueryId only, caller binding, field
    permissions, masking, row/scan limits) but the full result is persisted
    as a parquet/arrow artifact and only metadata is returned — no rows ever
    reach the agent. Input artifacts for the Data Analysis Subagent.
    """
    _guard(request)
    caller = _caller(request)
    try:
        meta = _DEPS["executor"].materialize(body.validatedQueryId, caller=caller, fmt=body.format)
    except LookupError as e:
        _DEPS["audit"].record("materialize_rejected", validatedQueryId=body.validatedQueryId,
                              reason=str(e), caller=caller)
        raise HTTPException(404, str(e))
    except (ValueError, RuntimeError) as e:
        _DEPS["audit"].record("materialize_failed", validatedQueryId=body.validatedQueryId,
                              reason=str(e), caller=caller)
        raise HTTPException(400, str(e))
    # artifactPath is storage detail for the local runner — never for the model.
    meta.pop("artifactPath", None)
    _DEPS["audit"].record("materialize", validatedQueryId=body.validatedQueryId,
                          queryId=meta["queryId"], rows=meta["rowCount"], caller=caller)
    return meta


@router.get("/v1/quality/{dataset_id}")
@_require("round2.data_quality")
async def get_quality(dataset_id: str):
    registry: DatasetRegistry = _DEPS["registry"]
    d = registry.get(dataset_id)
    if d is None:
        raise HTTPException(404, f"dataset '{dataset_id}' not found")
    from app.quality.checks import assess_quality
    from app.quality.profile import profile_structured
    try:
        tbl = registry._get_catalog().load_table(d.table_name).scan().to_arrow()
    except Exception as e:
        raise HTTPException(502, f"cannot scan dataset: {e}")
    rows = tbl.to_pylist()
    profile = profile_structured(d.dataset_id, rows)
    quality = assess_quality(tbl, _DEPS["config"])
    return {
        "datasetId": dataset_id,
        "status": quality.status,
        "checks": [{"check": c.check, "status": c.status, "detail": c.detail} for c in quality.checks],
        "profile": {
            "rowCount": profile.row_count,
            "columns": [
                {"column": c.column_name, "missingRate": c.missing_rate, "uniqueRate": c.unique_rate,
                 "logicalTypes": c.logical_type_candidates, "distinctCount": c.distinct_count}
                for c in profile.columns
            ],
            "candidateKeys": profile.candidate_keys,
            "candidateTimeColumns": profile.candidate_time_columns,
        },
    }


@router.get("/v1/lineage/{dataset_id}")
@_require("round2.lineage")
async def get_lineage(dataset_id: str):
    try:
        result = _DEPS["lineage"].explain(dataset_id)
    except LookupError as e:
        raise HTTPException(404, str(e))
    return result.to_dict()


class LineageEdgeBody(BaseModel):
    source: str
    target: str
    kind: str = "manual"


@router.post("/v1/lineage/edges")
@_require("round2.lineage")
async def register_lineage_edge(body: LineageEdgeBody, request: Request):
    """Register a manual lineage edge for relationships the name-link rule
    cannot derive (e.g. dwd.customers -> dws.customer_city_stats).
    Auto-derived same-name chains need no registration."""
    _guard(request)
    registry = _DEPS["registry"]
    for name in (body.source, body.target):
        if registry.get(name) is None:
            raise HTTPException(404, f"unknown dataset '{name}' — edges must reference existing datasets")
    _DEPS["lineage"].register_edge(body.source, body.target, kind=body.kind)
    _DEPS["audit"].record("lineage_edge_registered", source=body.source, target=body.target)
    return {"ok": True, "source": body.source, "target": body.target, "kind": body.kind}


@router.get("/v1/snapshots/{dataset_id}")
@_require("round2.snapshot")
async def get_snapshots(dataset_id: str):
    registry: DatasetRegistry = _DEPS["registry"]
    d = registry.get(dataset_id)
    if d is None:
        raise HTTPException(404, f"dataset '{dataset_id}' not found")
    try:
        table = registry._get_catalog().load_table(d.table_name)
    except Exception as e:
        raise HTTPException(502, f"cannot load dataset: {e}")
    snaps = []
    for s in table.snapshots():
        snaps.append({
            "snapshotId": s.snapshot_id,
            "timestampMs": s.timestamp_ms,
            "manifestList": s.manifest_list,
            "summary": s.summary or {},
        })
    snaps.sort(key=lambda x: x["timestampMs"], reverse=True)
    return {"datasetId": dataset_id, "snapshots": snaps, "count": len(snaps)}
