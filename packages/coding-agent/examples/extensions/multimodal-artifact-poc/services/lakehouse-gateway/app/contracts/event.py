"""Event Contract — strict identity enforcement, deep immutability.

MIGRATED from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/contracts/event.py), with the following GENERALIZATION changes:
  - Removed domain-bound enums (EventType/EntityType, e.g. loan_application)
    from the platform core; event_type / entity_type are now validated open
    strings (snake_case). Domain event-type sets live in domains/risk (optional).
  - Kept field name `customer_id` for wire compatibility (it is a domain
    payload field; the platform treats it as an opaque string).
  - All invariants preserved: canonical event_id identity, collision proof,
    deep immutability, strict parse entry points, time ordering.

Key invariants:
  - event_id MUST match the canonical identity computed from source keys
  - Either source_record_id or payload_sha256 must be non-empty (collision proof)
  - headers values are type-checked
  - Deep immutability via recursive freeze
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.contracts.validation import (
    ContractValidationError,
    FieldError,
    coerce_datetime_utc,
    coerce_int_opt,
    coerce_str,
    coerce_str_nonempty,
    coerce_str_nonempty_opt,
    coerce_str_opt,
    freeze_json,
    thaw_json,
    validate_sha256_hex,
)

# Open event-type / entity-type vocabulary (snake_case, lowercase).
# Domain-specific value sets may be enforced by the domain layer.
_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*$")


def _validate_type(value: str, field_name: str, errors: list[FieldError]) -> str:
    try:
        v = coerce_str_nonempty(value, field_name)
    except ContractValidationError as e:
        errors.extend(e.errors)
        return ""
    if not _TYPE_RE.fullmatch(v):
        errors.append(FieldError(field_name, f"must be lowercase snake_case, got '{v}'", v))
    return v


# -----------------------------------------------------------------
# Canonical event identity
# -----------------------------------------------------------------

def _canonical_encode(parts: list[str | None]) -> bytes:
    """Encode identity parts as an unambiguous JSON array.

    Uses JSON array encoding (not delimiter-based) so that `|`,
    newlines, and other special characters in source-key fields
    cannot create ambiguous hashes.
    """
    return json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _normalize_source_id(raw: str | None) -> str | None:
    """Normalize a source record ID for identity purposes.

    - None → None (use payload identity)
    - whitespace-only → None (use payload identity)
    - non-empty after strip → the stripped value
    """
    if raw is None:
        return None
    if not isinstance(raw, str):
        return None
    stripped = raw.strip()
    if not stripped:
        return None
    return stripped


def compute_event_id(
    dataset_id: str,
    entity_type: str,
    entity_id: str,
    event_type: str,
    event_time_utc: datetime,
    source_record_id: str | None = None,
    source_record_revision: str | None = None,
    payload_sha256: str | None = None,
) -> str:
    """Compute canonical event_id from source or content identity.

    Priority: normalized source_record_id > payload_sha256.
    Uses JSON array canonical encoding (unambiguous, no delimiter collision).
    Does NOT use payload_uri (URIs are not stable identity).
    """
    utc_time = event_time_utc.astimezone(timezone.utc)
    time_part = utc_time.strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    sid = _normalize_source_id(source_record_id)
    srev = source_record_revision.strip() if source_record_revision else ""

    if sid:
        parts = [
            dataset_id, entity_type, entity_id, event_type,
            time_part,
            "source_record",
            sid,
            srev,
        ]
    elif payload_sha256:
        parts = [
            dataset_id, entity_type, entity_id, event_type,
            time_part,
            "payload_sha256",
            payload_sha256.lower(),
        ]
    else:
        raise ValueError("source_record_id or payload_sha256 is required to compute event_id")

    return hashlib.sha256(_canonical_encode(parts)).hexdigest()


def compute_expected_event_id(
    dataset_id: str,
    entity_type: str,
    entity_id: str,
    event_type: str,
    event_time: datetime,
    source_record_id: str = "",
    source_record_revision: str = "",
    payload_sha256: str | None = None,
) -> str:
    """Compute event_id from parser inputs with normalization."""
    sid = source_record_id if source_record_id else ""
    srev = source_record_revision if source_record_revision else ""
    sha = payload_sha256 if payload_sha256 else None
    try:
        return compute_event_id(
            dataset_id=dataset_id,
            entity_type=entity_type,
            entity_id=entity_id,
            event_type=event_type,
            event_time_utc=event_time,
            source_record_id=sid if sid else None,
            source_record_revision=srev if srev else None,
            payload_sha256=sha,
        )
    except ValueError:
        return ""


# -----------------------------------------------------------------

@dataclass(frozen=True)
class Event:
    """Universal event envelope with enforced identity and deep immutability."""

    dataset_id: str
    event_id: str
    entity_type: str
    entity_id: str
    customer_id: str
    event_type: str
    event_time: datetime
    available_at: datetime
    ingested_at: datetime
    source_system: str
    schema_version: int = 1
    source_record_id: str = ""
    source_record_revision: str = ""
    payload_uri: str | None = None
    payload_sha256: str | None = None
    headers: Any = field(default_factory=dict)

    def __post_init__(self):
        """Deep-freeze headers for recursive immutability."""
        object.__setattr__(self, "headers", freeze_json(self.headers))

    # -- strict entry points -------------------------------------------

    @classmethod
    def parse(cls, d: dict[str, Any]) -> Event:
        """Strict deserialization. Raises ContractValidationError on failure."""
        errors: list[FieldError] = []
        try:
            evt = cls._from_dict_coerce(d, errors)
        except ContractValidationError:
            raise
        if errors:
            raise ContractValidationError(errors)
        return evt

    @classmethod
    def from_dict_unchecked(cls, d: dict[str, Any]) -> Event:
        """Unchecked deserialization for tests only."""
        errors: list[FieldError] = []
        return cls._from_dict_coerce(d, errors)

    @classmethod
    def _from_dict_coerce(cls, d: dict[str, Any], errors: list[FieldError]) -> Event:
        def _str(k: str) -> str:
            try:
                return coerce_str_nonempty(d.get(k), k)
            except ContractValidationError as e:
                errors.extend(e.errors)
                return ""

        def _str_opt(k: str) -> str | None:
            try:
                return coerce_str_nonempty_opt(d.get(k), k)
            except ContractValidationError as e:
                errors.extend(e.errors)
                return None

        dataset_id = _str("dataset_id")
        event_id = _str("event_id")
        entity_id = _str("entity_id")
        customer_id = _str("customer_id")
        source_system = _str("source_system")

        # Source record ID — type-check, allow empty when payload_sha256 provides identity
        source_record_id_raw = d.get("source_record_id")
        source_record_id = ""
        if source_record_id_raw is not None:
            try:
                coerce_str(source_record_id_raw, "source_record_id")
                source_record_id = source_record_id_raw if isinstance(source_record_id_raw, str) else ""
            except ContractValidationError as e:
                errors.extend(e.errors)

        source_record_revision_raw = d.get("source_record_revision", "")
        if source_record_revision_raw is not None:
            try:
                coerce_str_opt(source_record_revision_raw, "source_record_revision")
                source_record_revision = (
                    source_record_revision_raw
                    if isinstance(source_record_revision_raw, str)
                    else ""
                )
            except ContractValidationError as e:
                errors.extend(e.errors)
                source_record_revision = ""
        else:
            source_record_revision = ""

        # Types — open vocabulary, validated shape
        entity_type = _validate_type(str(d.get("entity_type", "")), "entity_type", errors)
        evt_type = _validate_type(str(d.get("event_type", "")), "event_type", errors)

        # Datetimes
        event_time = datetime(1970, 1, 1, tzinfo=timezone.utc)
        available_at = datetime(1970, 1, 1, tzinfo=timezone.utc)
        ingested_at = datetime(1970, 1, 1, tzinfo=timezone.utc)
        try:
            event_time = coerce_datetime_utc(d.get("event_time"), "event_time")
        except ContractValidationError as e:
            errors.extend(e.errors)
        try:
            available_at = coerce_datetime_utc(d.get("available_at"), "available_at")
        except ContractValidationError as e:
            errors.extend(e.errors)
        try:
            ingested_at = coerce_datetime_utc(d.get("ingested_at"), "ingested_at")
        except ContractValidationError as e:
            errors.extend(e.errors)

        # Time ordering
        if event_time.tzinfo is not None and available_at.tzinfo is not None:
            if event_time > available_at:
                errors.append(FieldError(
                    "event_time",
                    "event_time must be <= available_at",
                ))

        # Schema version
        schema_version = 1
        sv_raw = d.get("schema_version", 1)
        try:
            sv = coerce_int_opt(sv_raw, "schema_version")
        except ContractValidationError as e:
            errors.extend(e.errors)
            sv = None
        if sv is None:
            sv = 1
        if sv < 1:
            errors.append(FieldError("schema_version", "must be >= 1", sv))
        schema_version = sv

        # Payload fields
        payload_uri = _str_opt("payload_uri")
        payload_sha256 = _str_opt("payload_sha256")
        if payload_sha256 is not None:
            try:
                payload_sha256 = validate_sha256_hex(payload_sha256, "payload_sha256")
            except ContractValidationError as e:
                errors.extend(e.errors)
                payload_sha256 = None

        # Collision-proof requirement
        if not source_record_id.strip() and not payload_sha256:
            errors.append(FieldError(
                "source_record_id",
                "either source_record_id or payload_sha256 must be non-empty to prevent collision",
            ))

        # Headers: type-check keys and values
        headers_raw = d.get("headers", {})
        headers: dict = {}
        if isinstance(headers_raw, dict):
            for k, v in headers_raw.items():
                if not isinstance(k, str):
                    errors.append(FieldError(f"headers.{k}", f"key must be str, got {type(k).__name__}"))
                if not isinstance(v, str):
                    errors.append(FieldError(f"headers.{k}", f"value must be str, got {type(v).__name__}"))
            headers = headers_raw
        else:
            errors.append(FieldError("headers", f"expected dict, got {type(headers_raw).__name__}", headers_raw))

        # ---- ENFORCE canonical event_id ----
        if event_time.tzinfo is not None:
            expected_id = compute_expected_event_id(
                dataset_id, entity_type, entity_id, evt_type, event_time,
                source_record_id=source_record_id,
                source_record_revision=source_record_revision,
                payload_sha256=payload_sha256,
            )
            if expected_id and not hmac.compare_digest(event_id, expected_id):
                errors.append(FieldError(
                    "event_id",
                    f"does not match canonical identity; expected={expected_id[:16]}..., got={event_id[:16]}...",
                    event_id,
                ))

        return cls(
            dataset_id=dataset_id,
            event_id=event_id,
            entity_type=entity_type,
            entity_id=entity_id,
            customer_id=customer_id,
            event_type=evt_type,
            event_time=event_time,
            available_at=available_at,
            ingested_at=ingested_at,
            source_system=source_system,
            schema_version=schema_version,
            source_record_id=source_record_id,
            source_record_revision=source_record_revision,
            payload_uri=payload_uri,
            payload_sha256=payload_sha256,
            headers=headers,
        )

    # -- serialization --------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "event_id": self.event_id,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "customer_id": self.customer_id,
            "event_type": self.event_type,
            "event_time": self.event_time.isoformat(),
            "available_at": self.available_at.isoformat(),
            "ingested_at": self.ingested_at.isoformat(),
            "source_system": self.source_system,
            "schema_version": self.schema_version,
            "source_record_id": self.source_record_id,
            "source_record_revision": self.source_record_revision,
            "payload_uri": self.payload_uri,
            "payload_sha256": self.payload_sha256,
            "headers": thaw_json(self.headers),
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)
