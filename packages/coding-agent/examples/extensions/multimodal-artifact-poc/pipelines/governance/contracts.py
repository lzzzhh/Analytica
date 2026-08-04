"""Contract loading & validation — the JSON Schemas under
contracts/pipeline-governance/ are the single source of truth. Both Python
(here) and TypeScript (tests) read the same files; a parity test asserts the
two validators agree.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema

CONTRACTS_DIR = Path(__file__).resolve().parents[2] / "contracts" / "pipeline-governance"

CONTRACT_NAMES = [
    "source-registration",
    "source-schema-profile",
    "schema-spec",
    "pipeline-spec",
    "pipeline-draft-artifact",
    "validation-issue",
    "pipeline-review-package",
    "approval-decision",
    "pipeline-amendment",
    "approved-pipeline-spec",
    "governance-event",
    "pipeline-run-state-snapshot",
    "governance-finding",
    "governance-report",
    "pipeline-context-package",
    "spark-runtime-summary",
    "flink-runtime-summary",
    "iceberg-commit-summary",
    "remediation-proposal",
    "watchdog-lease",
]

_resolvers: dict[str, Any] = {}
_validators: dict[str, Any] = {}
_registry: Any = None


def _load_registry() -> Any:
    """Build a referencing registry over all contract schemas ($ref support)."""
    global _registry
    if _registry is None:
        from referencing import Registry, Resource
        store = {}
        for name in CONTRACT_NAMES:
            path = CONTRACTS_DIR / f"{name}.schema.json"
            schema = json.loads(path.read_text(encoding="utf-8"))
            uri = f"pipeline-governance/{name}.schema.json"
            store[uri] = schema
        _registry = Registry().with_resources(
            (uri, Resource.from_contents(schema)) for uri, schema in store.items()
        )
    return _registry


def get_schema(name: str) -> dict:
    """Load a contract schema (with $ref resolution against the store)."""
    if name in _validators:
        return _validators[name]["schema"]
    path = CONTRACTS_DIR / f"{name}.schema.json"
    schema = json.loads(path.read_text(encoding="utf-8"))
    _validators[name] = {
        "schema": schema,
        "validator": jsonschema.Draft7Validator(schema, registry=_load_registry()),
    }
    return schema


def validate_contract(name: str, instance: Any) -> list[str]:
    """Validate an instance against a contract; returns list of error strings
    (empty when valid)."""
    if name not in _validators:
        get_schema(name)
    validator = _validators[name]["validator"]
    errors = []
    for err in sorted(validator.iter_errors(instance), key=lambda e: list(e.path)):
        errors.append(f"{'/'.join(str(p) for p in err.path)}: {err.message}")
    return errors


def is_valid_contract(name: str, instance: Any) -> bool:
    return len(validate_contract(name, instance)) == 0


def sha256_canonical(obj: Any) -> str:
    """Content hash over the canonical JSON of an object."""
    import hashlib
    canonical = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def contract_paths() -> dict[str, Path]:
    return {n: CONTRACTS_DIR / f"{n}.schema.json" for n in CONTRACT_NAMES}
