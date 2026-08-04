"""Contract validation — structured errors, strict parsing, runtime type checks.

MIGRATED verbatim from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/contracts/validation.py). No changes.

All contracts MUST use the strict entry points (parse_*) in production paths.
The unchecked entry points (from_dict_unchecked) exist only for backward
compatibility and tests that deliberately construct invalid data.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from types import MappingProxyType
from typing import Any

# -----------------------------------------------------------------
# Structured errors
# -----------------------------------------------------------------

class ContractValidationError(ValueError):
    """Raised when a contract object fails strict validation.

    All production parsing must use entry points that raise this exception.
    Never catch this silently; treat it as a data pipeline failure.
    """

    def __init__(self, errors: list[FieldError], raw_message: str = ""):
        self.errors = errors
        detail = "\n".join(str(e) for e in errors) if errors else raw_message
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class FieldError:
    field_path: str         # e.g. "event_time" or "payload.sha256"
    message: str
    value: Any = field(default=None, repr=False)

    def __str__(self) -> str:
        return f"{self.field_path}: {self.message}"


_SHA256_HEX_RE = re.compile(r"[0-9a-fA-F]{64}")


def validate_sha256_hex(value: object, field_path: str) -> str:
    """Validate a SHA-256 hex string. Returns normalized lowercase.

    Rejects: non-strings, wrong length, non-hex characters, trailing newlines.
    """
    if not isinstance(value, str):
        raise ContractValidationError([
            FieldError(field_path, f"expected str, got {type(value).__name__}", value),
        ])
    if _SHA256_HEX_RE.fullmatch(value) is None:
        raise ContractValidationError([
            FieldError(field_path, "must be exactly 64 hexadecimal characters", value),
        ])
    return value.lower()

def _check_type(value: Any, expected: type, field_path: str) -> list[FieldError]:
    """Require exact type match. None is always acceptable for Optional fields."""
    if value is None:
        return []
    if not isinstance(value, expected):
        return [FieldError(field_path, f"expected {expected.__name__}, got {type(value).__name__}", value)]
    return []


def _check_type_union(value: Any, types: tuple[type, ...], field_path: str) -> list[FieldError]:
    """Require value to be one of the allowed types."""
    if value is None:
        return []
    if not isinstance(value, types):
        names = " | ".join(t.__name__ for t in types)
        return [FieldError(field_path, f"expected {names}, got {type(value).__name__}", value)]
    return []


def coerce_str(value: Any, field_path: str) -> str:
    errors = _check_type(value, str, field_path)
    if errors:
        raise ContractValidationError(errors)
    return value  # type: ignore[return-value]


def coerce_str_nonempty(value: Any, field_path: str) -> str:
    """Coerce to non-empty string. Raises on None, wrong type, or empty/whitespace."""
    # First check type — coerce_str returns None if value is None
    s = coerce_str(value, field_path)
    if s is None:
        raise ContractValidationError([FieldError(field_path, "must be non-empty (got None)", value)])
    if not s.strip():
        raise ContractValidationError([FieldError(field_path, "must be non-empty", value)])
    return s


def coerce_str_opt(value: Any, field_path: str) -> str | None:
    """Coerce to string; None passes through."""
    if value is None:
        return None
    return coerce_str(value, field_path)


def coerce_str_nonempty_opt(value: Any, field_path: str) -> str | None:
    """Coerce to non-empty string; None passes through."""
    if value is None:
        return None
    return coerce_str_nonempty(value, field_path)


def coerce_dict_opt(value: Any, field_path: str) -> dict | None:
    """Coerce to dict; None passes through."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ContractValidationError([FieldError(field_path, f"expected dict, got {type(value).__name__}", value)])
    return value


