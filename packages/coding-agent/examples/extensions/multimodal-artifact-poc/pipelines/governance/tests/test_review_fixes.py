"""Governance review-fix regression tests.

Covers all P0/P1/P2 findings from the Phase 1 static review:
  - repository atomic writes, integrity scan, reconcile, repair, concurrency
  - object id / path / symlink safety
  - contract-level validation (SCHEMA_SPEC_CONTRACT_INVALID etc.)
  - primary-key evidence → ERROR
  - stale review / stale base version
  - approval rules (comment required, terminal states, single seal)
  - schemaHash covers full physical schema + sampleInfo
"""
import json
import os
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.repository import (  # noqa: E402
    IntegrityError,
    Repository,
)
from pipelines.governance.flow import (  # noqa: E402
    GovernancePhase1,
    StaleReviewError,
)
from pipelines.governance.validation import validate_schema_spec, validate_pipeline_spec  # noqa: E402
from pipelines.governance.discovery import profile_parquet  # noqa: E402


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
# ID / path / symlink safety
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad_id", [
    "../escape", "a/b", "a\\b", "x@1", "/abs/path", "", "a b", "a\x00b", "..", ".hidden",
])
def test_unsafe_ids_rejected(repo, bad_id):
    with pytest.raises(ValueError):
        repo.put("schema-spec", bad_id, 1, {"specId": "x"})


