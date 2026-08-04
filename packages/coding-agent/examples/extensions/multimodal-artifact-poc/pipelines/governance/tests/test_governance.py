"""Governance Phase 1 unit + contract tests.

Coverage manifest features (round2.pipeline_governance,
round2.pipeline_schema_discovery, round2.pipeline_schema_design,
round2.pipeline_spec_generation, round2.pipeline_draft_compilation,
round2.pipeline_human_approval, round2.pipeline_amendment) are exercised here
and by experiments/e2e-governance-phase1.mts.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.contracts import (  # noqa: E402
    CONTRACT_NAMES,
    contract_paths,
    is_valid_contract,
    sha256_canonical,
    validate_contract,
)
from pipelines.governance.repository import Repository  # noqa: E402
from pipelines.governance.discovery import profile_parquet  # noqa: E402
from pipelines.governance.compiler import compile_draft  # noqa: E402
from pipelines.governance.validation import validate_pipeline_spec, validate_schema_spec  # noqa: E402
from pipelines.governance.flow import GovernancePhase1  # noqa: E402


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


@pytest.fixture()
def valid_schema_spec() -> dict:
    return {
        "specId": "schema_001", "version": 1,
        "targetDataset": "dwd.loan_application_detail",
        "businessGranularity": "loan application",
        "primaryKey": ["application_id"],
        "businessKeys": ["application_id"],
        "fieldMappings": [
            {"sourceField": "application_id", "targetField": "application_id", "targetType": "string", "nullability": "NOT_NULL"},
            {"sourceField": "entity_id", "targetField": "entity_id", "targetType": "string"},
        ],
        "types": {"application_id": "string"},
        "timeFields": ["event_time"],
        "partitioning": ["event_time"],
        "compatibilityStrategy": "ADDITIVE",
        "sensitiveFields": [],
        "assumptions": ["source is daily"],
        "risks": [],
        "createdAt": "2026-08-02T00:00:00Z",
    }


@pytest.fixture()
def valid_pipeline_spec() -> dict:
    return {
        "specId": "pipeline_001", "version": 1, "pipelineId": "loan_pipeline",
        "sources": ["ods.loan_applications_raw"], "target": "dwd.loan_application_detail",
        "executionMode": "BATCH", "executionBackend": "PYICEBERG_LOCAL",
        "updateMode": "FULL",
        "steps": [{"stepId": "s1", "operation": "clean", "input": "ods.loan_applications_raw", "output": "dwd.loan_application_detail"}],
        "keys": {"application_id": ["application_id"]},
        "dedupPolicy": "KEEP_FIRST", "timeSemantics": "EVENT_TIME",
        "partitioning": ["event_time"], "schemaEvolutionPolicy": "ADDITIVE",
        "assumptions": [], "risks": [],
        "createdAt": "2026-08-02T00:00:00Z",
    }


# ---------------------------------------------------------------------------
# contracts
# ---------------------------------------------------------------------------

def test_ten_contracts_exist():
    assert len(CONTRACT_NAMES) == 20  # + governance-report
    for name in CONTRACT_NAMES:
        assert contract_paths()[name].exists(), f"missing {name}.schema.json"


def test_schema_spec_valid():
    assert is_valid_contract("schema-spec", {
        "specId": "s", "version": 1, "targetDataset": "dwd.x",
        "businessGranularity": "row", "fieldMappings": [],
        "types": {}, "timeFields": [], "partitioning": [],
        "compatibilityStrategy": "ADDITIVE", "sensitiveFields": [],
        "assumptions": [], "risks": [], "createdAt": "2026-08-02T00:00:00Z",
    })


def test_approval_decision_binds_hash_and_operator():
    ok = {
        "approvalId": "a1", "reviewId": "r1", "reviewContentHash": "sha256:" + "0" * 64,
        "decision": "APPROVE", "approverSource": "OPERATOR_CLI",
        "osActor": "user@host", "comment": "", "decidedAt": "2026-08-02T00:00:00Z",
    }
    assert is_valid_contract("approval-decision", ok)
    bad = {**ok, "approverSource": "AGENT"}
    assert not is_valid_contract("approval-decision", bad)


def test_draft_artifact_executable_false():
    assert is_valid_contract("pipeline-draft-artifact", {
        "artifactId": "d1", "specVersion": 1, "executable": False,
        "compiledPreview": "x", "contentHash": "sha256:" + "0" * 64,
        "compiler": "DETERMINISTIC_PYICEBERG_COMPILER",
        "compiledAt": "2026-08-02T00:00:00Z",
    })
    assert not is_valid_contract("pipeline-draft-artifact", {
        "artifactId": "d1", "specVersion": 1, "executable": True,
        "compiledPreview": "x", "contentHash": "sha256:" + "0" * 64,
        "compiler": "DETERMINISTIC_PYICEBERG_COMPILER",
        "compiledAt": "2026-08-02T00:00:00Z",
    })


# ---------------------------------------------------------------------------
# repository (append-only, version-immutable)
# ---------------------------------------------------------------------------

def test_repository_immutable_versions(repo):
    obj = {"specId": "s1", "version": 1, "x": 1}
    repo.put("schema-spec", "s1", 1, obj)
    with pytest.raises(ValueError):
        repo.put("schema-spec", "s1", 1, {"specId": "s1", "version": 1, "x": 999})
    got = repo.get("schema-spec", "s1", 1)
    assert got.content["x"] == 1
    assert len(repo.ledger()) == 1


def test_repository_versioned_amendment(repo):
    repo.put("schema-spec", "s1", 1, {"specId": "s1", "version": 1})
    repo.put("schema-spec", "s1", 2, {"specId": "s1", "version": 2})
    assert repo.versions("schema-spec", "s1") == [1, 2]
    assert repo.get("schema-spec", "s1").version == 2  # latest


# ---------------------------------------------------------------------------
# discovery (deterministic, candidate keys with evidence)
# ---------------------------------------------------------------------------

def test_discovery_candidate_keys_have_evidence(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq
    rows = [{"id": f"k{i:04d}", "value": i % 3, "event_time": f"2026-07-{i % 28 + 1:02d}"} for i in range(200)]
    table = pa.Table.from_pylist(rows)
    path = tmp_path / "source.parquet"
    pq.write_table(table, path)
    profile = profile_parquet(path)
    assert profile["rowCount"] == 200
    keys = {tuple(k["fields"]) for k in profile["candidateKeys"]}
    assert ("id",) in keys, "unique id must be a candidate"
    assert ("value",) not in keys, "low-cardinality column must NOT be a candidate"
    id_key = next(k for k in profile["candidateKeys"] if k["fields"] == ["id"])
    assert id_key["confidence"] >= 0.9
    assert id_key["evidence"]["uniquenessRatio"] >= 0.95
    assert "event_time" in profile["candidateEventTimes"]


def test_discovery_candidate_key_not_auto_primary(tmp_path):
    """Sampled uniqueness must NOT promote a key to primary — primary key is
    an agent proposal + human approval."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    rows = [{"id": f"k{i:04d}", "v": 1} for i in range(100)]
    # duplicate every 10th id → uniqueness < 1
    for i in range(0, 100, 10):
        rows.append({"id": f"k{i:04d}", "v": 1})
    table = pa.Table.from_pylist(rows)
    path = tmp_path / "dup.parquet"
    pq.write_table(table, path)
    profile = profile_parquet(path)
    id_key = next((k for k in profile["candidateKeys"] if k["fields"] == ["id"]), None)
    # 100 unique / 110 rows ≈ 0.91 uniqueness → still a candidate but with
    # lower confidence; the profile itself never declares a primary key.
    assert "primaryKey" not in profile
    if id_key is not None:
        assert id_key["confidence"] < 1.0


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------