def coerce_int_opt(value: Any, field_path: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ContractValidationError([FieldError(field_path, "expected int, got bool", value)])
    errors = _check_type(value, int, field_path)
    if errors:
        raise ContractValidationError(errors)
    return value  # type: ignore[return-value]


def coerce_float_opt(value: Any, field_path: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ContractValidationError([FieldError(field_path, "expected float, got bool", value)])
    if not isinstance(value, (int, float)):
        raise ContractValidationError([FieldError(field_path, f"expected float, got {type(value).__name__}", value)])
    v = float(value)
    if math.isnan(v) or math.isinf(v):
        raise ContractValidationError([FieldError(field_path, "float must not be NaN or Inf", value)])
    return v


def coerce_bool_opt(value: Any, field_path: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ContractValidationError([FieldError(field_path, f"expected bool, got {type(value).__name__}", value)])
    return value


def coerce_datetime_utc(value: Any, field_path: str) -> datetime:
    """Parse a datetime string. Reject naive datetimes; fail on wrong type."""
    if isinstance(value, datetime):
        if value.utcoffset() is None:
            raise ContractValidationError([FieldError(field_path, "datetime must be timezone-aware", value)])
        return value
    if isinstance(value, str):
        return _parse_dt_strict(value, field_path)
    raise ContractValidationError([
        FieldError(field_path, f"expected ISO datetime string, got {type(value).__name__}", value),
    ])


def _parse_dt_strict(s: str, field_path: str) -> datetime:
    s = s.strip()
    # Detect Z suffix
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError) as exc:
        raise ContractValidationError([FieldError(field_path, f"invalid ISO datetime: {exc}", s)]) from exc
    if dt.utcoffset() is None:
        raise ContractValidationError([FieldError(field_path, "datetime string must include timezone offset", s)])
    return dt


# -----------------------------------------------------------------
# Generic enum coercion
# -----------------------------------------------------------------

def coerce_enum(value: Any, enum_cls: type, field_path: str) -> Any:
    """Coerce a string into an enum member. Fail on unknown values."""
    if isinstance(value, enum_cls):
        return value
    if isinstance(value, str):
        try:
            return enum_cls(value)
        except ValueError as exc:
            raise ContractValidationError([FieldError(
                field_path,
                f"invalid value '{value}' for {enum_cls.__name__}; allowed: {[e.value for e in enum_cls]}",
                value,
            )]) from exc
    raise ContractValidationError([
        FieldError(
            field_path,
            f"expected str or {enum_cls.__name__}, got {type(value).__name__}",
            value,
        ),
    ])


# -----------------------------------------------------------------
# JSON-safe recursive freeze — only accepts JSON primitives
# -----------------------------------------------------------------

_JSON_SCALAR_TYPES = (str, bool, int, type(None))


def freeze_json(value: Any, field_path: str = "value") -> Any:
    """Recursively freeze JSON-compatible values only.

    Allowed: None, bool, int, float (finite), str, list, tuple, dict with str keys.
    Rejected: set, frozenset, bytearray, custom objects, non-UTF8 bytes, NaN/Inf.
    Returns deeply immutable nested structure.
    """
    if value is None:
        return None
    if isinstance(value, bool):  # must precede int check (bool is subclass of int)
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ContractValidationError([
                FieldError(field_path, "NaN/Inf is not valid JSON", value),
            ])
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        frozen: dict = {}
        for key, child in value.items():
            if not isinstance(key, str):
                raise ContractValidationError([
                    FieldError(f"{field_path}.<key>", f"JSON keys must be str, got {type(key).__name__}", key),
                ])
            frozen[key] = freeze_json(child, f"{field_path}.{key}")
        return MappingProxyType(frozen)
    if isinstance(value, (list, tuple)):
        return tuple(freeze_json(child, f"{field_path}[{i}]") for i, child in enumerate(value))

    raise ContractValidationError([
        FieldError(field_path, f"unsupported non-JSON type: {type(value).__name__}", value),
    ])


def thaw_json(value: Any) -> Any:
    """Recursively thaw: MappingProxyType→dict, tuple→list."""
    if isinstance(value, MappingProxyType):
        return {k: thaw_json(v) for k, v in value.items()}
    if isinstance(value, tuple):
        return [thaw_json(v) for v in value]
    if isinstance(value, dict):
        return {k: thaw_json(v) for k, v in value.items()}
    return value
