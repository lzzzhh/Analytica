"""Pipeline common — configuration, catalog, contracts, manifests.

All pipeline code lives under pipelines/ and writes ONLY to the test
warehouse (default .data/pipeline-test) unless explicitly pointed elsewhere.
Gateway stays read-only; pipeline write paths are never exposed as agent
tools.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Profile / layout
# ---------------------------------------------------------------------------

PROFILES = {
    "small": {"days": 30, "entities": 100, "scale": 1},
    "medium": {"days": 90, "entities": 1000, "scale": 10},
    "stress": {"days": 365, "entities": 5000, "scale": 50},
}

DEFAULT_PROFILES = ("small", "medium")


def profile_params(profile: str) -> dict:
    if profile not in PROFILES:
        raise ValueError(f"unknown profile '{profile}' (choose from {sorted(PROFILES)})")
    return PROFILES[profile]


@dataclass
class PipelineConfig:
    """Runtime configuration for one pipeline invocation."""

    root: Path
    mode: str  # batch | streaming | hybrid
    profile: str
    reset: bool = False
    replay: Optional[str] = None
    micro_batch_size: int = 25
    run_id: str = field(default_factory=lambda: f"run_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}")

    @property
    def warehouse(self) -> Path:
        return self.root / "warehouse"

    @property
    def catalog_db(self) -> Path:
        return self.warehouse / ".lakehouse-catalog.db"

    @property
    def source_dir(self) -> Path:
        return self.root / "source"

    @property
    def batch_source_dir(self) -> Path:
        return self.source_dir / "batch"

    @property
    def stream_source(self) -> Path:
        return self.source_dir / "stream" / "events.jsonl"

    @property
    def checkpoints_dir(self) -> Path:
        return self.root / "checkpoints"

    @property
    def outputs_dir(self) -> Path:
        return self.root / "outputs"

    @property
    def logs_dir(self) -> Path:
        return self.root / "logs"

    @property
    def manifests_dir(self) -> Path:
        return self.outputs_dir / "manifests"

    def ensure_dirs(self) -> None:
        for d in (self.warehouse, self.batch_source_dir, self.source_dir / "stream",
                  self.checkpoints_dir, self.outputs_dir, self.logs_dir, self.manifests_dir):
            d.mkdir(parents=True, exist_ok=True)


def load_config(env: Optional[dict] = None, **overrides) -> PipelineConfig:
    """Build config from env + overrides. Root defaults to .data/pipeline-test."""
    env = env if env is not None else os.environ
    root = Path(env.get("PIPELINE_TEST_ROOT", ".data/pipeline-test"))
    mode = overrides.pop("mode", env.get("PIPELINE_MODE", "batch"))
    profile = overrides.pop("profile", env.get("PIPELINE_PROFILE", "small"))
    reset = overrides.pop("reset", env.get("PIPELINE_RESET", "false").lower() in ("1", "true", "yes"))
    replay = overrides.pop("replay", env.get("PIPELINE_REPLAY") or None)
    return PipelineConfig(root=root, mode=mode, profile=profile, reset=reset, replay=replay, **overrides)


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------

def open_catalog(warehouse: Path):
    """Open the pyiceberg SQL catalog for a warehouse (shared with Gateway
    protocol: sqlite metadata + warehouse data files)."""
    warehouse.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "lakehouse-gateway"))
    from app.catalog.dataset_registry import load_catalog  # type: ignore
    return load_catalog(
        "lakehouse", type="sql",
        uri=f"sqlite:///{warehouse / '.lakehouse-catalog.db'}",
        warehouse=str(warehouse),
    )


def ensure_namespaces(catalog, namespaces: tuple[str, ...] = ("ods", "dwd", "dws", "ads")) -> None:
    for ns in namespaces:
        try:
            catalog.create_namespace(ns)
        except Exception:
            pass  # already exists


# ---------------------------------------------------------------------------
# Contracts / row types
# ---------------------------------------------------------------------------

TABLE_LAYERS = {
    "ods.streaming_events": "ods",
    "ods.pipeline_events_raw": "ods",
    "ods.loan_applications_raw": "ods",
    "ods.feature_inputs_raw": "ods",
    "ods.prediction_inputs_raw": "ods",
    "ods.model_metric_inputs_raw": "ods",
    "dwd.loan_application_detail": "dwd",
    "dws.feature_values": "dws",
    "dws.prediction_points": "dws",
    "ads.model_metrics": "ads",
}

BUSINESS_KEYS = {
    "dwd.loan_application_detail": ["application_id"],
    "dws.feature_values": ["entity_id", "feature_id", "event_time"],
    "dws.prediction_points": ["entity_id", "event_time"],
    "ads.model_metrics": ["model_id", "metric_date"],
    "ods.streaming_events": ["event_id"],
}

STREAM_EVENT_SCHEMA = [
    "event_id", "event_type", "source_table", "entity_id", "event_time", "payload_json",
]

LAYER_ORDER = ["ods", "dwd", "dws", "ads"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def new_batch_id() -> str:
    return f"b_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
