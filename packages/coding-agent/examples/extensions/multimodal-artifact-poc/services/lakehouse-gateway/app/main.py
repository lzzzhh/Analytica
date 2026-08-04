"""Lakehouse Query Gateway — FastAPI read-only entry point.

Run locally (no AWS credentials needed):
    LAKEHOUSE_MODE=local uvicorn app.main:app --port 8001

Cloud mode (requires AWS credentials in the environment):
    LAKEHOUSE_MODE=aws LAKEHOUSE_S3_WAREHOUSE=s3://... LAKEHOUSE_CATALOG_TYPE=glue
"""
from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

# cdxr-engine lives in its own package (services/cdxr-engine) and is
# dependency-free by design; make it importable for the gateway adapter.
_ENGINE_DIR = Path(__file__).resolve().parents[2] / "cdxr-engine"
if str(_ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(_ENGINE_DIR))

from app.api.cdxr_routes import _wire as _wire_cdxr, router as cdxr_router
from app.api.governance_routes import _wire as _wire_gov, router as gov_router
from app.api.routes import _wire, router
from app.catalog.dataset_registry import DatasetRegistry
from app.config import LakehouseConfig, get_config, reload_config
from app.features import feature_summary_line, get_default_resolver
from app.governance.reader import GovernanceReader
from app.integrations.cdxr_lakehouse_adapter import LakehouseTrainingDatasetAdapter
from app.lineage.lineage import LineageRegistry
from app.query.executor import QueryExecutor, ValidationSession
from app.security.guard import AuditLog, RateLimiter

app = FastAPI(
    title="Lakehouse Query Gateway",
    description="Read-only data access layer for cloud lakehouse (Iceberg). Structured QueryPlan only; no raw SQL.",
    version="0.1.0",
)

# -- dependencies ------------------------------------------------------

_config: LakehouseConfig = reload_config()
_registry = DatasetRegistry(_config)
_session = ValidationSession()
_executor = QueryExecutor(_config, _registry, _session)
_lineage = LineageRegistry(_registry)


def _register_business_edges(lineage: LineageRegistry, registry: DatasetRegistry) -> None:
    """Startup registration of business lineage edges the name-link rule
    cannot derive (different names across layers). Only registers edges whose
    datasets actually exist in the catalog."""
    edges = [
        ("dwd.customers", "dws.customer_city_stats"),
        ("dws.feature_values", "ads.model_metrics"),
        ("dws.prediction_points", "ads.model_metrics"),
    ]
    for source, target in edges:
        try:
            if registry.get(source) is not None and registry.get(target) is not None:
                lineage.register_edge(source, target)
        except Exception:
            pass


_register_business_edges(_lineage, _registry)
_audit = AuditLog(os.environ.get("LAKEHOUSE_AUDIT_LOG", ".data/audit.log"))
_limiter = RateLimiter(max_requests=int(os.environ.get("LAKEHOUSE_RATE_LIMIT", "60")))

_wire(_config, _registry, _session, _executor, _lineage, _audit, _limiter)

# Feature-driven router mounting: only effective features expose their API.
# round2.* endpoints are guarded per-route inside routes.py; the CDXR
# training API and the legacy governance API are not mounted at all when
# their feature is off (requests then get a plain 404).
_features = get_default_resolver()
print(feature_summary_line(_features), flush=True)
if _features.is_effective("legacy.cdxr_governance_tools"):
    # Governance API: reads the materialized governance tables via the shared
    # catalog; shares the query API's rate limiter + audit log (review fix).
    _gov_reader = GovernanceReader(_registry._get_catalog())  # noqa: SLF001 (same package)
    _wire_gov(_gov_reader, limiter=_limiter, audit=_audit)
if _features.is_effective("round3.cdxr_training"):
    # CDXR training assessments: on-demand only. The adapter is read-only
    # (aggregates via the existing catalog); nothing runs at startup and normal
    # query execution never touches it.
    _cdxr_adapter = LakehouseTrainingDatasetAdapter(_registry, _config, _lineage)
    _wire_cdxr(_cdxr_adapter, limiter=_limiter, audit=_audit)

app.include_router(router)
if _features.is_effective("legacy.cdxr_governance_tools"):
    app.include_router(gov_router)
if _features.is_effective("round3.cdxr_training"):
    app.include_router(cdxr_router)

# -- startup -----------------------------------------------------------


@asynccontextmanager
async def _lifespan(app: FastAPI):
    _registry.discover()
    yield


app.router.lifespan_context = _lifespan


# expose dependencies for tests / scripts
def get_deps():
    return {
        "config": _config,
        "registry": _registry,
        "session": _session,
        "executor": _executor,
        "lineage": _lineage,
        "audit": _audit,
    }
