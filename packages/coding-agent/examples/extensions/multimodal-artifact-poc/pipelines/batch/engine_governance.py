"""Engine-governance loop — real engine runs feed the governance agent.

Flow:
  run_batch_with_engine(engine, coordinator)
    -> engine emits JOB_SUBMITTED / STAGE_COMPLETED / TASK_SUMMARY /
       CHECKPOINT_METRICS / JOB_SUCCEEDED|FAILED + deadline heartbeats
    -> adapters aggregate events into a spark/flink-runtime-summary
    -> RuntimeGovernance rules produce findings (persisted + surfaced as
       FINDING_DETECTED events)
    -> State Reducer / status bar observe the same event stream
"""
from __future__ import annotations

from typing import Any, Optional

from pipelines.batch.engine import (
    ENGINE_FLINK,
    ENGINE_SPARK,
    EngineReporter,
    run_batch_with_engine,
)


def _summary_from_events(engine: str, events: list[dict], run_id: str,
                         pipeline_id: str, pipeline_version: int) -> dict:
    if engine == ENGINE_SPARK:
        from pipelines.governance.adapters import spark_summary_from_events
        return spark_summary_from_events(events, pipeline_id, pipeline_version,
                                         run_id, job_id=1)
    from pipelines.governance.adapters import flink_summary_from_events
    return flink_summary_from_events(events, pipeline_id, pipeline_version,
                                     run_id, job_id=1)


def run_governed_batch(cfg: Any, engine: str = ENGINE_SPARK,
                       coordinator: Optional[Any] = None,
                       gate: Optional[Any] = None) -> tuple[Any, list[dict], dict]:
    """Run the batch on a real engine and apply runtime governance to the
    events the run actually emitted.

    Returns (manifest, findings, summary). Findings are persisted through
    the coordinator (FINDING_DETECTED events reach the state machine).
    """
    from pipelines.governance.coordinator import GovernanceCoordinator
    from pipelines.governance.runtime_governance import RuntimeGovernance

    coord = coordinator or GovernanceCoordinator()
    manifest = run_batch_with_engine(cfg, engine, coord, gate=gate)

    events = coord.store.events_for_run(cfg.run_id)
    summary = _summary_from_events(engine, events, cfg.run_id, "batch", 1)
    rules = RuntimeGovernance()
    findings = (rules.govern_spark(summary) if engine == ENGINE_SPARK
                else rules.govern_flink(summary))
    for f in findings:
        coord.record_finding(f)
    return manifest, findings, summary


def summarize_run(engine: str, cfg: Any,
                  coordinator: Optional[Any] = None) -> dict:
    """Build the runtime summary for an ALREADY RUN engine batch (no rerun)."""
    from pipelines.governance.coordinator import GovernanceCoordinator
    coord = coordinator or GovernanceCoordinator()
    events = coord.store.events_for_run(cfg.run_id)
    return _summary_from_events(engine, events, cfg.run_id, "batch", 1)
