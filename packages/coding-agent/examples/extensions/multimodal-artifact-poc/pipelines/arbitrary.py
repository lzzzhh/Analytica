"""Governed declarative ingestion of frozen local CSV and Parquet sources."""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq
import jsonschema

from pipelines.batch.stages import _table_exists
from pipelines.common.config import open_catalog, sha256_file, write_json
from pipelines.common.write_gate import WriteGate
from pipelines.governance.repository import Repository

_TARGET_RE = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")
_CONTRACT_SCHEMA_PATH = (
    Path(__file__).resolve().parents[1] / "contracts" /
    "arbitrary-source-pipeline.schema.json"
)
_CONTRACT_SCHEMA = json.loads(_CONTRACT_SCHEMA_PATH.read_text(encoding="utf-8"))
jsonschema.Draft202012Validator.check_schema(_CONTRACT_SCHEMA)
_CONTRACT_VALIDATOR = jsonschema.Draft202012Validator(_CONTRACT_SCHEMA)
_TYPE_MAP: dict[str, pa.DataType] = {
    "string": pa.string(),
    "int64": pa.int64(),
    "integer": pa.int64(),
    "float64": pa.float64(),
    "double": pa.float64(),
    "boolean": pa.bool_(),
    "date": pa.date32(),
    "timestamp": pa.timestamp("us"),
}


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash_text(value: str) -> str:
    import hashlib
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_contract(path: Path) -> dict[str, Any]:
    contract = json.loads(path.read_text(encoding="utf-8"))
    errors = sorted(_CONTRACT_VALIDATOR.iter_errors(contract), key=lambda error: error.json_path)
    if errors:
        details = []
        for error in errors:
            location = ".".join(str(part) for part in error.absolute_path) or "$"
            details.append(f"{location}: {error.message}")
        raise ValueError(f"contract schema validation failed: {'; '.join(details)}")

    source = contract["source"]
    source_path = Path(source["path"])
    if not source_path.is_absolute() or not source_path.is_file():
        raise ValueError("source.path must be an existing absolute local file")
    expected_names = [field["name"] for field in contract.get("expectedSchema", [])]
    duplicate_names = sorted({name for name in expected_names if expected_names.count(name) > 1})
    if duplicate_names:
        raise ValueError(
            f"duplicate expectedSchema field names: {', '.join(duplicate_names)}")
    return contract


def read_source(contract: dict[str, Any]) -> pa.Table:
    path = Path(contract["source"]["path"])
    actual_hash = sha256_file(path)
    expected_hash = contract["source"]["sha256"].removeprefix("sha256:").lower()
    if actual_hash != expected_hash:
        raise ValueError(f"source hash mismatch: expected {expected_hash}, got {actual_hash}")
    if contract["source"]["format"] == "csv":
        return pacsv.read_csv(path)
    return pq.read_table(path)


def _finding(code: str, severity: str, detail: str, *, field: str | None = None,
             count: int = 0) -> dict[str, Any]:
    return {"code": code, "severity": severity, "field": field,
            "count": count, "detail": detail}


