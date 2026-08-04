"""Regression tests for governed arbitrary-source ingestion."""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipelines.arbitrary import evaluate_quality, load_contract, run_contract
from pipelines.batch.engine import ENGINE_SPARK, run_batch_with_engine
from pipelines.batch.run_batch import run_batch
from pipelines.batch.stages import _create_table, _upsert_overwrite
from pipelines.common.config import PipelineConfig, open_catalog
from pipelines.common.write_gate import WriteGate
from pipelines.governance.flow import GovernancePhase1
from pipelines.governance.placement import PlacementGovernance
from pipelines.governance.repository import Repository
from pipelines.run import main


def _approved_repo(root: Path, target: str) -> tuple[Path, str]:
    repo = Repository(root)
    now = datetime.now(timezone.utc).isoformat()
    schema_spec = {
        "specId": "sspec_test", "version": 1, "targetDataset": target,
        "businessGranularity": "one row per source record", "primaryKey": ["id"],
        "businessKeys": ["id"],
        "fieldMappings": [
            {"sourceField": "id", "targetField": "id", "targetType": "long"},
        ],
        "types": {"id": "long"}, "timeFields": [], "partitioning": [],
        "compatibilityStrategy": "ADDITIVE", "sensitiveFields": [],
        "assumptions": [], "risks": [], "createdAt": now,
    }
    pipeline_spec = {
        "specId": "pspec_test", "version": 1, "pipelineId": "pipeline_test",
        "sources": ["local.frozen_source"], "target": target,
        "executionMode": "BATCH", "executionBackend": "PYICEBERG_LOCAL",
        "updateMode": "APPEND",
        "steps": [{
            "stepId": "write", "operation": "WRITE",
            "input": "local.frozen_source", "output": target,
        }],
        "keys": {"primaryKey": ["id"]}, "timeSemantics": "PROCESSING_TIME",
        "partitioning": [], "schemaEvolutionPolicy": "ADDITIVE",
        "assumptions": [], "risks": [], "createdAt": now,
    }
    flow = GovernancePhase1(repo)
    review = flow.create_review_package(schema_spec, pipeline_spec)
    approval = flow.approve(review["reviewId"], "APPROVE", os_actor="test-operator")
    sealed = flow.seal_approved(review["reviewId"], approval)

    placement = PlacementGovernance(repo, controlled={target})
    proposed = placement.propose({
        "placementPlanId": "pp_test", "version": 1,
        "sourceDataset": "local.frozen_source", "targetLayer": "ODS",
        "targetDataset": target, "rationale": "frozen raw evaluation source",
        "targetSchemaRef": "schema-spec:sspec_test@1", "primaryKey": [],
        "partitioning": [], "writeMode": "APPEND",
        "schemaEvolutionPolicy": "ADDITIVE", "retentionPolicy": "evaluation",
        "backfillRequired": False, "affectedDownstream": [],
        "qualityGateRefs": [], "assumptions": [], "risks": [],
        "derivation": "RAW", "status": "DRAFT",
    })
    placement.approve(proposed["placementPlanId"], os_actor="test-operator")
    return root, sealed["approvalId"]


def _contract(tmp_path: Path, rows: str) -> tuple[Path, Path]:
    source = tmp_path / "source.csv"
    source.write_text(rows, encoding="utf-8")
    governance_root, approval_id = _approved_repo(tmp_path / "governance", "eval_raw.sample")
    contract = {
        "source": {
            "path": str(source.resolve()),
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "format": "csv",
        },
        "target": "eval_raw.sample",
        "schemaPolicy": "strict",
        "expectedSchema": [
            {"name": "id", "type": "int64", "required": True},
            {"name": "value", "type": "string", "required": True},
            {"name": "event_time", "type": "timestamp", "required": True},
        ],
        "primaryKey": ["id"],
        "eventTime": {"field": "event_time", "frequencySeconds": 86400,
                      "toleranceSeconds": 0},
        "qualityRules": {"minRows": 1, "requiredColumns": ["id", "value"]},
        "approvalId": approval_id,
    }
    contract_path = tmp_path / "contract.json"
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    return contract_path, governance_root


