from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw

WORKTREE = Path("/tmp/analytica-tool92.IH2rVI/checkout")
POC = WORKTREE / "packages/coding-agent/examples/extensions/multimodal-artifact-poc"
GATEWAY = POC / "services/lakehouse-gateway"
RUNTIME = Path(__file__).resolve().parent / "runtime"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build_gateway_warehouse() -> Path:
    sys.path.insert(0, str(GATEWAY))
    sys.path.insert(0, str(POC / "services/cdxr-engine"))
    from tests.conftest import build_test_warehouse

    warehouse = RUNTIME / "gateway-warehouse"
    build_test_warehouse(warehouse)
    return warehouse


def approved_pipeline_fixture() -> dict[str, str]:
    sys.path.insert(0, str(POC))
    from pipelines.governance.flow import GovernancePhase1
    from pipelines.governance.placement import PlacementGovernance
    from pipelines.governance.repository import Repository

    root = RUNTIME / "approved-governance"
    target = "eval_raw.tool_eval_ingest"
    repo = Repository(root)
    now = datetime.now(timezone.utc).isoformat()
    schema_spec = {
        "specId": "sspec_tool_eval", "version": 1, "targetDataset": target,
        "businessGranularity": "one row per source record", "primaryKey": ["id"],
        "businessKeys": ["id"],
        "fieldMappings": [{"sourceField": "id", "targetField": "id", "targetType": "long"}],
        "types": {"id": "long"}, "timeFields": [], "partitioning": [],
        "compatibilityStrategy": "ADDITIVE", "sensitiveFields": [],
        "assumptions": [], "risks": [], "createdAt": now,
    }
    pipeline_spec = {
        "specId": "pspec_tool_eval", "version": 1, "pipelineId": "pipeline_tool_eval",
        "sources": ["local.frozen_source"], "target": target,
        "executionMode": "BATCH", "executionBackend": "PYICEBERG_LOCAL", "updateMode": "APPEND",
        "steps": [{"stepId": "write", "operation": "WRITE", "input": "local.frozen_source", "output": target}],
        "keys": {"primaryKey": ["id"]}, "timeSemantics": "PROCESSING_TIME",
        "partitioning": [], "schemaEvolutionPolicy": "ADDITIVE",
        "assumptions": [], "risks": [], "createdAt": now,
    }
    flow = GovernancePhase1(repo)
    review = flow.create_review_package(schema_spec, pipeline_spec)
    approval = flow.approve(review["reviewId"], "APPROVE", os_actor="tool-eval-operator")
    sealed = flow.seal_approved(review["reviewId"], approval)
    placement = PlacementGovernance(repo, controlled={target})
    proposed = placement.propose({
        "placementPlanId": "pp_tool_eval", "version": 1,
        "sourceDataset": "local.frozen_source", "targetLayer": "ODS", "targetDataset": target,
        "rationale": "frozen tool evaluation source", "targetSchemaRef": "schema-spec:sspec_tool_eval@1",
        "primaryKey": [], "partitioning": [], "writeMode": "APPEND",
        "schemaEvolutionPolicy": "ADDITIVE", "retentionPolicy": "evaluation",
        "backfillRequired": False, "affectedDownstream": [], "qualityGateRefs": [],
        "assumptions": [], "risks": [], "derivation": "RAW", "status": "DRAFT",
    })
    placement.approve(proposed["placementPlanId"], os_actor="tool-eval-operator")

    source = RUNTIME / "pipeline-source.csv"
    source.write_text("id,value,event_time\n1,a,2026-01-01T00:00:00\n2,b,2026-01-02T00:00:00\n", encoding="utf-8")
    contract = {
        "source": {"path": str(source.resolve()), "sha256": sha256(source), "format": "csv"},
        "target": target, "schemaPolicy": "strict",
        "expectedSchema": [
            {"name": "id", "type": "int64", "required": True},
            {"name": "value", "type": "string", "required": True},
            {"name": "event_time", "type": "timestamp", "required": True},
        ],
        "primaryKey": ["id"],
        "eventTime": {"field": "event_time", "frequencySeconds": 86400, "toleranceSeconds": 0},
        "qualityRules": {"minRows": 1, "requiredColumns": ["id", "value"]},
        "approvalId": sealed["approvalId"],
    }
    approved_contract = RUNTIME / "approved-contract.json"
    write_json(approved_contract, contract)

    unapproved_root = RUNTIME / "unapproved-governance"
    unapproved_root.mkdir(parents=True, exist_ok=True)
    bad = {**contract, "target": "eval_raw.unauthorized", "approvalId": "approval_missing"}
    unapproved_contract = RUNTIME / "unapproved-contract.json"
    write_json(unapproved_contract, bad)
    return {
        "approvedGovernanceRoot": str(root), "approvedContract": str(approved_contract),
        "unapprovedGovernanceRoot": str(unapproved_root), "unapprovedContract": str(unapproved_contract),
        "pipelineWarehouse": str(RUNTIME / "pipeline-warehouse"), "source": str(source),
    }


def chart_fixture() -> Path:
    path = RUNTIME / "bar-chart.png"
    image = Image.new("RGB", (640, 420), "white")
    draw = ImageDraw.Draw(image)
    draw.line((70, 350, 590, 350), fill="black", width=3)
    draw.line((70, 350, 70, 50), fill="black", width=3)
    values = [("A", 100), ("B", 180), ("C", 260)]
    for index, (label, value) in enumerate(values):
        x = 130 + index * 150
        draw.rectangle((x, 350 - value, x + 70, 350), fill=(52, 105, 180))
        draw.text((x + 25, 360), label, fill="black")
        draw.text((x + 20, 330 - value), str(value), fill="black")
    draw.text((230, 15), "Quarterly Metric", fill="black")
    draw.text((10, 180), "Value", fill="black")
    image.save(path)
    return path


def main() -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    home = RUNTIME / "home"
    (home / ".pi/artifacts/data-analysis").mkdir(parents=True, exist_ok=True)
    gateway_warehouse = build_gateway_warehouse()
    pipeline = approved_pipeline_fixture()
    chart = chart_fixture()
    manifest = {
        "commitSha": "92cb4346ac5f0b4edc3eefcdcb81978e570fd220",
        "runtimeRoot": str(RUNTIME), "home": str(home),
        "gatewayWarehouse": str(gateway_warehouse),
        "gatewayCatalogSha256": sha256(gateway_warehouse / ".lakehouse-catalog.db"),
        "chart": {"path": str(chart), "sha256": sha256(chart)},
        "pipeline": pipeline,
        "hashes": {
            "source": sha256(Path(pipeline["source"])),
            "approvedContract": sha256(Path(pipeline["approvedContract"])),
            "unapprovedContract": sha256(Path(pipeline["unapprovedContract"])),
            "approvedLedger": sha256(Path(pipeline["approvedGovernanceRoot"]) / "ledger.jsonl"),
        },
    }
    write_json(Path(__file__).resolve().parent / "runtime-manifest.json", manifest)
    print(json.dumps(manifest, sort_keys=True))


if __name__ == "__main__":
    main()
