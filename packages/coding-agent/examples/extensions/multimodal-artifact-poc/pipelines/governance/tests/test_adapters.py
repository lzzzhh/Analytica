"""Runtime adapter tests (§4.2): engine facts -> uniform summaries.

- Iceberg adapter reads the REAL pyiceberg catalog (snapshots/data files)
- Spark/Flink adapters aggregate fixture lifecycle events (verified=false)
- every summary passes its contract and feeds the deterministic engine
"""
import sys
from pathlib import Path

import pyarrow as pa
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.common.config import ensure_namespaces, open_catalog  # noqa: E402
from pipelines.batch.stages import _create_table, _upsert_overwrite  # noqa: E402
from pipelines.governance.adapters import (  # noqa: E402
    flink_summary_from_events,
    iceberg_summary_from_catalog,
    spark_summary_from_events,
)
from pipelines.governance.contracts import is_valid_contract  # noqa: E402
from pipelines.governance.runtime_governance import RuntimeGovernance  # noqa: E402


class TestIcebergAdapter:
    def test_reads_real_catalog_state(self, tmp_path):
        catalog = open_catalog(tmp_path / "wh")
        ensure_namespaces(catalog)
        tbl = pa.table({"k": pa.array([1, 2, 3], pa.int64())})
        _create_table(catalog, "ods.demo", tbl.schema)
        _upsert_overwrite(catalog, "ods.demo", tbl)
        summary = iceberg_summary_from_catalog(catalog, "ods.demo", "p1", 1, "run1")
        assert is_valid_contract("iceberg-commit-summary", summary)
        assert summary["verified"] is False  # contract const
        assert summary["snapshotId"] != "none"
        assert len(summary["dataFiles"]) >= 1
        # engine consumes it
        findings = RuntimeGovernance().govern_iceberg(summary)
        assert any(f["code"] == "SMALL_FILES" for f in findings)


class TestSparkFlinkAdapters:
    def test_spark_fixture_events(self):
        s = spark_summary_from_events([
            {"eventType": "JOB_SUCCEEDED"},
            {"eventType": "STAGE_COMPLETED", "stageId": 1,
             "inputRows": 10, "outputRows": 100},
        ], "p1", 1, "run1", 1)
        assert is_valid_contract("spark-runtime-summary", s)
        assert s["status"] == "SUCCEEDED"
        assert len(s["stages"]) == 1
        assert any(f["code"] == "DATA_SKEW"
                   for f in RuntimeGovernance().govern_spark(s))

    def test_flink_fixture_events(self):
        f = flink_summary_from_events([
            {"eventType": "JOB_FAILED"},
            {"eventType": "CHECKPOINT_METRICS",
             "metrics": {"lastFailed": 1, "staleSeconds": 0}},
        ], "p1", 1, "run1", 1)
        assert is_valid_contract("flink-runtime-summary", f)
        assert f["status"] == "FAILED"
        codes = [x["code"] for x in RuntimeGovernance().govern_flink(f)]
        assert "JOB_FAILED" in codes
        assert "CHECKPOINT_FAILURE" in codes
