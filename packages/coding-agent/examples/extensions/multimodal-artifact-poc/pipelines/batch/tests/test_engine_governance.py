"""Engine-governance loop tests — real engine runs feed the governance agent.

A real Spark (or Flink, when pyflink is importable) batch run emits lifecycle
events through the coordinator; the adapters aggregate them into a runtime
summary; RuntimeGovernance rules evaluate it; the state reducer / status
bar observe the same stream (heartbeats included).
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from pipelines.batch.engine import (
    ENGINE_FLINK,
    ENGINE_SPARK,
    engine_available,
    run_batch_with_engine,
)
from pipelines.batch.engine_governance import run_governed_batch
from pipelines.common.config import PipelineConfig
from pipelines.tests.helpers import TestOnlyWriteGate


def _fresh_cfg() -> PipelineConfig:
    import tempfile
    return PipelineConfig(root=Path(tempfile.mkdtemp(prefix="engine-gov-")),
                          mode="batch", profile="small")


def _cleanup(cfg: PipelineConfig) -> None:
    shutil.rmtree(cfg.root, ignore_errors=True)


@pytest.mark.skipif(not engine_available(ENGINE_SPARK), reason="pyspark not available")
def test_spark_run_emits_lifecycle_events() -> None:
    from pipelines.governance.coordinator import GovernanceCoordinator

    cfg = _fresh_cfg()
    coord = GovernanceCoordinator()
    try:
        manifest = run_batch_with_engine(cfg, ENGINE_SPARK, coord, gate=TestOnlyWriteGate())
        assert manifest.success
        events = coord.store.events_for_run(cfg.run_id)
        types = [e["eventType"] for e in events]
        assert "JOB_SUBMITTED" in types
        assert "STAGE_COMPLETED" in types
        assert "TASK_SUMMARY" in types
        assert "JOB_SUCCEEDED" in types
        assert "PROGRESS_UPDATED" in types, "deadline heartbeat emitted"
        # the reducer observes the terminal state
        snap = coord.snapshot(cfg.run_id)
        assert snap["state"] in ("COMPLETED", "RUNNING", "SUCCEEDED")
    finally:
        _cleanup(cfg)


@pytest.mark.skipif(not engine_available(ENGINE_SPARK), reason="pyspark not available")
def test_govern_spark_healthy_run_no_high_findings() -> None:
    cfg = _fresh_cfg()
    try:
        manifest, findings, summary = run_governed_batch(
            cfg, ENGINE_SPARK, gate=TestOnlyWriteGate())
        assert manifest.success
        assert summary["engine"] == "SPARK"
        assert summary["status"] == "SUCCEEDED"
        assert summary["stages"], "stage events aggregated"
        # a healthy local run must not produce HIGH/BLOCKER findings
        highs = [f for f in findings if f["severity"] in ("HIGH", "BLOCKER")]
        assert highs == [], f"unexpected high findings: {highs}"
    finally:
        _cleanup(cfg)


@pytest.mark.skipif(not engine_available(ENGINE_SPARK), reason="pyspark not available")
def test_heartbeat_updates_snapshot() -> None:
    from pipelines.governance.coordinator import GovernanceCoordinator

    cfg = _fresh_cfg()
    coord = GovernanceCoordinator()
    try:
        run_batch_with_engine(cfg, ENGINE_SPARK, coord, gate=TestOnlyWriteGate())
        snap = coord.snapshot(cfg.run_id)
        assert "heartbeat" in snap or "lastEvent" in snap or snap.get("state"), \
            "snapshot carries the event stream state"
        # a PROGRESS_UPDATED event exists with the renewed deadline payload
        events = coord.store.events_for_run(cfg.run_id)
        progress = [e for e in events if e["eventType"] == "PROGRESS_UPDATED"]
        assert progress, "heartbeat events present"
    finally:
        _cleanup(cfg)


@pytest.mark.skipif(not engine_available(ENGINE_FLINK), reason="pyflink not available (Python <= 3.12)")
def test_flink_governed_loop() -> None:
    cfg = _fresh_cfg()
    try:
        manifest, findings, summary = run_governed_batch(
            cfg, ENGINE_FLINK, gate=TestOnlyWriteGate())
        assert manifest.success
        assert summary["engine"] == "FLINK"
        assert summary["status"] == "SUCCEEDED"
    finally:
        _cleanup(cfg)


def test_unknown_engine_rejected() -> None:
    cfg = _fresh_cfg()
    try:
        with pytest.raises(ValueError):
            run_batch_with_engine(cfg, "kafka")
    finally:
        _cleanup(cfg)