def test_dry_run_is_read_only_and_builds_complete_plan(tmp_path: Path) -> None:
    contract, governance = _contract(
        tmp_path, "id,value,event_time\n1,a,2026-01-01T00:00:00\n2,b,2026-01-02T00:00:00\n")
    warehouse = tmp_path / "warehouse"
    code, plan = run_contract(contract, warehouse, governance, dry_run=True)
    assert code == 0
    assert plan["governancePreflight"] == "AUTHORIZED"
    assert set(plan["requiredStages"]) == {
        "source_validation", "schema_validation", "governance_preflight",
        "target_resolution", "quality_evaluation", "warehouse_write", "lineage",
    }
    assert not warehouse.exists()
    assert not (tmp_path / "pipeline-outputs").exists()


def test_governed_run_is_atomic_and_idempotent(tmp_path: Path) -> None:
    contract, governance = _contract(
        tmp_path, "id,value,event_time\n1,a,2026-01-01T00:00:00\n2,b,2026-01-02T00:00:00\n")
    warehouse = tmp_path / "warehouse"
    first_code, first = run_contract(contract, warehouse, governance)
    second_code, second = run_contract(contract, warehouse, governance)
    assert first_code == second_code == 0
    assert first["success"] and second["success"]
    assert first["snapshotId"] == second["snapshotId"]
    table = open_catalog(warehouse).load_table("eval_raw.sample")
    assert table.scan().to_arrow().num_rows == 2
    snapshots = list(table.snapshots())
    assert len(snapshots) == 1
    assert snapshots[0].summary.operation.value == "append"
    output = tmp_path / "pipeline-outputs"
    assert list((output / "manifests").glob("execution-*.json"))
    assert list((output / "lineage").glob("lineage-*.json"))


def test_governed_parquet_write_preserves_advertised_boolean_and_date_types(
    tmp_path: Path,
) -> None:
    source = tmp_path / "typed.parquet"
    source_table = pa.table({
        "id": pa.array([1, 2], type=pa.int64()),
        "active": pa.array([True, False], type=pa.bool_()),
        "observed_date": pa.array([date(2026, 1, 1), date(2026, 1, 2)], type=pa.date32()),
    })
    pq.write_table(source_table, source)
    governance, approval_id = _approved_repo(
        tmp_path / "governance", "eval_raw.typed_sample")
    contract = {
        "source": {
            "path": str(source.resolve()),
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "format": "parquet",
        },
        "target": "eval_raw.typed_sample",
        "schemaPolicy": "strict",
        "expectedSchema": [
            {"name": "id", "type": "int64", "required": True},
            {"name": "active", "type": "boolean", "required": True},
            {"name": "observed_date", "type": "date", "required": True},
        ],
        "primaryKey": ["id"],
        "qualityRules": {"minRows": 1},
        "approvalId": approval_id,
    }
    contract_path = tmp_path / "typed-contract.json"
    contract_path.write_text(json.dumps(contract), encoding="utf-8")

    code, manifest = run_contract(contract_path, tmp_path / "warehouse", governance)

    assert code == 0
    assert manifest["success"]
    written = open_catalog(tmp_path / "warehouse").load_table("eval_raw.typed_sample")
    assert str(written.schema().find_field("active").field_type) == "boolean"
    assert str(written.schema().find_field("observed_date").field_type) == "date"
    assert written.scan().to_arrow().combine_chunks().equals(source_table)


@pytest.mark.parametrize(
    "mutation, expected",
    [
        (lambda contract: contract.pop("approvalId"), "approvalId"),
        (lambda contract: contract.update(approvalId=""), "approvalId"),
        (lambda contract: contract.update(unexpectedControl=True), "Additional properties"),
    ],
)
def test_runtime_enforces_json_contract_before_governance_preflight(
    tmp_path: Path, mutation, expected: str,
) -> None:
    contract_path, governance = _contract(
        tmp_path, "id,value,event_time\n1,a,2026-01-01T00:00:00\n")
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    mutation(contract)
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    ledger_before = (governance / "ledger.jsonl").read_bytes()

    with pytest.raises(ValueError, match=expected):
        run_contract(contract_path, tmp_path / "warehouse", governance)

    assert (governance / "ledger.jsonl").read_bytes() == ledger_before
    assert not (tmp_path / "warehouse").exists()


