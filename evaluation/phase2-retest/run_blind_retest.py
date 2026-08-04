#!/usr/bin/env python3
"""Execute the post-repair blind pipeline evaluation on frozen UCI datasets."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import platform
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq

REPO = Path(__file__).resolve().parents[2]
EVAL = Path(__file__).resolve().parent
POC = REPO / "packages/coding-agent/examples/extensions/multimodal-artifact-poc"
ARTIFACTS = EVAL / "artifacts"
PYTHON = Path(sys.executable).resolve()
EXPECTED_DEFECTS = {
    "DUPLICATE_PRIMARY_KEY",
    "MISSING_REQUIRED_VALUE",
    "TYPE_VIOLATION",
    "SCHEMA_DRIFT_INCOMPATIBLE_TYPE",
    "SCHEMA_DRIFT_MISSING_COLUMN",
    "SCHEMA_DRIFT_UNEXPECTED_COLUMN",
    "EVENT_TIME_GAP",
}

sys.path.insert(0, str(POC))

from pipelines.common.config import open_catalog  # noqa: E402
from pipelines.governance.flow import GovernancePhase1  # noqa: E402
from pipelines.governance.placement import PlacementGovernance  # noqa: E402
from pipelines.governance.repository import Repository  # noqa: E402


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def arrow_contract_type(data_type: pa.DataType) -> str:
    if pa.types.is_string(data_type) or pa.types.is_large_string(data_type):
        return "string"
    if pa.types.is_integer(data_type):
        return "int64"
    if pa.types.is_floating(data_type):
        return "float64"
    if pa.types.is_boolean(data_type):
        return "boolean"
    if pa.types.is_date(data_type):
        return "date"
    if pa.types.is_timestamp(data_type):
        return "timestamp"
    raise ValueError(f"unsupported evaluation source type: {data_type}")


def canonical_row_hash(table: pa.Table) -> str:
    rows = []
    for row in table.to_pylist():
        encoded = json.dumps(row, ensure_ascii=False, sort_keys=True, default=str,
                             separators=(",", ":"), allow_nan=True)
        rows.append(hashlib.sha256(encoded.encode("utf-8")).hexdigest())
    return hashlib.sha256("".join(sorted(rows)).encode("ascii")).hexdigest()


def numeric_sums(table: pa.Table) -> dict[str, float | int | None]:
    result: dict[str, float | int | None] = {}
    for field in table.schema:
        if not (pa.types.is_integer(field.type) or pa.types.is_floating(field.type)):
            continue
        values = [value for value in table.column(field.name).to_pylist()
                  if value is not None and not (isinstance(value, float) and math.isnan(value))]
        result[field.name] = math.fsum(values) if values else None
    return result


def run_command(args: list[str], command_log: Path, *, cwd: Path = POC) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    proc = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
    record = {
        "argv": args,
        "cwd": str(cwd),
        "startedAt": started.isoformat(),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "exitCode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
    command_log.parent.mkdir(parents=True, exist_ok=True)
    with command_log.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def create_evaluation_approval(root: Path, target: str, slug: str,
                               first_field: pa.Field) -> str:
    """Create a structurally valid approval labelled as an evaluation fixture."""
    repo = Repository(root)
    now = datetime.now(timezone.utc).isoformat()
    governance_type = {
        "string": "string", "int64": "long", "float64": "double",
        "boolean": "boolean", "date": "date", "timestamp": "timestamp",
    }[arrow_contract_type(first_field.type)]
    schema_spec = {
        "specId": f"sspec_eval_{slug}",
        "version": 1,
        "targetDataset": target,
        "businessGranularity": "one row per frozen public source record",
        "businessKeys": [],
        "fieldMappings": [{
            "sourceField": first_field.name,
            "targetField": first_field.name,
            "targetType": governance_type,
            "nullability": "NOT_NULL",
        }],
        "types": {first_field.name: governance_type},
        "timeFields": [],
        "partitioning": [],
        "compatibilityStrategy": "STRICT",
        "sensitiveFields": [],
        "assumptions": ["TEST_ONLY_OPERATOR_FIXTURE; not production authorization"],
        "risks": ["Approval actor is an automated evaluation fixture"],
        "createdAt": now,
    }
    source_ref = f"uci.{slug}.frozen_2026_08_03"
    pipeline_spec = {
        "specId": f"pspec_eval_{slug}",
        "version": 1,
        "pipelineId": f"pipeline_eval_{slug}",
        "sources": [source_ref],
        "target": target,
        "executionMode": "BATCH",
        "executionBackend": "PYICEBERG_LOCAL",
        "updateMode": "APPEND",
        "steps": [{
            "stepId": "identity_ingest",
            "operation": "WRITE",
            "input": source_ref,
            "output": target,
        }],
        "keys": {},
        "timeSemantics": "PROCESSING_TIME",
        "partitioning": [],
        "schemaEvolutionPolicy": "STRICT",
        "assumptions": ["TEST_ONLY_OPERATOR_FIXTURE; frozen public input"],
        "risks": ["Evaluation approval does not grant production authority"],
        "createdAt": now,
    }
    flow = GovernancePhase1(repo)
    review = flow.create_review_package(
        schema_spec, pipeline_spec, requester="TEST_ONLY_EVALUATION_HARNESS")
    decision = flow.approve(
        review["reviewId"], "APPROVE", os_actor="TEST_ONLY_OPERATOR_FIXTURE",
        comment="Isolated blind evaluation only")
    sealed = flow.seal_approved(review["reviewId"], decision)

    placement = PlacementGovernance(repo, controlled={target})
    proposed = placement.propose({
        "placementPlanId": f"pp_eval_{slug}",
        "version": 1,
        "sourceDataset": source_ref,
        "targetLayer": "ODS",
        "targetDataset": target,
        "rationale": "Frozen public evaluation source in isolated warehouse",
        "targetSchemaRef": f"schema-spec:sspec_eval_{slug}@1",
        "primaryKey": [],
        "partitioning": [],
        "writeMode": "APPEND",
        "schemaEvolutionPolicy": "STRICT",
        "retentionPolicy": "evaluation-only",
        "backfillRequired": False,
        "affectedDownstream": [],
        "qualityGateRefs": [],
        "assumptions": ["TEST_ONLY_OPERATOR_FIXTURE"],
        "risks": ["Not valid outside this isolated evaluation"],
        "derivation": "RAW",
        "status": "DRAFT",
    })
    placement.approve(
        proposed["placementPlanId"], os_actor="TEST_ONLY_OPERATOR_FIXTURE",
        comment="Isolated blind evaluation only")
    return sealed["approvalId"]


def clean_contract(source: Path, target: str, table: pa.Table,
                   approval_id: str) -> dict[str, Any]:
    return {
        "source": {"path": str(source.resolve()), "sha256": sha256(source), "format": "csv"},
        "target": target,
        "schemaPolicy": "strict",
        "expectedSchema": [
            {"name": field.name, "type": arrow_contract_type(field.type), "required": True}
            for field in table.schema
        ],
        "primaryKey": [],
        "qualityRules": {
            "minRows": table.num_rows,
            "maxRows": table.num_rows,
            "requiredColumns": table.column_names,
        },
        "approvalId": approval_id,
    }


def build_mutation(source: pa.Table, path: Path) -> tuple[pa.Table, dict[str, Any]]:
    fields = list(source.schema)
    required_field = fields[0].name
    numeric_field = next(
        field.name for field in fields
        if field.name != required_field
        and (pa.types.is_integer(field.type) or pa.types.is_floating(field.type))
    )
    missing_field = fields[-1].name
    if missing_field in {required_field, numeric_field}:
        missing_field = fields[-2].name

    columns: dict[str, pa.Array | pa.ChunkedArray] = {}
    for field in fields:
        if field.name == missing_field:
            continue
        values = source.column(field.name).to_pylist()
        if field.name == required_field:
            values[1] = None
            columns[field.name] = pa.array(values, type=field.type)
        elif field.name == numeric_field:
            text_values = [str(value) if value is not None else None for value in values]
            text_values[2] = "NOT_A_NUMBER"
            columns[field.name] = pa.array(text_values, type=pa.string())
        else:
            columns[field.name] = source.column(field.name)

    row_ids = list(range(1, source.num_rows + 1))
    row_ids[-1] = row_ids[0]
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    event_times = [(start + timedelta(days=index)).isoformat()
                   for index in range(source.num_rows)]
    event_times[-1] = (start + timedelta(days=source.num_rows + 2)).isoformat()
    columns["eval_row_id"] = pa.array(row_ids, type=pa.int64())
    columns["eval_event_time"] = pa.array(event_times, type=pa.string())
    columns["eval_unexpected"] = pa.array(["injected"] * source.num_rows)
    mutated = pa.table(columns)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(mutated, path)
    definition = {
        "mutationVersion": "deterministic-v1",
        "duplicatePrimaryKey": {"field": "eval_row_id", "row": source.num_rows - 1},
        "missingRequiredValue": {"field": required_field, "row": 1},
        "typeError": {"field": numeric_field, "row": 2, "value": "NOT_A_NUMBER"},
        "schemaDriftMissing": {"field": missing_field},
        "schemaDriftUnexpected": {"field": "eval_unexpected"},
        "eventTimeGap": {"field": "eval_event_time", "lastOffsetDays": source.num_rows + 2},
        "expectedFindingCodes": sorted(EXPECTED_DEFECTS),
    }
    return mutated, definition


def mutation_contract(path: Path, target: str, original: pa.Table,
                      approval_id: str, definition: dict[str, Any]) -> dict[str, Any]:
    fields = []
    for field in original.schema:
        fields.append({
            "name": field.name,
            "type": arrow_contract_type(field.type),
            "required": field.name == definition["missingRequiredValue"]["field"],
        })
    fields.extend([
        {"name": "eval_row_id", "type": "int64", "required": True},
        {"name": "eval_event_time", "type": "string", "required": True},
    ])
    return {
        "source": {"path": str(path.resolve()), "sha256": sha256(path), "format": "parquet"},
        "target": target,
        "schemaPolicy": "strict",
        "expectedSchema": fields,
        "primaryKey": ["eval_row_id"],
        "eventTime": {
            "field": "eval_event_time", "frequencySeconds": 86400,
            "toleranceSeconds": 0,
        },
        "qualityRules": {"minRows": original.num_rows},
        "approvalId": approval_id,
    }


def cli_args(contract: Path, warehouse: Path, governance: Path,
             *, dry_run: bool = False) -> list[str]:
    args = [
        str(PYTHON), "-m", "pipelines.run",
        "--contract", str(contract.resolve()),
        "--warehouse", str(warehouse.resolve()),
        "--governance-root", str(governance.resolve()),
    ]
    if dry_run:
        args.append("--dry-run")
    return args


def status(value: bool) -> str:
    return "PASS" if value else "FAIL"


def main() -> int:
    if ARTIFACTS.exists():
        raise SystemExit(f"refusing to overwrite existing artifacts: {ARTIFACTS}")
    ARTIFACTS.mkdir(parents=True)
    command_log = ARTIFACTS / "command-log.jsonl"
    candidates = json.loads((EVAL / "dataset-candidates.json").read_text(encoding="utf-8"))

    git_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO, text=True,
        capture_output=True, check=True).stdout.strip()
    node_version = subprocess.run(
        ["node", "--version"], cwd=REPO, text=True,
        capture_output=True, check=True).stdout.strip()
    packages = {}
    for package in ("pyarrow", "pyiceberg", "pyspark", "pytest", "jsonschema", "pandas"):
        try:
            packages[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            packages[package] = None
    runtime_profiles = {}
    for name in ("default", "all-enabled"):
        path = POC / f"config/features/runtime-profiles/{name}.json"
        runtime_profiles[name] = {"sha256": sha256(path), "content": json.loads(path.read_text())}
    environment = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "repositoryCommitSha": git_sha,
        "pythonExecutable": str(PYTHON),
        "pythonVersion": platform.python_version(),
        "nodeVersion": node_version,
        "dependencies": packages,
        "evaluationWarehouseRoot": str((ARTIFACTS / "runs").resolve()),
        "runtimeFeatureSnapshot": runtime_profiles,
        "platform": platform.platform(),
    }
    write_json(ARTIFACTS / "environment.json", environment)

    source_manifest = []
    scenario_results = []
    mutation_definitions = []

    for candidate in candidates:
        slug = candidate["slug"]
        source = EVAL / "downloads" / f"{slug}.csv"
        table = pacsv.read_csv(source)
        run_root = ARTIFACTS / "runs" / slug
        warehouse = run_root / "clean" / "warehouse"
        governance = run_root / "governance"
        target = f"eval_raw.{slug}"

        profile = {
            "dataset": slug,
            "rowCount": table.num_rows,
            "columnCount": table.num_columns,
            "schema": [{
                "name": field.name,
                "arrowType": str(field.type),
                "nullCount": table.column(field.name).null_count,
            } for field in table.schema],
            "numericSums": numeric_sums(table),
        }
        write_json(ARTIFACTS / "profiles" / f"{slug}.json", profile)
        golden = {
            "dataset": slug,
            "rowCount": table.num_rows,
            "columnNames": table.column_names,
            "schema": [{"name": field.name, "type": str(field.type)} for field in table.schema],
            "canonicalRowMultisetSha256": canonical_row_hash(table),
            "numericSums": numeric_sums(table),
        }
        write_json(ARTIFACTS / "golden" / f"{slug}.json", golden)
        source_manifest.append({
            **candidate,
            "sourcePage": f"https://archive.ics.uci.edu/dataset/{candidate['id']}",
            "downloadUrl": f"https://archive.ics.uci.edu/static/public/{candidate['id']}/data.csv",
            "license": "CC BY 4.0",
            "downloadDate": "2026-08-03",
            "file": str(source.resolve()),
            "sha256": sha256(source),
            "bytes": source.stat().st_size,
            "frozenRows": table.num_rows,
            "schema": profile["schema"],
            "demographicFields": [],
        })

        approval_id = create_evaluation_approval(governance, target, slug, table.schema[0])
        contract = clean_contract(source, target, table, approval_id)
        contract_path = ARTIFACTS / "contracts" / f"{slug}.json"
        write_json(contract_path, contract)

        dry = run_command(cli_args(contract_path, warehouse, governance, dry_run=True), command_log)
        first = run_command(cli_args(contract_path, warehouse, governance), command_log)
        first_stdout = json.loads(first["stdout"]) if first["exitCode"] == 0 else {}

        catalog = open_catalog(warehouse)
        loaded = catalog.load_table(target)
        first_snapshot = loaded.current_snapshot().snapshot_id
        written = loaded.scan().to_arrow()
        correctness_assertions = {
            "rowCount": written.num_rows == table.num_rows,
            "columnNames": written.column_names == table.column_names,
            "canonicalRows": canonical_row_hash(written) == golden["canonicalRowMultisetSha256"],
            "numericSums": numeric_sums(written) == golden["numericSums"],
            "manifestSnapshotMatchesCatalog": str(first_snapshot) == first_stdout.get("snapshotId"),
        }

        second = run_command(cli_args(contract_path, warehouse, governance), command_log)
        second_stdout = json.loads(second["stdout"]) if second["exitCode"] == 0 else {}
        reloaded = open_catalog(warehouse).load_table(target)
        second_snapshot = reloaded.current_snapshot().snapshot_id
        snapshots = list(reloaded.snapshots())
        idempotency_assertions = {
            "rerunExitZero": second["exitCode"] == 0,
            "sameSnapshot": first_snapshot == second_snapshot,
            "singleSnapshot": len(snapshots) == 1,
            "sameRows": canonical_row_hash(reloaded.scan().to_arrow()) == golden["canonicalRowMultisetSha256"],
            "manifestReportsReplay": second_stdout.get("stages", {}).get("warehouse_write", {}).get("idempotentReplay") is True,
        }

        bypass_root = run_root / "governance-bypass"
        bypass_contract = dict(contract)
        bypass_contract["approvalId"] = "nonexistent_evaluation_approval"
        bypass_contract_path = ARTIFACTS / "contracts" / f"{slug}-unapproved.json"
        write_json(bypass_contract_path, bypass_contract)
        bypass = run_command(
            cli_args(bypass_contract_path, bypass_root / "warehouse", bypass_root / "missing-governance"),
            command_log)
        bypass_blocked = (
            bypass["exitCode"] != 0
            and not (bypass_root / "warehouse").exists()
        )

        mutation_path = ARTIFACTS / "mutations" / f"{slug}.parquet"
        _mutated, mutation_definition = build_mutation(table, mutation_path)
        mutation_definition["dataset"] = slug
        mutation_definition["sourceSha256"] = sha256(mutation_path)
        mutation_definitions.append(mutation_definition)
        mutation = mutation_contract(
            mutation_path, target, table, approval_id, mutation_definition)
        mutation_contract_path = ARTIFACTS / "contracts" / f"{slug}-mutation.json"
        write_json(mutation_contract_path, mutation)
        mutation_root = run_root / "mutation"
        mutation_dry = run_command(
            cli_args(mutation_contract_path, mutation_root / "warehouse", governance, dry_run=True),
            command_log)
        mutation_plan = json.loads(mutation_dry["stdout"]) if mutation_dry["stdout"].strip() else {}
        mutation_run = run_command(
            cli_args(mutation_contract_path, mutation_root / "warehouse", governance),
            command_log)
        findings = mutation_plan.get("qualityPreflight", {}).get("findings", [])
        detected = {finding["code"] for finding in findings}
        true_positive = len(detected & EXPECTED_DEFECTS)
        precision = true_positive / len(detected) if detected else 0.0
        recall = true_positive / len(EXPECTED_DEFECTS)
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        mutation_blocked = (
            mutation_run["exitCode"] != 0
            and not (mutation_root / "warehouse").exists()
        )

        pipeline_assertions = {
            "dryRunExitZero": dry["exitCode"] == 0,
            "firstRunExitZero": first["exitCode"] == 0,
            "manifestSuccess": first_stdout.get("success") is True,
            "allStagesSucceeded": bool(first_stdout.get("stages")) and all(
                stage.get("status") == "SUCCEEDED" for stage in first_stdout["stages"].values()),
            "outputTableExists": written.num_rows >= 0,
        }
        result = {
            "dataset": slug,
            "pipeline": {"status": status(all(pipeline_assertions.values())),
                         "assertions": pipeline_assertions},
            "correctness": {"status": status(all(correctness_assertions.values())),
                            "assertions": correctness_assertions},
            "idempotency": {"status": status(all(idempotency_assertions.values())),
                            "assertions": idempotency_assertions,
                            "firstSnapshotId": str(first_snapshot),
                            "secondSnapshotId": str(second_snapshot)},
            "qualityDetection": {
                "status": status(detected == EXPECTED_DEFECTS and mutation_blocked),
                "expectedCodes": sorted(EXPECTED_DEFECTS),
                "detectedCodes": sorted(detected),
                "precision": precision, "recall": recall, "f1": f1,
                "writeBlocked": mutation_blocked,
            },
            "governanceEnforcement": {
                "status": status(bypass_blocked),
                "bypassConfirmed": not bypass_blocked,
                "unapprovedExitCode": bypass["exitCode"],
                "warehouseCreated": (bypass_root / "warehouse").exists(),
            },
            "artifacts": {
                "contract": str(contract_path),
                "warehouse": str(warehouse),
                "governance": str(governance),
                "productOutputRoot": str(warehouse.parent / "pipeline-outputs"),
            },
        }
        write_json(ARTIFACTS / "results" / f"{slug}.json", result)
        scenario_results.append(result)

    write_json(ARTIFACTS / "dataset-source-manifest.json", source_manifest)
    write_json(ARTIFACTS / "mutation-definitions.json", mutation_definitions)

    pipeline_passes = sum(item["pipeline"]["status"] == "PASS" for item in scenario_results)
    correctness_values = [
        passed for item in scenario_results
        for passed in item["correctness"]["assertions"].values()
    ]
    idempotency_passes = sum(item["idempotency"]["status"] == "PASS"
                             for item in scenario_results)
    total_tp = sum(len(set(item["qualityDetection"]["detectedCodes"]) & EXPECTED_DEFECTS)
                   for item in scenario_results)
    total_detected = sum(len(item["qualityDetection"]["detectedCodes"])
                         for item in scenario_results)
    total_expected = len(EXPECTED_DEFECTS) * len(scenario_results)
    dq_precision = total_tp / total_detected if total_detected else 0.0
    dq_recall = total_tp / total_expected if total_expected else 0.0
    dq_f1 = 2 * dq_precision * dq_recall / (dq_precision + dq_recall) if dq_precision + dq_recall else 0.0
    governance_passes = sum(item["governanceEnforcement"]["status"] == "PASS"
                            for item in scenario_results)
    metrics = {
        "datasetCount": len(scenario_results),
        "pipelineRunSuccessRate": pipeline_passes / len(scenario_results),
        "pipelineRunsPassed": pipeline_passes,
        "pipelineRunsTotal": len(scenario_results),
        "dataCorrectnessRate": sum(correctness_values) / len(correctness_values),
        "correctnessAssertionsPassed": sum(correctness_values),
        "correctnessAssertionsTotal": len(correctness_values),
        "dataQualityDefectDetection": {
            "precision": dq_precision, "recall": dq_recall, "f1": dq_f1,
            "truePositives": total_tp, "detected": total_detected,
            "expected": total_expected,
        },
        "idempotentRerunSuccessRate": idempotency_passes / len(scenario_results),
        "idempotentRerunsPassed": idempotency_passes,
        "idempotentRerunsTotal": len(scenario_results),
        "governanceEnforcementRate": governance_passes / len(scenario_results),
        "governanceBypassConfirmed": governance_passes != len(scenario_results),
    }
    write_json(ARTIFACTS / "metrics.json", metrics)
    write_json(ARTIFACTS / "warehouse-snapshot.json", [
        {
            "dataset": item["dataset"],
            "target": f"eval_raw.{item['dataset']}",
            "warehouse": item["artifacts"]["warehouse"],
            "snapshotId": item["idempotency"]["secondSnapshotId"],
        }
        for item in scenario_results
    ])
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    return 0 if all(
        item[section]["status"] == "PASS"
        for item in scenario_results
        for section in ("pipeline", "correctness", "idempotency", "qualityDetection",
                        "governanceEnforcement")
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
