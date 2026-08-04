"""Read-only governance reader — serves the gateway's governance API.

Reads the materialized governance tables (governance_dwd/ads/...). The
gateway never writes them; if no governance tables exist (CDXR not configured)
every lookup returns empty/None so the gateway stays fully functional.
"""
from __future__ import annotations

import json
from typing import Any

from pyiceberg.catalog import Catalog


class GovernanceReader:
    """Read-only facade over the governance tables (deterministic)."""

    def __init__(self, catalog: Catalog):
        self._catalog = catalog

    # -- helpers -----------------------------------------------------

    def _table_rows(self, table_name: str) -> list[dict[str, Any]]:
        if not self._catalog:  # catalog unavailable (CDXR not configured)
            return []
        try:
            table = self._catalog.load_table(table_name)
        except Exception:
            return []
        try:
            return table.scan().to_arrow().to_pylist()
        except Exception:
            return []

    def _table_rows_for(self, table_name: str, dataset_id: str) -> list[dict[str, Any]]:
        """Scan with dataset_id pushdown (review: governance reads grow with
        the record count — filter at the scan level instead of full scans)."""
        if not self._catalog:
            return []
        try:
            from pyiceberg import expressions as E
            table = self._catalog.load_table(table_name)
            return table.scan(row_filter=E.EqualTo("dataset_id", dataset_id)).to_arrow().to_pylist()
        except Exception:
            return []

    def _match_dataset_id(self, dataset_id: str, known_ids: list[str]) -> str | None:
        """Resolve a short dataset id (search_catalog style: 'model_metrics')
        to the canonical namespaced id stored in governance tables
        ('ads.model_metrics'). Exact ids pass through; a short id is resolved
        only when it maps to exactly one DISTINCT namespaced id (review fix:
        the agent chain and governance tables must interoperate)."""
        known = {d for d in known_ids if d}
        if dataset_id in known:
            return dataset_id
        if "." not in dataset_id:
            candidates = [d for d in known if d.split(".")[-1] == dataset_id]
            if len(candidates) == 1:
                return candidates[0]
        return None

    @staticmethod
    def _parse_json(value: Any, default: Any) -> Any:
        if not value:
            return default
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return default

    # -- trust profile ------------------------------------------------

    def get_profile(self, dataset_id: str) -> dict[str, Any] | None:
        rows = self._table_rows_for("governance_ads.dataset_trust_profile", dataset_id)
        if not rows:
            # short-id fallback (search_catalog style); resolves to a single namespaced id
            all_rows = self._table_rows("governance_ads.dataset_trust_profile")
            matched = self._match_dataset_id(dataset_id, [r.get("dataset_id") for r in all_rows])
            if matched is None or matched == dataset_id:
                return None
            rows = [r for r in all_rows if r.get("dataset_id") == matched]
        if not rows:
            return None
        latest = max(rows, key=lambda r: r.get("generated_at", ""))
        return {
            "datasetId": latest.get("dataset_id"),
            "snapshotId": latest.get("snapshot_id") or None,
            "governanceScore": latest.get("governance_score"),
            "status": latest.get("status"),
            "openFindingCount": latest.get("open_finding_count"),
            "highestSeverity": latest.get("highest_severity"),
            "dimensionScores": self._parse_json(latest.get("dimension_scores"), {}),
            "qualityStatus": latest.get("quality_status"),
            "qualityReference": latest.get("quality_reference") or None,
            "lineageReference": latest.get("lineage_reference") or None,
            "findingIds": self._parse_json(latest.get("finding_ids"), []),
            "generatedAt": latest.get("generated_at"),
            "ruleCount": latest.get("rule_count", 0),
            "failedRuleCount": latest.get("failed_rule_count", 0),
        }

    # -- findings ----------------------------------------------------

    def _finding_to_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "findingId": row.get("finding_id"),
            "runId": row.get("run_id"),
            "ruleId": row.get("rule_id"),
            "datasetId": row.get("dataset_id"),
            "fieldName": row.get("field_name") or None,
            "riskType": row.get("risk_type"),
            "riskStatus": row.get("risk_status"),
            "severity": row.get("severity"),
            "confidence": row.get("confidence"),
            "reasonCodes": self._parse_json(row.get("reason_codes"), []),
            "evidenceReferences": self._parse_json(row.get("evidence_refs"), []),
            "snapshotId": row.get("snapshot_id") or None,
            "dataVersion": row.get("data_version") or None,
            "qualityReference": row.get("quality_reference") or None,
            "lineageReference": row.get("lineage_reference") or None,
            "status": row.get("status"),
            "firstDetectedAt": row.get("first_detected_at"),
            "lastDetectedAt": row.get("last_detected_at"),
            "createdAt": row.get("created_at"),
            "recommendation": row.get("recommendation"),
            "summary": row.get("summary"),
        }

    def list_findings(self, dataset_id: str | None = None, severity: str | None = None,
                      status: str | None = None, rule_id: str | None = None,
                      limit: int = 100, dedup: bool = True) -> list[dict[str, Any]]:
        if dataset_id:
            rows = self._table_rows_for("governance_dwd.cdxr_finding", dataset_id)
            if not rows and "." not in dataset_id:
                # short-id fallback
                all_rows = self._table_rows("governance_dwd.cdxr_finding")
                matched = self._match_dataset_id(dataset_id, [r.get("dataset_id") for r in all_rows])
                rows = [r for r in all_rows if r.get("dataset_id") == matched]
        else:
            rows = self._table_rows("governance_dwd.cdxr_finding")
        if severity:
            rows = [r for r in rows if r.get("severity") == severity.upper()]
        if status:
            rows = [r for r in rows if r.get("status") == status.upper()]
        if rule_id:
            rows = [r for r in rows if r.get("rule_id") == rule_id]
        if dedup:
            by_key: dict[tuple, dict] = {}
            for r in sorted(rows, key=lambda r: r.get("last_detected_at", "")):
                key = (r.get("dataset_id"), r.get("rule_id"), r.get("field_name") or "")
                by_key[key] = r
            rows = list(by_key.values())
        rows.sort(key=lambda r: r.get("last_detected_at", ""), reverse=True)
        return [self._finding_to_dict(r) for r in rows[:limit]]

    def get_finding(self, finding_id: str) -> dict[str, Any] | None:
        rows = [r for r in self._table_rows("governance_dwd.cdxr_finding")
                if r.get("finding_id") == finding_id]
        if not rows:
            return None
        # latest occurrence wins (append-only table; review round-4 P1)
        latest = max(rows, key=lambda r: r.get("last_detected_at", "") or r.get("created_at", ""))
        return self._finding_to_dict(latest)

    def get_finding_evidence(self, finding_id: str) -> list[dict[str, Any]]:
        finding = self.get_finding(finding_id)
        if finding is None:
            return []
        rows = self._table_rows("governance_dwd.cdxr_evidence")
        rows = [r for r in rows if r.get("finding_id") == finding_id]
        # occurrence boundary: the latest finding occurrence's
        # evidenceReferences are authoritative — two runs on the SAME snapshot
        # produce different evidence ids, so snapshot scoping alone leaks stale
        # evidence (review round-4.1 P3). Snapshot filtering is only a
        # compatibility fallback for occurrences without references.
        refs = {r[len("evidence:"):] for r in (finding.get("evidenceReferences") or [])
                if r.startswith("evidence:")}
        if refs:
            rows = [r for r in rows if r.get("evidence_id") in refs]
        else:
            latest_snap = finding.get("snapshotId")
            if latest_snap:
                rows = [r for r in rows if str(r.get("source_snapshot") or "") == str(latest_snap)]
        return [{
            "evidenceId": r.get("evidence_id"),
            "findingId": r.get("finding_id"),
            "sourceType": r.get("source_type"),
            "sourceReference": r.get("source_reference"),
            "sourceSnapshot": r.get("source_snapshot") or None,
            "observedValue": r.get("observed_value"),
            "expectedValue": r.get("expected_value") or None,
            "confidence": r.get("confidence"),
            "evaluatorVersion": r.get("evaluator_version"),
            "createdAt": r.get("created_at"),
        } for r in rows]

    # -- runs ---------------------------------------------------------

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        rows = self._table_rows("governance_dwd.cdxr_run")
        run = next((r for r in rows if r.get("run_id") == run_id), None)
        if run is None:
            return None
        rule_results = self._table_rows("governance_dwd.cdxr_rule_result")
        return {
            "runId": run.get("run_id"),
            "datasetId": run.get("dataset_id"),
            "datasetLayer": run.get("dataset_layer"),
            "snapshotId": run.get("snapshot_id") or None,
            "status": run.get("status"),
            "startedAt": run.get("started_at"),
            "finishedAt": run.get("finished_at"),
            "rulesExecuted": run.get("rules_executed"),
            "findingsCreated": run.get("findings_created"),
            "findingsReopened": run.get("findings_reopened"),
            "error": run.get("error") or None,
            "ruleResults": [{
                "ruleId": r.get("rule_id"), "passed": r.get("passed"),
                "resultCount": r.get("result_count"), "detail": r.get("detail"),
                "evaluatedAt": r.get("evaluated_at"),
            } for r in rule_results if r.get("run_id") == run_id],
        }

    # -- review queue --------------------------------------------------

    ACTIVE_STATUSES = ("OPEN", "UNDER_REVIEW")

    def _active_finding_ids(self) -> set[str] | None:
        """Finding ids whose CURRENT (latest-occurrence) status is active.

        None when the finding table is unavailable — callers then skip the
        filter (queue records alone cannot be projected)."""
        try:
            rows = self._table_rows("governance_dwd.cdxr_finding")
        except Exception:
            return None
        if not rows:
            return None
        latest: dict[str, dict] = {}
        for r in sorted(rows, key=lambda r: r.get("last_detected_at", "") or r.get("created_at", "")):
            fid = r.get("finding_id")
            if fid:
                latest[fid] = r
        return {fid for fid, r in latest.items() if r.get("status") in self.ACTIVE_STATUSES}

    def get_review_queue(self, dataset_id: str | None = None) -> list[dict[str, Any]]:
        if dataset_id:
            rows = self._table_rows_for("governance_ads.governance_review_queue", dataset_id)
            if not rows and "." not in dataset_id:
                all_rows = self._table_rows("governance_ads.governance_review_queue")
                matched = self._match_dataset_id(dataset_id, [r.get("dataset_id") for r in all_rows])
                rows = [r for r in all_rows if r.get("dataset_id") == matched]
        else:
            rows = self._table_rows("governance_ads.governance_review_queue")
        # dedup by finding (latest queue entry wins)
        latest: dict[str, dict] = {}
        for r in sorted(rows, key=lambda r: r.get("queued_at", "")):
            latest[r.get("finding_id")] = r
        rows = list(latest.values())
        # current-state projection: an append-only queue keeps stale OPEN
        # records for findings that are now RESOLVED — drop them here so the
        # queue reflects the findings' current status (review round-4 P1).
        active = self._active_finding_ids()
        if active is not None:
            rows = [r for r in rows if r.get("finding_id") in active]
        rows.sort(key=lambda r: r.get("queued_at", ""), reverse=True)
        return [{
            "findingId": r.get("finding_id"),
            "datasetId": r.get("dataset_id"),
            "severity": r.get("severity"),
            "confidence": r.get("confidence"),
            "summary": r.get("summary"),
            "queuedAt": r.get("queued_at"),
            "assignee": r.get("assignee") or None,
        } for r in rows]