def test_cli_rejects_missing_approval_binding(tmp_path: Path, capsys) -> None:
    contract_path, governance = _contract(
        tmp_path, "id,value,event_time\n1,a,2026-01-01T00:00:00\n")
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    del contract["approvalId"]
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    warehouse = tmp_path / "warehouse"

    code = main([
        "--contract", str(contract_path), "--warehouse", str(warehouse),
        "--governance-root", str(governance),
    ])

    assert code == 1
    assert "approvalId" in capsys.readouterr().err
    assert not warehouse.exists()


def test_load_contract_rejects_duplicate_declared_fields(tmp_path: Path) -> None:
    contract_path, _ = _contract(
        tmp_path, "id,value,event_time\n1,a,2026-01-01T00:00:00\n")
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    contract["expectedSchema"].append(
        {"name": "id", "type": "string", "required": False})
    contract_path.write_text(json.dumps(contract), encoding="utf-8")

    with pytest.raises(ValueError, match="duplicate expectedSchema field"):
        load_contract(contract_path)


def test_post_plan_write_failure_emits_accurate_failed_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract_path, governance = _contract(
        tmp_path, "id,value,event_time\n1,a,2026-01-01T00:00:00\n")

    def fail_publish(*_args, **_kwargs):
        raise RuntimeError("simulated warehouse failure")

    monkeypatch.setattr(WriteGate, "publish", fail_publish)
    with pytest.raises(RuntimeError, match="simulated warehouse failure"):
        run_contract(contract_path, tmp_path / "warehouse", governance)

    manifests = list((tmp_path / "pipeline-outputs" / "manifests").glob("execution-*.json"))
    assert len(manifests) == 1
    manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
    assert manifest["success"] is False
    assert manifest["stages"]["warehouse_write"]["status"] == "FAILED"
    assert manifest["stages"]["lineage"]["status"] == "NOT_RUN"
    for stage in (
        "source_validation", "schema_validation", "governance_preflight",
        "target_resolution", "quality_evaluation",
    ):
        assert manifest["stages"][stage]["status"] == "SUCCEEDED"
    assert not (tmp_path / "pipeline-outputs" / "lineage").exists()


def test_logical_overwrite_creates_one_nonempty_snapshot(tmp_path: Path) -> None:
    catalog = open_catalog(tmp_path / "warehouse")
    catalog.create_namespace("eval_raw")
    first = pa.table({"id": [1, 2], "value": ["a", "b"]})
    second = pa.table({"id": [1, 2], "value": ["c", "d"]})
    _create_table(catalog, "eval_raw.atomic", first.schema)
    _upsert_overwrite(catalog, "eval_raw.atomic", first)
    before = list(catalog.load_table("eval_raw.atomic").snapshots())
    _upsert_overwrite(catalog, "eval_raw.atomic", second)
    loaded = catalog.load_table("eval_raw.atomic")
    after = list(loaded.snapshots())
    assert len(after) == len(before) + 1
    assert after[-1].summary.operation.value == "overwrite"
    assert after[-1].summary.additional_properties["total-records"] == "2"
    assert loaded.scan().to_arrow().column("value").to_pylist() == ["c", "d"]


def test_date64_is_normalized_to_iceberg_date(tmp_path: Path) -> None:
    catalog = open_catalog(tmp_path / "warehouse")
    catalog.create_namespace("eval_raw")
    table = pa.table({
        "id": pa.array([1], type=pa.int64()),
        "observed_date": pa.array([datetime(2026, 1, 1)], type=pa.date64()),
    })

    _create_table(catalog, "eval_raw.date64", table.schema)
    snapshot = _upsert_overwrite(catalog, "eval_raw.date64", table)

    assert snapshot is not None
    written = catalog.load_table("eval_raw.date64")
    assert str(written.schema().find_field("observed_date").field_type) == "date"
    assert written.scan().to_arrow().schema.field("observed_date").type == pa.date32()