def _value_castable(value: Any, target_type: pa.DataType) -> bool:
    if value is None:
        return True
    try:
        pa.array([value]).cast(target_type, safe=True)
        return True
    except (pa.ArrowInvalid, pa.ArrowNotImplementedError, TypeError, ValueError):
        return False


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, datetime.min.time())
    elif value is None:
        return None
    else:
        text = str(value).strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def evaluate_quality(table: pa.Table, contract: dict[str, Any]) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    rules = contract["qualityRules"]
    expected = {field["name"]: field for field in contract.get("expectedSchema", [])}
    actual = set(table.column_names)
    expected_names = set(expected)

    if table.num_rows < int(rules.get("minRows", 1)):
        findings.append(_finding("ROW_COUNT_BELOW_MINIMUM", "ERROR",
                                 f"{table.num_rows} rows below minimum {rules.get('minRows', 1)}"))
    if rules.get("maxRows") is not None and table.num_rows > int(rules["maxRows"]):
        findings.append(_finding("ROW_COUNT_ABOVE_MAXIMUM", "ERROR",
                                 f"{table.num_rows} rows above maximum {rules['maxRows']}"))

    policy = contract["schemaPolicy"]
    if policy != "infer":
        for name in sorted(expected_names - actual):
            findings.append(_finding("SCHEMA_DRIFT_MISSING_COLUMN", "ERROR",
                                     f"expected column {name} is absent", field=name, count=1))
        for name in sorted(actual - expected_names):
            severity = "ERROR" if policy == "strict" else "WARN"
            findings.append(_finding("SCHEMA_DRIFT_UNEXPECTED_COLUMN", severity,
                                     f"unexpected column {name}", field=name, count=1))
        for name in sorted(expected_names & actual):
            type_name = expected[name].get("type")
            if type_name not in _TYPE_MAP:
                raise ValueError(f"unsupported expected type '{type_name}' for {name}")
            target_type = _TYPE_MAP[type_name]
            values = table.column(name).to_pylist()
            invalid = sum(1 for value in values if not _value_castable(value, target_type))
            if invalid:
                findings.append(_finding("TYPE_VIOLATION", "ERROR",
                                         f"{invalid} values cannot be cast to {type_name}",
                                         field=name, count=invalid))
                findings.append(_finding("SCHEMA_DRIFT_INCOMPATIBLE_TYPE", "ERROR",
                                         f"column {name} is incompatible with {type_name}",
                                         field=name, count=1))

    required = set(rules.get("requiredColumns", []))
    required.update(name for name, field in expected.items() if field.get("required"))
    for name in sorted(required - actual):
        findings.append(_finding("MISSING_REQUIRED_COLUMN", "ERROR",
                                 f"required column {name} is absent", field=name, count=1))
    for name in sorted(required & actual):
        missing = table.column(name).null_count
        if missing:
            findings.append(_finding("MISSING_REQUIRED_VALUE", "ERROR",
                                     f"{missing} required values are null", field=name, count=missing))

    primary_key = contract["primaryKey"]
    for name in sorted(set(primary_key) - actual):
        findings.append(_finding("MISSING_PRIMARY_KEY_COLUMN", "ERROR",
                                 f"primary-key column {name} is absent", field=name, count=1))
    if primary_key and all(name in actual for name in primary_key):
        rows = table.select(primary_key).to_pylist()
        null_keys = sum(
            1 for row in rows if any(row.get(name) is None for name in primary_key))
        if null_keys:
            findings.append(_finding(
                "NULL_PRIMARY_KEY", "ERROR",
                f"{null_keys} rows contain null primary-key values", count=null_keys))
        keys = [
            tuple(row.get(name) for name in primary_key)
            for row in rows if all(row.get(name) is not None for name in primary_key)
        ]
        duplicates = len(keys) - len(set(keys))
        if duplicates:
            findings.append(_finding("DUPLICATE_PRIMARY_KEY", "ERROR",
                                     f"{duplicates} duplicate primary-key rows", count=duplicates))

    event = contract.get("eventTime")
    if event and event.get("field") not in actual:
        findings.append(_finding(
            "MISSING_EVENT_TIME_COLUMN", "ERROR",
            f"event-time column {event.get('field')} is absent",
            field=event.get("field"), count=1))
    elif event and event.get("frequencySeconds") is not None:
        field = event["field"]
        raw_values = table.column(field).to_pylist()
        parsed_values = [_as_datetime(raw) for raw in raw_values]
        unparseable = sum(
            1 for raw, parsed in zip(raw_values, parsed_values)
            if raw is not None and parsed is None)
        if unparseable:
            findings.append(_finding(
                "EVENT_TIME_UNPARSEABLE", "ERROR",
                f"{unparseable} event-time values cannot be parsed",
                field=field, count=unparseable))
        parsed = sorted({value for value in parsed_values if value is not None})
        frequency = int(event["frequencySeconds"])
        tolerance = int(event.get("toleranceSeconds", 0))
        gaps = sum(1 for left, right in zip(parsed, parsed[1:])
                   if (right - left).total_seconds() > frequency + tolerance)
        if gaps:
            findings.append(_finding("EVENT_TIME_GAP", "ERROR",
                                     f"{gaps} event-time gaps exceed frequency+tolerance",
                                     field=field, count=gaps))

    status = "FAIL" if any(f["severity"] == "ERROR" for f in findings) else (
        "WARN" if findings else "PASS")
    return {"status": status, "rowCount": table.num_rows,
            "findings": findings, "evaluatedAt": datetime.now(timezone.utc).isoformat()}


