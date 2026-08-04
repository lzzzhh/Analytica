"""Read-only CDXR governance API (6 endpoints).

These endpoints only read the materialized governance tables. When CDXR is
not configured (no governance tables), they return empty results so the
gateway keeps working. No governance state is ever written here.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.api.guard import _require
from app.governance.reader import GovernanceReader

router = APIRouter()

# Dependency container (APIRouter has no .state) — wired from main.py.
_DEPS: dict[str, object] = {}


def _wire(reader: GovernanceReader, limiter=None, audit=None) -> None:
    _DEPS["reader"] = reader
    if limiter is not None:
        _DEPS["limiter"] = limiter
    if audit is not None:
        _DEPS["audit"] = audit


def _reader() -> GovernanceReader:
    return _DEPS["reader"]  # type: ignore[return-value]


def _guard(request: Request) -> str:
    """Rate-limit guard shared with the query API (review: governance reads
    must not bypass the rate limiter). Returns the client key."""
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


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


@router.get("/v1/governance/cdxr/datasets/{dataset_id}/profile")
@_require("legacy.cdxr_governance_tools")
async def get_governance_profile(dataset_id: str, request: Request):
    _guard(request)
    profile = _reader().get_profile(dataset_id)
    if profile is None:
        raise _not_found(f"no governance profile for {dataset_id} (CDXR not configured or no run)")
    return profile


@router.get("/v1/governance/cdxr/findings")
@_require("legacy.cdxr_governance_tools")
async def list_governance_findings(request: Request,
                                   dataset_id: str | None = None,
                                   severity: str | None = None,
                                   status: str | None = None,
                                   rule_id: str | None = None,
                                   limit: int = Query(100, ge=1, le=1000),
                                   dedup: bool = True):
    _guard(request)
    findings = _reader().list_findings(
        dataset_id=dataset_id, severity=severity, status=status,
        rule_id=rule_id, limit=limit, dedup=dedup,
    )
    return {"count": len(findings), "findings": findings}


@router.get("/v1/governance/cdxr/findings/{finding_id}")
@_require("legacy.cdxr_governance_tools")
async def get_governance_finding(finding_id: str, request: Request):
    _guard(request)
    finding = _reader().get_finding(finding_id)
    if finding is None:
        raise _not_found(f"finding {finding_id} not found")
    return finding


@router.get("/v1/governance/cdxr/findings/{finding_id}/evidence")
@_require("legacy.cdxr_governance_tools")
async def get_governance_evidence(finding_id: str, request: Request):
    _guard(request)
    evidence = _reader().get_finding_evidence(finding_id)
    if not evidence:
        raise _not_found(f"no evidence for finding {finding_id}")
    return {"findingId": finding_id, "count": len(evidence), "evidence": evidence}


@router.get("/v1/governance/cdxr/runs/{run_id}")
@_require("legacy.cdxr_governance_tools")
async def get_governance_run(run_id: str, request: Request):
    _guard(request)
    run = _reader().get_run(run_id)
    if run is None:
        raise _not_found(f"run {run_id} not found")
    return run


@router.get("/v1/governance/cdxr/review-queue")
@_require("legacy.cdxr_governance_tools")
async def get_governance_review_queue(request: Request,
                                      dataset_id: str | None = None):
    _guard(request)
    queue = _reader().get_review_queue(dataset_id=dataset_id)
    return {"count": len(queue), "items": queue}