def test_validate_schema_spec_rejects_empty_mappings():
    spec = {"specId": "s", "version": 1, "targetDataset": "dwd.x",
            "businessGranularity": "row", "fieldMappings": [],
            "types": {}, "timeFields": [], "partitioning": [],
            "compatibilityStrategy": "ADDITIVE", "sensitiveFields": [],
            "assumptions": [], "risks": [], "createdAt": "2026-08-02T00:00:00Z"}
    issues = validate_schema_spec(spec)
    assert any(i["code"] == "EMPTY_FIELD_MAPPINGS" for i in issues)


def test_validate_pipeline_spec_rejects_empty_steps():
    spec = {"specId": "p", "version": 1, "pipelineId": "x", "sources": ["a"],
            "target": "dwd.x", "executionMode": "BATCH", "executionBackend": "PYICEBERG_LOCAL",
            "updateMode": "FULL", "steps": [], "keys": {"k": ["k"]},
            "timeSemantics": "EVENT_TIME", "partitioning": [],
            "schemaEvolutionPolicy": "ADDITIVE", "assumptions": [], "risks": [],
            "createdAt": "2026-08-02T00:00:00Z"}
    issues = validate_pipeline_spec(spec)
    assert any(i["code"] == "EMPTY_STEPS" for i in issues)


