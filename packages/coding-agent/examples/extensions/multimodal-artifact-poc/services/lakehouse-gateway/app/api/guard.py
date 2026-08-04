"""Shared API feature guard — every gateway route must be gated.

`_require(feature_id)` returns a decorator that answers
404 FEATURE_DISABLED (without running any handler logic) when the feature is
not effective. Feature-flag hygiene check B (scripts/check-feature-hygiene.mts)
AST-scans every @router.* route for a @_require(...) decorator — keep the
decorator name in sync with that check.
"""
from __future__ import annotations

import functools

from fastapi import HTTPException

from app.features import get_default_resolver


def _require(feature_id: str):
    """Return 404 FEATURE_DISABLED when the feature is not effective."""
    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            if not get_default_resolver().is_effective(feature_id):
                raise HTTPException(404, f"FEATURE_DISABLED: '{feature_id}' is not enabled")
            return await func(*args, **kwargs)
        return wrapper
    return decorator