def test_symlink_escape_rejected(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "repo"
    r = Repository(root)
    # create a symlink inside objects/ pointing outside root
    link = r.objects_dir / "schema-spec"
    link.mkdir(parents=True, exist_ok=True)
    link.rmdir()
    link.symlink_to(outside, target_is_directory=True)
    with pytest.raises((ValueError, OSError)):
        r.put("schema-spec", "ok_id", 1, {"specId": "x"})


# ---------------------------------------------------------------------------
# atomicity: object write succeeds but ledger write fails
# ---------------------------------------------------------------------------

def test_object_written_but_ledger_fails_detected(repo, monkeypatch):
    """Object exists but ledger append fails → integrity scan reports
    ORPHAN_OBJECT and reconcile records a RECOVERED ledger entry."""
    def boom(_self, line):
        raise OSError("simulated ledger write failure")
    with monkeypatch.context() as m:
        m.setattr(Repository, "_append_ledger", boom)
        with pytest.raises(OSError):
            repo.put("schema-spec", "orphan_me", 1, {"specId": "x"})
    # object IS on disk
    obj = repo.get("schema-spec", "orphan_me", 1)
    assert obj is not None
    # integrity scan flags it as ORPHAN_OBJECT (no ledger entry)
    issues = repo.integrity_scan()
    assert any(i.code == "ORPHAN_OBJECT" and "orphan_me" in i.detail for i in issues)
    # explicit reconcile backfills a RECOVERED ledger event
    issue = repo.reconcile("schema-spec", "orphan_me", 1, actor="operator")
    assert "RECOVERED" in issue.detail
    # after reconcile the scan is clean for this object
    issues = repo.integrity_scan()
    assert not any(i.code == "ORPHAN_OBJECT" and "orphan_me" in i.detail for i in issues)


def test_ledger_references_missing_object_blocks(repo):
    """A ledger entry pointing to a deleted object → MISSING_OBJECT."""
    repo.put("schema-spec", "gone", 1, {"specId": "x"})
    # delete the object file behind the ledger's back
    (repo.objects_dir / "schema-spec" / "gone@1.json").unlink()
    issues = repo.integrity_scan()
    assert any(i.code == "MISSING_OBJECT" and "gone" in i.detail for i in issues)
    # seal must refuse (precondition check)
    g = GovernancePhase1(repo)
    assert repo.has_missing_objects() is True


def test_truncated_ledger_tail_repair(repo):
    repo.put("schema-spec", "a", 1, {"specId": "a"})
    # append a truncated (incomplete JSON) final line
    with open(repo.ledger_path, "a", encoding="utf-8") as f:
        f.write('{"type": "schema-spec", "id": "partial"')
    issues = repo.integrity_scan()
    assert any(i.code == "TRUNCATED_LEDGER_TAIL" for i in issues)
    # explicit repair drops the tail
    issue = repo.repair_ledger_tail()
    assert "TRUNCATED_LEDGER_TAIL" in issue.code
    assert not any(i.code == "TRUNCATED_LEDGER_TAIL" for i in repo.integrity_scan())


def test_mid_ledger_corruption_fails(repo):
    repo.put("schema-spec", "a", 1, {"specId": "a"})
    lines = repo.ledger_path.read_text(encoding="utf-8").splitlines()
    # corrupt a MIDDLE line (insert a bad line before the last)
    lines.insert(len(lines) - 1, "{corrupt mid")
    repo.ledger_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    with pytest.raises(IntegrityError):
        repo.integrity_scan()


def test_concurrent_write_same_version_only_one_succeeds(repo):
    """Two threads writing the same id/version → exactly one succeeds."""
    results = []

    def writer():
        try:
            repo.put("schema-spec", "race", 1, {"specId": "race"})
            results.append("ok")
        except ValueError:
            results.append("dup")

    threads = [threading.Thread(target=writer) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == ["dup", "ok"], f"unexpected results {results}"
    assert len(repo.versions("schema-spec", "race")) == 1


# ---------------------------------------------------------------------------
# contract validation
# ---------------------------------------------------------------------------

def test_schema_spec_contract_error_produces_error_issue():
    # missing createdAt and types → contract ERROR
    spec = {
        "specId": "s", "version": 1, "targetDataset": "dwd.x",
        "businessGranularity": "row", "fieldMappings": [
            {"sourceField": "a", "targetField": "a", "targetType": "string"}],
    }
    issues = validate_schema_spec(spec)
    assert any(i["code"] == "SCHEMA_SPEC_CONTRACT_INVALID" and i["severity"] == "ERROR" for i in issues)


def test_schema_spec_additional_properties_rejected():
    spec = {
        "specId": "s", "version": 1, "targetDataset": "dwd.x",
        "businessGranularity": "row", "fieldMappings": [],
        "types": {}, "timeFields": [], "partitioning": [],
        "compatibilityStrategy": "ADDITIVE", "sensitiveFields": [],
        "assumptions": [], "risks": [], "createdAt": "2026-08-02T00:00:00Z",
        "surprise": True,
    }
    issues = validate_schema_spec(spec)
    assert any(i["code"] == "SCHEMA_SPEC_CONTRACT_INVALID" for i in issues)


def test_pipeline_spec_contract_error_produces_error_issue():
    spec = {"specId": "p", "version": 1}  # missing required fields
    issues = validate_pipeline_spec(spec)
    assert any(i["code"] == "PIPELINE_SPEC_CONTRACT_INVALID" and i["severity"] == "ERROR" for i in issues)


def test_contract_error_blocks_review_and_compile(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    bad_schema = {k: v for k, v in valid_schema_spec.items() if k != "createdAt"}
    review = g.create_review_package(bad_schema, valid_pipeline_spec)
    assert review["pipelineDraftArtifact"] is None
    assert any(i["code"] == "SCHEMA_SPEC_CONTRACT_INVALID" for i in review["validationIssues"])


# ---------------------------------------------------------------------------
# primary key evidence → ERROR
# ---------------------------------------------------------------------------

def test_primary_key_without_evidence_is_error():
    spec = {
        "specId": "s", "version": 1, "targetDataset": "dwd.x",
        "businessGranularity": "row", "primaryKey": ["no_evidence_col"],
        "fieldMappings": [{"sourceField": "no_evidence_col", "targetField": "no_evidence_col", "targetType": "string"}],
        "types": {}, "timeFields": [], "partitioning": [],
        "compatibilityStrategy": "ADDITIVE", "sensitiveFields": [],
        "assumptions": [], "risks": [], "createdAt": "2026-08-02T00:00:00Z",
    }
    profile = {
        "candidateKeys": [
            {"fields": ["other_col"], "confidence": 0.99,
             "evidence": {"uniquenessRatio": 1.0, "nonNullRatio": 1.0, "cardinality": 10},
             "sampleRows": 10, "fullScanVerified": True, "evidenceRefs": []},
        ],
    }
    issues = validate_schema_spec(spec, profile=profile)
    assert any(i["code"] == "PRIMARY_KEY_NO_EVIDENCE" and i["severity"] == "ERROR" for i in issues)


def test_primary_key_sample_only_is_error():
    spec = {
        "specId": "s", "version": 1, "targetDataset": "dwd.x",
        "businessGranularity": "row", "primaryKey": ["id"],
        "fieldMappings": [{"sourceField": "id", "targetField": "id", "targetType": "string"}],
        "types": {}, "timeFields": [], "partitioning": [],
        "compatibilityStrategy": "ADDITIVE", "sensitiveFields": [],
        "assumptions": [], "risks": [], "createdAt": "2026-08-02T00:00:00Z",
    }
    profile = {
        "candidateKeys": [
            {"fields": ["id"], "confidence": 0.9,
             "evidence": {"uniquenessRatio": 0.95, "nonNullRatio": 0.98, "cardinality": 90},
             "sampleRows": 100, "fullScanVerified": False, "evidenceRefs": []},
        ],
    }
    issues = validate_schema_spec(spec, profile=profile)
    assert any(i["code"] == "PRIMARY_KEY_SAMPLE_ONLY" and i["severity"] == "ERROR" for i in issues)


# ---------------------------------------------------------------------------
# stale review / stale base version
# ---------------------------------------------------------------------------

def test_stale_base_version_rejected(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    approval = g.approve(review["reviewId"], "REQUEST_CHANGES", os_actor="op@h", comment="change")
    # simulate that a v2 already exists (the base is stale)
    repo.put("pipeline-spec", "pipeline_001", 2, {**valid_pipeline_spec, "version": 2})
    changed = {**valid_pipeline_spec, "steps": [*valid_pipeline_spec["steps"],
               {"stepId": "s2", "operation": "x", "input": "a", "output": "b"}]}
    with pytest.raises(StaleReviewError):
        g.request_changes(review["reviewId"], approval, valid_schema_spec, changed, reason="x")


def test_changes_requested_cannot_be_approved_directly(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    g.approve(review["reviewId"], "REQUEST_CHANGES", os_actor="op@h", comment="change")
    with pytest.raises(ValueError):
        g.approve(review["reviewId"], "APPROVE", os_actor="op@h")


def test_rejected_review_is_terminal(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    g.approve(review["reviewId"], "REJECT", os_actor="op@h")
    with pytest.raises(ValueError):
        g.approve(review["reviewId"], "APPROVE", os_actor="op@h")


def test_request_changes_requires_comment(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    with pytest.raises(ValueError):
        g.approve(review["reviewId"], "REQUEST_CHANGES", os_actor="op@h")


def test_approval_seals_only_once(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    approval = g.approve(review["reviewId"], "APPROVE", os_actor="op@h")
    g.seal_approved(review["reviewId"], approval)
    # second seal with the SAME approval → rejected (already used)
    with pytest.raises(ValueError):
        g.seal_approved(review["reviewId"], approval)


def test_seal_refuses_on_missing_object(repo, valid_schema_spec, valid_pipeline_spec):
    g = GovernancePhase1(repo)
    review = g.create_review_package(valid_schema_spec, valid_pipeline_spec)
    approval = g.approve(review["reviewId"], "APPROVE", os_actor="op@h")
    # delete the stored pipeline-spec object → MISSING_OBJECT blocks seal
    (repo.objects_dir / "pipeline-spec" / "pipeline_001@1.json").unlink()
    with pytest.raises(IntegrityError):
        g.seal_approved(review["reviewId"], approval)


# ---------------------------------------------------------------------------
# discovery: schemaHash full coverage + sampleInfo + empty safety
# ---------------------------------------------------------------------------

def test_schema_hash_differs_on_type_change(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq
    t1 = pa.Table.from_pylist([{"id": "a", "v": 1}])
    t2 = pa.Table.from_pylist([{"id": "a", "v": "x"}])
    p1 = tmp_path / "a.parquet"
    p2 = tmp_path / "b.parquet"
    pq.write_table(t1, p1)
    pq.write_table(t2, p2)
    h1 = profile_parquet(p1)["schemaHash"]
    h2 = profile_parquet(p2)["schemaHash"]
    assert h1 != h2, "same field names but different type must hash differently"


def test_profile_records_sample_info(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq
    rows = [{"id": f"k{i:04d}", "v": i % 3} for i in range(300)]
    pq.write_table(pa.Table.from_pylist(rows), tmp_path / "s.parquet")
    profile = profile_parquet(tmp_path / "s.parquet", sample_limit=100)
    info = profile["sampleInfo"]
    assert info["totalRows"] == 300
    assert info["sampledRows"] == 100
    assert info["fullScan"] is False
    assert info["samplingMethod"] == "head"
    # sampled candidates are flagged fullScanVerified=False
    keys = profile["candidateKeys"]
    assert all(k["fullScanVerified"] is False for k in keys)


def test_profile_empty_table_no_candidates(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq
    pq.write_table(pa.Table.from_pylist([]), tmp_path / "empty.parquet")
    profile = profile_parquet(tmp_path / "empty.parquet")
    assert profile["candidateKeys"] == []
    assert profile["sampleInfo"]["totalRows"] == 0


def test_profile_full_scan_flagged(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq
    rows = [{"id": f"k{i:04d}"} for i in range(50)]
    pq.write_table(pa.Table.from_pylist(rows), tmp_path / "s.parquet")
    profile = profile_parquet(tmp_path / "s.parquet", sample_limit=1000)
    assert profile["sampleInfo"]["fullScan"] is True
    assert all(k["fullScanVerified"] is True for k in profile["candidateKeys"])


# ---------------------------------------------------------------------------
# CLI feature gate
# ---------------------------------------------------------------------------

def test_cli_feature_gate_off(tmp_path, monkeypatch):
    """The governance CLI must refuse (exit != 0) when the parent feature is
    not effective, and must not create repository files."""
    import subprocess
    root = tmp_path / "cli-root"
    env = {**__import__("os").environ, "PIPELINE_GOVERNANCE_ROOT": str(root)}
    # parent feature explicitly OFF (everything-ON default otherwise)
    env["ENABLE_PIPELINE_GOVERNANCE"] = "false"
    r = subprocess.run(
        [sys.executable, "-m", "pipelines.governance", "show", "nope"],
        capture_output=True, text=True, env=env,
    )
    assert r.returncode != 0
    assert "FEATURE_DISABLED" in r.stderr
    # no repository files were created
    assert not (root / "ledger.jsonl").exists()
    assert not (root / "objects").exists()


def test_cli_feature_gate_on(tmp_path, monkeypatch):
    """With features enabled the CLI proceeds past the gate (and fails only
    on a missing review — proving the gate did not block)."""
    import subprocess
    root = tmp_path / "cli-root"
    env = {**__import__("os").environ, "PIPELINE_GOVERNANCE_ROOT": str(root)}
    # enable the parent feature via a runtime config file (features map)
    import json as _json
    prof = tmp_path / "profile.json"
    prof.write_text(_json.dumps({
        "features": {
            "round2.lakehouse": True,
            "round2.pipeline_governance": True,
            "round2.pipeline_human_approval": True,
        },
    }))
    env["FEATURE_RUNTIME_CONFIG_PATH"] = str(prof)
    r = subprocess.run(
        [sys.executable, "-m", "pipelines.governance", "show", "nope"],
        capture_output=True, text=True, env=env,
    )
    # gate passed; now fails because the review does not exist
    assert "FEATURE_DISABLED" not in r.stderr
    assert "not found" in r.stderr


def test_approve_requires_tty(tmp_path, monkeypatch):
    """Approval is a human-only boundary: piped (non-TTY) stdin cannot
    approve — scripts/agents are refused before any decision is read."""
    import subprocess
    root = tmp_path / "cli-root"
    env = {**__import__("os").environ, "PIPELINE_GOVERNANCE_ROOT": str(root)}
    r = subprocess.run(
        [sys.executable, "-m", "pipelines.governance", "approve", "review_x"],
        capture_output=True, text=True, env=env, input="APPROVE\n",
    )
    assert r.returncode == 2
    assert "interactive terminal" in r.stderr
    # no approval decision was recorded (ledger scaffold may exist, but the
    # refusal happens before any decision is read or written)
    if (root / "ledger.jsonl").exists():
        lines = (root / "ledger.jsonl").read_text().splitlines()
        assert not any('"approval-decision"' in ln for ln in lines)