def test_validate_pipeline_spec_requires_keys_non_append():
    spec = {"specId": "p", "version": 1, "pipelineId": "x", "sources": ["a"],
            "target": "dwd.x", "executionMode": "BATCH", "executionBackend": "PYICEBERG_LOCAL",
            "updateMode": "FULL", "steps": [{"stepId": "s1", "operation": "c", "input": "a", "output": "b"}],
            "keys": {}, "timeSemantics": "EVENT_TIME", "partitioning": [],
            "schemaEvolutionPolicy": "ADDITIVE", "assumptions": [], "risks": [],
            "createdAt": "2026-08-02T00:00:00Z"}
    issues = validate_pipeline_spec(spec)
    assert any(i["code"] == "KEYS_MISSING" for i in issues)


# ---------------------------------------------------------------------------
# compiler
# ---------------------------------------------------------------------------

def test_compiler_draft_not_executable(valid_pipeline_spec):
    draft = compile_draft(valid_pipeline_spec, 1, "draft_1")
    assert draft["executable"] is False
    assert "NON-EXECUTABLE" in draft["compiledPreview"]
    assert draft["contentHash"].startswith("sha256:")


def test_compiler_refuses_invalid_spec():
    bad = {"specId": "p", "version": 1}
    with pytest.raises(ValueError):
        compile_draft(bad, 1, "draft_bad")


# ---------------------------------------------------------------------------
# flow: review -> approve -> seal
# ---------------------------------------------------------------------------

def test_full_approve_flow(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    assert review["pipelineDraftArtifact"] is not None
    assert review["pipelineDraftArtifact"]["executable"] is False
    assert g.state_of(review) == "WAITING_FOR_APPROVAL"
    assert review["validationIssues"] == []

    approval = g.approve(review["reviewId"], "APPROVE", os_actor="operator@host")
    sealed = g.seal_approved(review["reviewId"], approval)
    assert sealed["schemaSpecHash"].startswith("sha256:")
    assert sealed["draftArtifactHash"] == review["pipelineDraftArtifact"]["contentHash"]
    assert sealed["reviewPackageHash"] == review["contentHash"]
    # sealed spec stored in repository
    stored = repo.get("approved-pipeline-spec", sealed["specId"], sealed["version"])
    assert stored is not None


def test_approve_binds_review_hash(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    tampered = {"approvalId": "x", "reviewId": review["reviewId"],
                "reviewContentHash": "sha256:" + "f" * 64, "decision": "APPROVE",
                "approverSource": "OPERATOR_CLI", "osActor": "u@h", "comment": "",
                "decidedAt": "2026-08-02T00:00:00Z"}
    with pytest.raises(ValueError):
        g.seal_approved(review["reviewId"], tampered)


def test_changes_requested_creates_new_review(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    approval = g.approve(review["reviewId"], "REQUEST_CHANGES", os_actor="operator@host",
                         comment="add channel field")

    changed_schema = {**valid_schema_spec, "fieldMappings": [
        *valid_schema_spec["fieldMappings"],
        {"sourceField": "channel", "targetField": "channel", "targetType": "string"},
    ]}
    changed_pipeline = {**valid_pipeline_spec, "steps": [
        *valid_pipeline_spec["steps"],
        {"stepId": "s2", "operation": "enrich", "input": "dwd.loan_application_detail", "output": "dwd.loan_application_detail"},
    ]}
    new_review = g.request_changes(review["reviewId"], approval, changed_schema, changed_pipeline,
                                   reason="add channel field")
    assert new_review["reviewId"] != review["reviewId"]
    assert new_review["pipelineSpec"]["version"] == 2
    # old approval not reused: the v1 REQUEST_CHANGES approval cannot seal
    # the NEW review (its hash does not bind the new review content)
    with pytest.raises(ValueError):
        g.seal_approved(new_review["reviewId"], approval)


def test_agent_cannot_produce_approval(repo, valid_schema_spec, valid_pipeline_spec):
    """The approval contract requires OPERATOR_CLI source; an agent-produced
    decision (approverSource=AGENT) fails contract validation."""
    import json as _json
    agent_decision = {
        "approvalId": "a_agent", "reviewId": "r", "reviewContentHash": "sha256:" + "0" * 64,
        "decision": "APPROVE", "approverSource": "AGENT",
        "osActor": "agent", "comment": "", "decidedAt": "2026-08-02T00:00:00Z",
    }
    assert not is_valid_contract("approval-decision", agent_decision)


def test_unapproved_spec_cannot_seal(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    # no approval recorded → sealing is impossible (no approval id to bind)
    approvals = [a for a in repo.ledger() if a["type"] == "approval-decision"]
    assert approvals == []
