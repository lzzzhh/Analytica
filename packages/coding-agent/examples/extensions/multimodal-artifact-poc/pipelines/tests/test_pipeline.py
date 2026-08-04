"""Pipeline unit tests — deterministic, no network, use a temp warehouse.

Coverage manifest features (round2.pipeline, round2.batch_pipeline,
round2.stream_replay_pipeline, round2.pipeline_source_generation,
round2.pipeline_ods_load, round2.pipeline_dwd_transform,
round2.pipeline_dws_transform, round2.pipeline_ads_transform,
round2.pipeline_checkpointing, round2.pipeline_dead_letter,
round2.pipeline_validation) are exercised by this module and by the
experiments/e2e-*-pipeline.mts / verify-pipeline-data.mts harnesses.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pipelines.common.config import PipelineConfig  # noqa: E402
from pipelines.common.generators import (  # noqa: E402
    gen_feature_inputs,
    gen_loan_applications,
    gen_model_metric_inputs,
    gen_prediction_inputs,
    gen_stream_events,
)
from pipelines.streaming.engine import (  # noqa: E402
    StreamCounters,
    StreamState,
    classify,
    normalize_event,
    parse_event_time,
    read_events,
)
from pipelines.tests.helpers import TestOnlyWriteGate  # noqa: E402


@pytest.fixture()
def cfg(tmp_path) -> PipelineConfig:
    return PipelineConfig(root=tmp_path / "pipeline-test", mode="batch", profile="small")


@pytest.fixture()
def stream_cfg(tmp_path) -> PipelineConfig:
    return PipelineConfig(root=tmp_path / "pipeline-test", mode="streaming", profile="small")


# ---------------------------------------------------------------------------
# generators
# ---------------------------------------------------------------------------

def test_loan_generator_contains_duplicate_and_null():
    import random
    rng = random.Random(42)
    rows = gen_loan_applications(rng, [f"ent_{i:03d}" for i in range(1, 11)], 30)
    ids = [r["application_id"] for r in rows]
    assert len(ids) > len(set(ids)), "must contain a duplicate application_id"
    assert any(r["borrower_score"] is None for r in rows), "must contain null borrower_score"


def test_feature_generator_has_drift_and_missingness():
    import random
    rng = random.Random(42)
    entities = [f"ent_{i:03d}" for i in range(1, 11)]
    rows = gen_feature_inputs(rng, entities, 30)
    from pipelines.common.generators import ANOMALY_DAY, day_date, date_str
    before = [r for r in rows if r["feature_id"] == "feature_debt_ratio" and r["event_time"] < date_str(day_date(ANOMALY_DAY)) and r["feature_value"] is not None]
    after = [r for r in rows if r["feature_id"] == "feature_debt_ratio" and r["event_time"] >= date_str(day_date(ANOMALY_DAY)) and r["feature_value"] is not None]
    before_mean = sum(r["feature_value"] for r in before) / len(before)
    after_mean = sum(r["feature_value"] for r in after) / len(after)
    assert after_mean > before_mean + 0.1, "debt_ratio must drift up after anomaly day"
    missing_after = sum(1 for r in rows if r["event_time"] >= date_str(day_date(ANOMALY_DAY)) and r["feature_value"] is None)
    missing_before = sum(1 for r in rows if r["event_time"] < date_str(day_date(ANOMALY_DAY)) and r["feature_value"] is None)
    assert missing_after > missing_before, "missingness must rise after anomaly day"


def test_prediction_generator_stops_early():
    import random
    rng = random.Random(42)
    rows = gen_prediction_inputs(rng, [f"ent_{i:03d}" for i in range(1, 11)], 30)
    dates = sorted({r["event_time"] for r in rows})
    from pipelines.common.generators import day_date
    assert dates[-1] == day_date(28).isoformat(), "predictions stop 2 days early"


def test_model_metric_generator_auc_decline():
    import random
    rng = random.Random(42)
    rows = gen_model_metric_inputs(rng, 30, [f"ent_{i:03d}" for i in range(1, 11)])
    from pipelines.common.generators import ANOMALY_DAY, day_date
    v2 = [r for r in rows if r["model_id"] == "lgb_v2"]
    before = [r["auc"] for r in v2 if r["metric_date"] < day_date(ANOMALY_DAY).isoformat()]
    after = [r["auc"] for r in v2 if r["metric_date"] >= day_date(ANOMALY_DAY).isoformat()]
    assert sum(after) / len(after) < sum(before) / len(before) - 0.02, "lgb_v2 AUC must decline"


def test_stream_generator_scenarios():
    import random
    rng = random.Random(7)
    events = gen_stream_events(rng)
    ids = [e["event_id"] for e in events if e.get("event_id")]
    from collections import Counter
    c = Counter(ids)
    assert any(v > 1 for v in c.values()), "must contain duplicates"
    assert any("too_late" in str(e["event_id"]) for e in events), "must contain too-late events"
    assert any(e.get("event_id") is None or e.get("event_time") == "not-a-date" for e in events), "must contain invalid events"


# ---------------------------------------------------------------------------
# streaming engine
# ---------------------------------------------------------------------------

def test_parse_event_time_formats():
    assert parse_event_time("2026-07-30") is not None
    assert parse_event_time("2026-07-30T10:00:00") is not None
    assert parse_event_time("not-a-date") is None
    assert parse_event_time(None) is None


def test_normalize_invalid_events():
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    assert normalize_event({}, now).valid is False
    assert normalize_event({"event_id": None, "event_time": "2026-07-30"}, now).valid is False
    assert normalize_event({"event_id": "e1", "event_time": "2026-07-30", "event_type": "bogus"}, now).valid is False
    ok = normalize_event({"event_id": "e1", "event_time": "2026-07-30", "event_type": "feature_updated"}, now)
    assert ok.valid is True


def test_dedup_and_watermark():
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    state = StreamState()
    ev1 = normalize_event({"event_id": "a", "event_time": "2026-07-29", "event_type": "feature_updated"}, now)
    c1 = classify(ev1, state)
    assert c1.is_duplicate is False
    assert state.seen_event_ids == ["a"]
    # duplicate
    ev2 = normalize_event({"event_id": "a", "event_time": "2026-07-29", "event_type": "feature_updated"}, now)
    c2 = classify(ev2, state)
    assert c2.is_duplicate is True
    # too-late (older than watermark - 5d)
    ev3 = normalize_event({"event_id": "b", "event_time": "2026-07-01", "event_type": "feature_updated"}, now)
    c3 = classify(ev3, state)
    assert c3.is_too_late is True


def test_checkpoint_roundtrip(stream_cfg):
    from pipelines.streaming.engine import save_state, load_state
    state = StreamState(watermark="2026-07-30T00:00:00", seen_event_ids=["a", "b"],
                        counters=StreamCounters(accepted=2).to_dict(), last_offset=5)
    save_state(stream_cfg, state)
    loaded = load_state(stream_cfg)
    assert loaded.watermark == state.watermark
    assert loaded.seen_event_ids == ["a", "b"]
    assert loaded.counters["accepted"] == 2
    assert loaded.last_offset == 5


def test_read_events_resumes_from_offset(stream_cfg):
    src = stream_cfg.stream_source
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text(json.dumps({"event_id": "a"}) + "\n" + json.dumps({"event_id": "b"}) + "\n", encoding="utf-8")
    events = list(read_events(src, start_offset=-1))
    assert len(events) == 2
    resumed = list(read_events(src, start_offset=0))
    assert len(resumed) == 1
    assert resumed[0][1]["event_id"] == "b"


# ---------------------------------------------------------------------------
# micro-batch semantics (commit-fail ⇒ checkpoint does not advance)
# ---------------------------------------------------------------------------

class _FakeCatalog:
    """Stub catalog: append fails once, then succeeds."""

    def __init__(self):
        self.appends = 0
        self.rows = []

    def load_table(self, name):
        return self

    def table_exists(self, name):
        return False

    def append(self, table):
        self.appends += 1
        if self.appends == 1:
            raise RuntimeError("simulated commit failure")
        self.rows.extend(table.to_pylist())

    def history(self):
        return [1] * self.appends


class _FailingPublishGate(TestOnlyWriteGate):
    def publish(self, catalog, target, table, approval_id=None,
                batch_id=None, base_snapshot_id=None):
        return catalog.append(table)


def test_commit_failure_does_not_advance_checkpoint(stream_cfg):
    """A failed micro-batch commit must leave the checkpoint untouched."""
    from pipelines.streaming.engine import StreamState, save_state, load_state

    # seed a checkpoint that has consumed only line 0 of the source
    state = StreamState(watermark="2026-07-30T00:00:00",
                        seen_event_ids=["seed_event"],
                        counters={"accepted": 1, "duplicate": 0, "late": 0,
                                  "tooLate": 0, "invalid": 0},
                        last_offset=0)
    save_state(stream_cfg, state)

    # source with 9 new events (offsets 1-9); microBatchSize=5 → the first
    # flush (5 events) hits the failing catalog and must NOT advance the
    # checkpoint.
    stream_cfg.micro_batch_size = 5
    src = stream_cfg.stream_source
    src.parent.mkdir(parents=True, exist_ok=True)
    import json as _json
    from datetime import date, timedelta
    now = date(2026, 7, 30)
    lines = []
    for i in range(9):
        lines.append(_json.dumps({
            "event_id": f"new_{i}",
            "event_type": "feature_updated",
            "source_table": "dws.feature_values",
            "entity_id": "ent_001",
            "event_time": (now - timedelta(days=i % 3)).isoformat(),
            "payload_json": "{}",
        }))
    src.write_text("\n".join(lines) + "\n", encoding="utf-8")

    import pipelines.streaming.run_streaming as rs
    original = rs.open_catalog
    rs.open_catalog = lambda *a, **k: _FakeCatalog()
    try:
        import pytest as _pt
        with _pt.raises(RuntimeError):
            rs.run_streaming(stream_cfg, _FailingPublishGate())
    finally:
        rs.open_catalog = original

    after = load_state(stream_cfg)
    assert after.last_offset == 0, "checkpoint must not advance on failed commit"
    assert after.counters["accepted"] == 1, "counters must not advance on failed commit"