def _cast_expected(table: pa.Table, contract: dict[str, Any]) -> pa.Table:
    if contract["schemaPolicy"] == "infer":
        return table
    expected = {field["name"]: field for field in contract["expectedSchema"]}
    names = [name for name in table.column_names if name in expected]
    arrays = [table.column(name).cast(_TYPE_MAP[expected[name]["type"]], safe=True) for name in names]
    return pa.Table.from_arrays(arrays, names=names)


def build_plan(contract: dict[str, Any], warehouse: Path, quality: dict[str, Any],
               governance_status: str) -> dict[str, Any]:
    contract_hash = _hash_text(_canonical_json(contract))
    return {
        "planVersion": "arbitrary-source-plan.v1",
        "planId": f"plan_{contract_hash[:16]}",
        "contractHash": f"sha256:{contract_hash}",
        "source": contract["source"],
        "target": contract["target"],
        "warehouse": str(warehouse),
        "schemaPolicy": contract["schemaPolicy"],
        "expectedSchema": contract.get("expectedSchema", []),
        "primaryKey": contract["primaryKey"],
        "eventTime": contract.get("eventTime"),
        "qualityRules": contract["qualityRules"],
        "transform": "identity_ingest",
        "qualityPreflight": quality,
        "governancePreflight": governance_status,
        "requiredStages": [
            "source_validation", "schema_validation", "governance_preflight",
            "target_resolution", "quality_evaluation", "warehouse_write", "lineage",
        ],
    }


def _preflight_gate(contract: dict[str, Any], governance_root: Path) -> tuple[WriteGate | None, str]:
    if not governance_root.is_dir() or not (governance_root / "ledger.jsonl").is_file():
        return None, "BLOCKED: governance repository does not exist"
    gate = WriteGate(Repository(governance_root), controlled={contract["target"]})
    try:
        gate.require_approved(contract["target"], contract["approvalId"])
    except PermissionError as error:
        return None, f"BLOCKED: {error}"
    return gate, "AUTHORIZED"


def _execution_manifest(plan: dict[str, Any], contract: dict[str, Any], warehouse: Path,
                        quality: dict[str, Any], stages: dict[str, dict[str, Any]],
                        run_id: str, snapshot_id: int | None = None,
                        error: str | None = None) -> dict[str, Any]:
    return {
        "manifestVersion": "arbitrary-source-execution.v1",
        "runId": run_id,
        "success": error is None and all(
            stage["status"] == "SUCCEEDED" for stage in stages.values()),
        "contractHash": plan["contractHash"],
        "warehouse": str(warehouse),
        "target": contract["target"],
        "sourceHash": f"sha256:{contract['source']['sha256'].removeprefix('sha256:')}",
        "approvalId": contract["approvalId"],
        "stages": stages,
        "quality": quality,
        "snapshotId": str(snapshot_id) if snapshot_id is not None else None,
        "error": error,
        "finishedAt": datetime.now(timezone.utc).isoformat(),
    }