def test_contract_quality_detects_all_declared_defect_classes() -> None:
    table = pa.table({
        "id": [1, 1, 3],
        "value": ["a", None, "c"],
        "event_time": ["2026-01-01", "2026-01-01", "2026-01-04"],
        "unexpected": [1, 2, 3],
        "amount": ["1.0", "bad", "3.0"],
    })
    contract = {
        "schemaPolicy": "strict",
        "expectedSchema": [
            {"name": "id", "type": "int64", "required": True},
            {"name": "value", "type": "string", "required": True},
            {"name": "event_time", "type": "string", "required": True},
            {"name": "amount", "type": "float64", "required": True},
            {"name": "missing_column", "type": "string", "required": False},
        ],
        "primaryKey": ["id"],
        "eventTime": {"field": "event_time", "frequencySeconds": 86400,
                      "toleranceSeconds": 0},
        "qualityRules": {"minRows": 1},
    }
    quality = evaluate_quality(table, contract)
    codes = {finding["code"] for finding in quality["findings"]}
    assert {
        "DUPLICATE_PRIMARY_KEY", "MISSING_REQUIRED_VALUE", "TYPE_VIOLATION",
        "SCHEMA_DRIFT_MISSING_COLUMN", "SCHEMA_DRIFT_UNEXPECTED_COLUMN",
        "SCHEMA_DRIFT_INCOMPATIBLE_TYPE", "EVENT_TIME_GAP",
    } <= codes


def test_clean_contract_has_no_injected_defect_findings() -> None:
    table = pa.table({"id": [1, 2], "value": ["a", "b"]})
    contract = {
        "schemaPolicy": "strict",
        "expectedSchema": [
            {"name": "id", "type": "int64", "required": True},
            {"name": "value", "type": "string", "required": True},
        ],
        "primaryKey": ["id"],
        "qualityRules": {"minRows": 1},
    }
    assert evaluate_quality(table, contract)["findings"] == []


def test_quality_rejects_null_keys_and_bad_event_times_without_timezone_crash() -> None:
    table = pa.table({
        "id": [1, None, 3],
        "event_time": [
            "2026-01-01T00:00:00",
            "not-a-time",
            "2026-01-03T00:00:00+11:00",
        ],
    })
    contract = {
        "schemaPolicy": "strict",
        "expectedSchema": [
            {"name": "id", "type": "int64", "required": False},
            {"name": "event_time", "type": "string", "required": True},
        ],
        "primaryKey": ["id"],
        "eventTime": {
            "field": "event_time", "frequencySeconds": 86400,
            "toleranceSeconds": 86400,
        },
        "qualityRules": {"minRows": 1},
    }

    quality = evaluate_quality(table, contract)
    codes = {finding["code"] for finding in quality["findings"]}
    assert "NULL_PRIMARY_KEY" in codes
    assert "EVENT_TIME_UNPARSEABLE" in codes


@pytest.mark.parametrize("runner", ["local", "spark"])
def test_standard_batch_paths_fail_before_warehouse_without_gate(
    tmp_path: Path, runner: str,
) -> None:
    cfg = PipelineConfig(root=tmp_path / runner, mode="batch", profile="small")
    with pytest.raises(PermissionError, match="WriteGate authorization is required"):
        if runner == "local":
            run_batch(cfg, None)
        else:
            run_batch_with_engine(cfg, ENGINE_SPARK, gate=None)
    assert not cfg.warehouse.exists()


@pytest.mark.parametrize("extra", [[], ["--govern", "--engine", "spark"]])
def test_cli_local_and_governed_spark_refuse_unapproved_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, extra: list[str],
) -> None:
    root = tmp_path / "cli-run"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PIPELINE_TEST_ROOT", str(root))
    assert main(["--mode", "batch", *extra]) == 1
    assert not list((root / "warehouse").glob("**/metadata/*.json"))
