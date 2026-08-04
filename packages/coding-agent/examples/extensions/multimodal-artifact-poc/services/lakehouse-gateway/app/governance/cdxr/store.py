"""Governance table store — 17 tables across governance_meta/ods/dwd/dws/ads.

Written ONLY by the standalone governance CLI/job (read-only gateway never
writes). Tables are Iceberg tables in the same SQL catalog as the business
layer, under dedicated namespaces.

Write model: every table appends (each run is a versioned record set keyed by
run/snapshot/updated_at). "Latest state" views are resolved at read time by
the governance reader (e.g. latest trust profile per dataset) — a full-table
overwrite would clobber other datasets' records.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import pyarrow as pa
from pyiceberg.catalog import Catalog
from pyiceberg.schema import Schema
from pyiceberg.table import Table
from pyiceberg.types import DoubleType, LongType, NestedField, StringType

NS_META = "governance_meta"
NS_ODS = "governance_ods"
NS_DWD = "governance_dwd"
NS_DWS = "governance_dws"
NS_ADS = "governance_ads"
ALL_NAMESPACES = (NS_META, NS_ODS, NS_DWD, NS_DWS, NS_ADS)

# table name -> columns (all tables are append-only; readers resolve latest)
GOVERNANCE_TABLES: dict[str, list[tuple[str, str]]] = {
    f"{NS_META}.cdxr_rule_registry": (
        [("rule_id", "string"), ("rule_name", "string"), ("dimension", "string"),
         ("description", "string"), ("default_severity", "string"),
         ("params", "string"), ("registered_at", "string")]),
    f"{NS_META}.cdxr_policy_registry": (
        [("policy_name", "string"), ("rule_ids", "string"), ("params", "string"),
         ("registered_at", "string")]),
    f"{NS_ODS}.cdxr_run_raw": (
        [("run_id", "string"), ("dataset_id", "string"), ("snapshot_id", "string"),
         ("run_type", "string"), ("raw_payload", "string"), ("event_at", "string")]),
    f"{NS_ODS}.cdxr_evidence_raw": (
        [("evidence_id", "string"), ("run_id", "string"), ("dataset_id", "string"),
         ("source_type", "string"), ("source_reference", "string"),
         ("raw_payload", "string"), ("event_at", "string")]),
    f"{NS_ODS}.cdxr_review_event_raw": (
        [("review_id", "string"), ("finding_id", "string"), ("action", "string"),
         ("event_payload", "string"), ("event_at", "string")]),
    f"{NS_DWD}.cdxr_run": (
        [("run_id", "string"), ("dataset_id", "string"), ("dataset_layer", "string"),
         ("snapshot_id", "string"), ("status", "string"), ("started_at", "string"),
         ("finished_at", "string"), ("rules_executed", "long"), ("findings_created", "long"),
         ("findings_reopened", "long"), ("error", "string")]),
    f"{NS_DWD}.cdxr_finding": (
        [("finding_id", "string"), ("run_id", "string"), ("rule_id", "string"),
         ("dataset_id", "string"), ("field_name", "string"), ("risk_type", "string"),
         ("risk_status", "string"), ("severity", "string"), ("confidence", "double"),
         ("reason_codes", "string"), ("evidence_refs", "string"),
         ("snapshot_id", "string"), ("data_version", "string"),
         ("quality_reference", "string"), ("lineage_reference", "string"),
         ("status", "string"), ("first_detected_at", "string"),
         ("last_detected_at", "string"), ("created_at", "string"),
         ("recommendation", "string"), ("summary", "string")]),
    f"{NS_DWD}.cdxr_evidence": (
        [("evidence_id", "string"), ("finding_id", "string"), ("source_type", "string"),
         ("source_reference", "string"), ("source_snapshot", "string"),
         ("observed_value", "string"), ("expected_value", "string"),
         ("confidence", "double"), ("evaluator_version", "string"),
         ("created_at", "string")]),
    f"{NS_DWD}.cdxr_rule_result": (
        [("run_id", "string"), ("dataset_id", "string"), ("rule_id", "string"),
         ("passed", "string"), ("result_count", "long"), ("detail", "string"),
         ("evaluated_at", "string")]),
    f"{NS_DWD}.cdxr_review_action": (
        [("review_id", "string"), ("finding_id", "string"), ("action", "string"),
         ("previous_status", "string"), ("new_status", "string"), ("reviewer", "string"),
         ("reason", "string"), ("created_at", "string")]),
    f"{NS_DWS}.cdxr_dataset_score_daily": (
        [("dataset_id", "string"), ("score_date", "string"), ("governance_score", "double"),
         ("status", "string"), ("open_finding_count", "long"), ("highest_severity", "string"),
         ("generated_at", "string")]),
    f"{NS_DWS}.cdxr_dimension_summary": (
        [("dataset_id", "string"), ("snapshot_id", "string"), ("dimension", "string"),
         ("score", "double"), ("open_finding_count", "long"), ("updated_at", "string")]),
    f"{NS_DWS}.cdxr_issue_trend": (
        [("dataset_id", "string"), ("date_day", "string"), ("rule_id", "string"),
         ("open_count", "long"), ("new_count", "long"), ("resolved_count", "long"),
         ("updated_at", "string")]),
    f"{NS_DWS}.cdxr_rule_coverage": (
        [("dataset_id", "string"), ("rule_id", "string"), ("executed", "string"),
         ("findings_count", "long"), ("last_run_at", "string")]),
    f"{NS_ADS}.dataset_trust_profile": (
        [("dataset_id", "string"), ("snapshot_id", "string"), ("governance_score", "double"),
         ("status", "string"), ("open_finding_count", "long"), ("highest_severity", "string"),
         ("dimension_scores", "string"), ("quality_status", "string"),
         ("quality_reference", "string"), ("lineage_reference", "string"),
         ("finding_ids", "string"), ("generated_at", "string"),
         ("rule_count", "long"), ("failed_rule_count", "long")]),
    f"{NS_ADS}.governance_review_queue": (
        [("finding_id", "string"), ("dataset_id", "string"), ("severity", "string"),
         ("confidence", "double"), ("summary", "string"), ("queued_at", "string"),
         ("assignee", "string")]),
    f"{NS_ADS}.governance_alert": (
        [("alert_id", "string"), ("dataset_id", "string"), ("finding_id", "string"),
         ("severity", "string"), ("message", "string"), ("alert_at", "string")]),
}


def _schema_for(table_name: str) -> Schema:
    cols = GOVERNANCE_TABLES[table_name]
    types = {"string": StringType(), "double": DoubleType(), "long": LongType()}
    return Schema(*[NestedField(i + 1, name, types[t]) for i, (name, t) in enumerate(cols)])


def ensure_governance_tables(catalog: Catalog) -> list[str]:
    """Create namespaces + tables if missing; evolve existing tables whose
    schema predates the current GOVERNANCE_TABLES definition (review round-4
    P1: append-only writes fail with 'PyArrow table contains more columns'
    when a pre-existing Iceberg table lacks newly added columns)."""
    existing = {tuple(n) for n in catalog.list_namespaces()}
    for ns in ALL_NAMESPACES:
        if tuple(ns.split(".")) not in existing:
            catalog.create_namespace(ns)
            existing.add(tuple(ns.split(".")))
    created: list[str] = []
    types = {"string": StringType(), "double": DoubleType(), "long": LongType()}
    for name in GOVERNANCE_TABLES:
        try:
            table = catalog.load_table(name)
        except Exception:
            catalog.create_table(name, _schema_for(name))
            created.append(name)
            continue
        missing = [col for col in GOVERNANCE_TABLES[name]
                   if col[0] not in {f.name for f in table.schema().fields}]
        if missing:
            update = table.update_schema()
            for col_name, t in missing:
                update.add_column(col_name, types[t])
            update.commit()
    return created


def write_rows(catalog: Catalog, table_name: str, rows: list[dict[str, Any]],
               now: str | None = None) -> str:
    """Append rows into a governance table (versioned, read-side dedup)."""
    if not rows:
        return ""
    table: Table = catalog.load_table(table_name)
    table.append(pa.Table.from_pylist(rows))
    snap = table.current_snapshot()
    return str(snap.snapshot_id) if snap else ""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)