def run_contract(contract_path: Path, warehouse: Path, governance_root: Path,
                 dry_run: bool = False) -> tuple[int, dict[str, Any]]:
    if not warehouse.is_absolute() or str(warehouse).startswith(("s3://", "gs://")):
        raise ValueError("warehouse must be an absolute local path")
    contract = load_contract(contract_path)
    table = read_source(contract)
    quality = evaluate_quality(table, contract)
    gate, governance_status = _preflight_gate(contract, governance_root)
    plan = build_plan(contract, warehouse, quality, governance_status)
    if dry_run:
        return (0 if quality["status"] != "FAIL" and gate is not None else 1), plan

    target = contract["target"]
    namespace = target.split(".", 1)[0]
    output_root = warehouse.parent / "pipeline-outputs"
    contract_hash = plan["contractHash"].removeprefix("sha256:")
    run_id = f"run_{contract_hash[:16]}"
    batch_id = f"batch_{contract_hash[:16]}"
    stages = {name: {"status": "PENDING"} for name in plan["requiredStages"]}
    for name in ("source_validation", "schema_validation", "target_resolution"):
        stages[name] = {"status": "SUCCEEDED"}
    stages["governance_preflight"] = {
        "status": "SUCCEEDED" if gate is not None else "BLOCKED",
        "detail": governance_status,
    }
    stages["quality_evaluation"] = {
        "status": "FAILED" if quality["status"] == "FAIL" else "SUCCEEDED",
    }
    write_json(output_root / "plans" / f"{plan['planId']}.json", plan)
    write_json(output_root / "quality" / f"quality-{run_id}.json", quality)

    if quality["status"] == "FAIL" or gate is None:
        stages["warehouse_write"] = {"status": "BLOCKED"}
        stages["lineage"] = {"status": "NOT_RUN"}
        error = (
            "quality preflight failed; warehouse write refused"
            if quality["status"] == "FAIL" else governance_status)
        manifest = _execution_manifest(
            plan, contract, warehouse, quality, stages, run_id, error=error)
        write_json(output_root / "manifests" / f"execution-{run_id}.json", manifest)
        if quality["status"] == "FAIL":
            raise ValueError(error)
        raise PermissionError(error)

    try:
        catalog = open_catalog(warehouse)
        catalog.create_namespace_if_not_exists(namespace)
    except Exception as error:
        stages["warehouse_write"] = {"status": "FAILED"}
        stages["lineage"] = {"status": "NOT_RUN"}
        manifest = _execution_manifest(
            plan, contract, warehouse, quality, stages, run_id,
            error=f"{type(error).__name__}: {error}")
        write_json(output_root / "manifests" / f"execution-{run_id}.json", manifest)
        raise

    before = None
    try:
        if _table_exists(catalog, target):
            snapshot = catalog.load_table(target).current_snapshot()
            before = snapshot.snapshot_id if snapshot else None
        cast_table = _cast_expected(table, contract)
        snapshot_id = gate.publish(
            catalog, target, cast_table,
            approval_id=contract["approvalId"], batch_id=batch_id)
    except Exception as error:
        stages["warehouse_write"] = {"status": "FAILED"}
        stages["lineage"] = {"status": "NOT_RUN"}
        manifest = _execution_manifest(
            plan, contract, warehouse, quality, stages, run_id,
            error=f"{type(error).__name__}: {error}")
        write_json(output_root / "manifests" / f"execution-{run_id}.json", manifest)
        raise

    stages["warehouse_write"] = {
        "status": "SUCCEEDED", "snapshotId": str(snapshot_id),
        "idempotentReplay": before == snapshot_id,
    }

    lineage = {
        "lineageVersion": "arbitrary-source-lineage.v1",
        "runId": run_id,
        "source": {"path": contract["source"]["path"],
                   "contentHash": f"sha256:{contract['source']['sha256'].removeprefix('sha256:')}"},
        "transform": "identity_ingest",
        "outputs": [{"table": target, "snapshotId": str(snapshot_id)}],
        "quality": quality,
        "approval": {"approvalId": contract["approvalId"], "status": "AUTHORIZED"},
        "runManifest": f"execution-{run_id}.json",
    }
    stages["lineage"] = {"status": "SUCCEEDED"}
    manifest = _execution_manifest(
        plan, contract, warehouse, quality, stages, run_id, snapshot_id=snapshot_id)
    write_json(output_root / "lineage" / f"lineage-{run_id}.json", lineage)
    write_json(output_root / "manifests" / f"execution-{run_id}.json", manifest)
    return 0, manifest
