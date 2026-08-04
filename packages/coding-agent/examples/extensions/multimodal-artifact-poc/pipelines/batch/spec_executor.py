"""Spec-driven execution — the missing link between approval and write.

A governed run does NOT hand-roll pyiceberg writes. Instead it loads the
APPROVED pipeline spec (sealed at Gate 1), applies the approved field
mappings from the SchemaSpec, and writes through the WriteGate with the
approval id bound. This closes the loop the architecture requires:

    design -> review -> APPROVE -> seal -> execute_approved_spec -> write

The executor never executes a spec that is not sealed-approved (the gate
rejects it), never bypasses the gate, and records the approval binding.
"""
from __future__ import annotations

from typing import Any, Optional

import pyarrow as pa


def _apply_field_mappings(table: pa.Table, field_mappings: list[dict]) -> pa.Table:
    """Apply approved field mappings: rename source -> target and cast to the
    approved target type (best effort; unknown types pass through)."""
    rename = {m.get("sourceField"): m.get("targetField")
              for m in field_mappings if m.get("sourceField") != m.get("targetField")}
    table = table.rename_columns([rename.get(n, n) for n in table.column_names])
    casts = {}
    for m in field_mappings:
        ttype = (m.get("targetType") or "").lower()
        target = m.get("targetField")
        if target and ttype == "long":
            casts[target] = pa.int64()
        elif target and ttype in ("double", "float"):
            casts[target] = pa.float64()
        elif target and ttype in ("string", "str"):
            casts[target] = pa.string()
    if casts:
        table = table.cast(pa.schema([
            pa.field(n, casts.get(n, f.type)) for n, f in zip(table.column_names, table.schema)
        ]))
    return table


def execute_approved_spec(
    gate: Any,
    catalog: Any,
    pipeline_spec: dict,
    schema_spec: dict,
    source_table: pa.Table,
    approval_id: str,
) -> int:
    """Execute an APPROVED pipeline spec: map fields per the SchemaSpec and
    write the target through the WriteGate bound to the approval.

    Raises PermissionError when the spec is not sealed-approved for the
    target (the gate enforces it — nothing executes unapproved).
    """
    target = pipeline_spec["target"]
    gate.require_approved(target, approval_id=approval_id)
    mapped = _apply_field_mappings(source_table, schema_spec.get("fieldMappings") or [])
    return gate.publish(catalog, target, mapped, approval_id=approval_id)
