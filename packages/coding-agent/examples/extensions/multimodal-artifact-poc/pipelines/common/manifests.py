"""Pipeline execution manifests — per-run records for reproducibility."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from pipelines.common.config import PipelineConfig, utc_now_iso, write_json


@dataclass
class ExecutionManifest:
    run_id: str
    mode: str
    profile: str
    warehouse: str
    config: dict = field(default_factory=dict)
    layers: dict = field(default_factory=dict)  # layer -> {table, inputRows, outputRows, snapshotId}
    stream: dict = field(default_factory=dict)  # accepted/duplicate/late/tooLate/invalid counts
    stream_commits: dict = field(default_factory=dict)  # microBatchSize/commits/snapshots/dataFiles
    checkpoint: dict = field(default_factory=dict)
    started_at: str = field(default_factory=utc_now_iso)
    finished_at: str = ""
    success: bool = False
    error: str = ""
    path: str = ""

    @staticmethod
    def engine_declaration() -> dict:
        """Honest implementation declaration for the local harness."""
        return {
            "batchEngine": "pyiceberg-direct",
            "streamEngine": "python-event-replay",
            "distributed": False,
            "localCheckpointing": True,
            "engineCheckpointing": False,
            "exactlyOnceVerified": False,
            "icebergSparkConnectorVerified": False,
            "icebergFlinkConnectorVerified": False,
            "checkpointScope": "local-file",
            "deliverySemantics": "at-least-once-with-dedup",
        }

    def write(self, cfg: PipelineConfig) -> Path:
        self.finished_at = utc_now_iso()
        path = cfg.manifests_dir / f"execution-{self.run_id}.json"
        self.path = str(path)
        write_json(path, {
            "runId": self.run_id,
            "mode": self.mode,
            "profile": self.profile,
            "warehouse": self.warehouse,
            "config": self.config,
            "layers": self.layers,
            "stream": self.stream,
            "streamCommits": self.stream_commits,
            "checkpoint": self.checkpoint,
            "engine": self.engine_declaration(),
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "success": self.success,
            "error": self.error,
        })
        return path


def layer_record(table: str, input_rows: int, output_rows: int, snapshot_id: Any) -> dict:
    return {
        "table": table,
        "inputRows": input_rows,
        "outputRows": output_rows,
        "snapshotId": str(snapshot_id) if snapshot_id else None,
    }
