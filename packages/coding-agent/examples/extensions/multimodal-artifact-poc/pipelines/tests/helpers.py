"""Explicit test-only pipeline dependencies; never imported by product code."""
from __future__ import annotations


class TestOnlyWriteGate:
    __test__ = False

    def require_approved(self, _target: str, approval_id: str | None = None) -> str:
        return approval_id or "test-only-approval"

    def publish(self, catalog, target: str, table, approval_id: str | None = None,
                batch_id: str | None = None, base_snapshot_id: int | None = None) -> int:
        from pipelines.batch.stages import _create_table, _table_exists, _upsert_overwrite

        self.require_approved(target, approval_id)
        if not _table_exists(catalog, target):
            _create_table(catalog, target, table.schema)
        return _upsert_overwrite(catalog, target, table)
