"""CDXR governance runner — deterministic orchestration.

Pipeline: catalog metadata → snapshot scan → profile → existing quality
(referenced, not duplicated) → lineage (referenced) → rules → findings →
evidence → aggregation → write governance tables.

The runner never calls an LLM; it only reads deterministic inputs.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

import pyarrow as pa
from pyiceberg import expressions as E
from pyiceberg.catalog import Catalog

from app.governance.cdxr.aggregate import build_trust_profile, risk_status_for
from app.governance.cdxr.contracts import (
    FindingStatus,
    GovernanceEvidenceV1,
    GovernanceFindingV1,
    GovernanceRunV1,
    Severity,
    SystemRecommendation,
)
from app.governance.cdxr.rules import (
    FindingCandidate,
    PolicyRegistry,
    RuleContext,
    RuleRegistry,
    Vocabulary,
    build_default_policies,
    build_default_registry,
)
from app.governance.cdxr.store import (
    dump_json,
    ensure_governance_tables,
    write_rows,
)

DIMENSION_OF_RULE = {
    "empty_dataset_check": "schema",
    "freshness_check": "freshness",
    "sensitive_field_check": "sensitive",
    "domain_field_check": "domain",
    "quality_reference_check": "quality",
    "lineage_reference_check": "lineage",
    "schema_confidence_check": "schema",
    "leakage_check": "leakage",
    "ocr_confidence_check": "schema",
}


@dataclass
class GovernanceRunResult:
    run: GovernanceRunV1
    findings: list[GovernanceFindingV1] = field(default_factory=list)
    evidence: list[GovernanceEvidenceV1] = field(default_factory=list)
    profile: dict[str, Any] = field(default_factory=dict)
    written: dict[str, str] = field(default_factory=dict)   # table -> snapshot id
    rule_results: list[dict[str, Any]] = field(default_factory=list)


def _digest(parts: list[str], prefix: str) -> str:
    return prefix + hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _scan_table(catalog: Catalog, dataset_id: str, snapshot: str) -> tuple[dict, pa.Table]:
    """Load table + latest-or-named snapshot and scan THAT snapshot's data.

    Review fix: the resolved snapshot id is passed to scan(snapshot_id=...) so
    a historical snapshot is actually analyzed (previously the scan read the
    current snapshot while meta advertised the requested one — evidence and
    quality results would then be bound to the wrong data).
    """
    table = catalog.load_table(dataset_id)
    meta: dict[str, Any] = {"table_id": dataset_id, "layer": dataset_id.split(".")[0]}
    if snapshot == "latest":
        snap = table.current_snapshot()
    else:
        snap = next((s for s in table.snapshots() if str(s.snapshot_id) == snapshot), None)
        if snap is None:
            raise LookupError(f"snapshot '{snapshot}' not found for {dataset_id}")
    meta["snapshot_id"] = str(snap.snapshot_id) if snap else None
    meta["data_version"] = str(snap.snapshot_id) if snap else ""
    fields = []
    for fld in table.schema().fields:
        fields.append({"name": fld.name, "type": str(fld.field_type), "required": fld.required})
    meta["fields"] = fields
    # an empty table (no snapshot) scans to an empty frame — EMPTY_DATASET
    data = table.scan(snapshot_id=snap.snapshot_id).to_arrow() if snap else pa.table({})
    return meta, data


def _build_profile(data: pa.Table, meta: dict, time_column: str | None,
                   vocabulary: Vocabulary) -> dict[str, Any]:
    profile: dict[str, Any] = {"row_count": data.num_rows, "missing_rates": {}}
    if data.num_rows == 0:
        return profile
    for col in data.column_names:
        n_null = data.column(col).null_count
        profile["missing_rates"][col] = round(n_null / len(data.column(col)), 4)
    if time_column and time_column in data.column_names:
        vals = [str(v) for v in data.column(time_column).to_pylist() if v is not None]
        if vals:
            profile["max_timestamp"] = max(vals)  # ISO strings sort lexicographically
    if vocabulary.eav_label_column and vocabulary.eav_label_column in data.column_names:
        profile["eav_label_values"] = [
            str(v) for v in data.column(vocabulary.eav_label_column).to_pylist() if v is not None
        ]
    if vocabulary.ocr_confidence_column and vocabulary.ocr_confidence_column in data.column_names:
        confs = [float(v) for v in data.column(vocabulary.ocr_confidence_column).to_pylist() if v is not None]
        if confs:
            profile["min_parser_confidence"] = min(confs)
    return profile


def _build_manifest(meta: dict, column_roles: dict[str, dict] | None) -> dict:
    roles = column_roles or {}
    fields = []
    for f in meta.get("fields", []):
        role = roles.get(f["name"], {})
        fields.append({
            "name": f["name"],
            "type": f.get("type", ""),
            "business_stage": role.get("business_stage", "unknown"),
            "semantic_role": role.get("semantic_role", "unknown"),
            "time_role": role.get("time_role", "unknown"),
            "feature_eligibility": role.get("feature_eligibility", "ALLOW"),
            "confidence": float(role.get("confidence", 1.0)),
        })
    return {"table_id": meta.get("table_id", ""), "fields": fields}


def _candidate_to_finding(cand: FindingCandidate, run_id: str, dataset_id: str,
                          meta: dict, quality_reference: str, lineage_reference: str,
                          now: str, prev: dict | None = None
                          ) -> tuple[GovernanceFindingV1, list[GovernanceEvidenceV1], bool]:
    """Build a finding with a STABLE identity (review fix: lifecycle).

    finding_id = hash(dataset_id, rule_id, field_name) — stable across runs so
    the same problem is one finding, not a new one every run. When a previous
    occurrence exists: first_detected_at is preserved, last_detected_at is
    updated, UNDER_REVIEW/WAIVED statuses are inherited, and a RESOLVED
    finding that reappears is REOPENed (returned as reopened=True).
    """
    key = [dataset_id, cand.rule_id, cand.field_name or ""]
    finding_id = _digest(key, "fnd_")  # stable finding key (no run_id)
    reason_codes = list(dict.fromkeys(cand.reason_codes))
    reopened = False
    if prev is None:
        status = FindingStatus.OPEN.value
        first_detected = now
    else:
        first_detected = prev.get("first_detected_at") or now
        prev_status = prev.get("status") or FindingStatus.OPEN.value
        if prev_status in (FindingStatus.UNDER_REVIEW.value, FindingStatus.WAIVED.value):
            status = prev_status          # inherit review state
        elif prev_status == FindingStatus.RESOLVED.value:
            status = FindingStatus.OPEN.value  # reappeared after resolution
            reopened = True
        else:
            status = FindingStatus.OPEN.value
    findings = GovernanceFindingV1(
        finding_id=finding_id,
        run_id=run_id,
        dataset_id=dataset_id,
        field_name=cand.field_name,
        rule_id=cand.rule_id,
        risk_type=cand.risk_type,
        risk_status=risk_status_for(cand.severity),
        severity=cand.severity,
        confidence=cand.confidence,
        reason_codes=reason_codes,
        snapshot_id=meta.get("snapshot_id"),
        data_version=meta.get("data_version", ""),
        quality_reference=cand.quality_reference or quality_reference or None,
        lineage_reference=cand.lineage_reference or lineage_reference or None,
        status=status,
        first_detected_at=first_detected,
        last_detected_at=now,
        created_at=now,
        recommendation=SystemRecommendation.REVIEW_ALLOW.value,
        summary=cand.summary,
    )
    evidence = []
    for i, ev in enumerate(cand.evidence):
        # evidence id includes run_id: the stable finding_id plus index alone
        # would produce identical ids for every run (review round-4 P1)
        evidence.append(GovernanceEvidenceV1(
            evidence_id=_digest([run_id, finding_id, str(i)], "evd_"),
            finding_id=finding_id,
            source_type=ev.get("source_type", ""),
            source_reference=ev.get("source_reference", ""),
            source_snapshot=ev.get("source_snapshot", meta.get("snapshot_id") or ""),
            observed_value=str(ev.get("observed_value", "")),
            expected_value=str(ev.get("expected_value", "")) if ev.get("expected_value") is not None else None,
            confidence=float(ev.get("confidence", cand.confidence)),
            evaluator_version=ev.get("evaluator_version", "cdxr.rules.v1"),
            created_at=now,
        ))
    findings.evidence_refs = [f"evidence:{e.evidence_id}" for e in evidence]
    findings.exploitability_probe = {"status": "NOT_EVALUATED"}
    return findings, evidence, reopened


def _resolution_finding(prev: dict, run_id: str, dataset_id: str, meta: dict,
                        now: str) -> GovernanceFindingV1:
    """Build a RESOLVED occurrence for a previously-active finding whose
    problem no longer exists in the scanned data (stable finding_id preserved,
    first_detected_at preserved, last_detected_at = resolution time so the
    reader's latest-occurrence projection surfaces the RESOLVED state)."""
    return GovernanceFindingV1(
        finding_id=prev["finding_id"],
        run_id=run_id,
        dataset_id=dataset_id,
        field_name=prev.get("field_name") or "",
        rule_id=prev.get("rule_id"),
        risk_type=prev.get("risk_type") or "",
        risk_status=risk_status_for(prev.get("severity") or Severity.INFO.value),
        severity=prev.get("severity") or Severity.INFO.value,
        confidence=float(prev.get("confidence") or 0.0),
        reason_codes=[],
        snapshot_id=meta.get("snapshot_id"),
        data_version=meta.get("data_version", ""),
        quality_reference=prev.get("quality_reference") or None,
        lineage_reference=prev.get("lineage_reference") or None,
        status=FindingStatus.RESOLVED.value,
        first_detected_at=prev.get("first_detected_at") or now,
        last_detected_at=now,
        created_at=now,
        recommendation=SystemRecommendation.REVIEW_ALLOW.value,
        summary=prev.get("summary") or "",
    )


def run_governance(
    catalog: Catalog,
    dataset_id: str,
    snapshot: str = "latest",
    *,
    vocabulary: Vocabulary | None = None,
    registry: RuleRegistry | None = None,
    policies: PolicyRegistry | None = None,
    policy: str = "standard",
    time_column: str | None = None,
    lineage_upstream: list[str] | None = None,
    column_roles: dict[str, dict] | None = None,
    now: str | None = None,
    run_type: str = "cli",
    write: bool = True,
) -> GovernanceRunResult:
    """Run CDXR governance for one dataset/snapshot (deterministic)."""
    from datetime import datetime, timezone
    now = now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    vocab = vocabulary or Vocabulary()
    reg = registry or build_default_registry()
    pol = (policies or build_default_policies()).get(policy)
    run_id = _digest([dataset_id, snapshot, now], "run_")

    meta, data = _scan_table(catalog, dataset_id, snapshot)
    profile = _build_profile(data, meta, time_column, vocab)
    manifest = _build_manifest(meta, column_roles)
    quality_reference = f"quality://{dataset_id}?snapshot={meta.get('snapshot_id', '')}"
    lineage_reference = f"lineage://{dataset_id}"

    # existing quality (referenced, deterministic; empty scan → FAIL by definition)
    from app.quality.checks import assess_quality
    from app.config import LakehouseConfig
    quality = assess_quality(data, LakehouseConfig())
    quality_status = quality.status

    ctx = RuleContext(
        dataset_id=dataset_id,
        dataset_layer=meta.get("layer", ""),
        snapshot_id=meta.get("snapshot_id"),
        data_version=meta.get("data_version", ""),
        manifest=manifest,
        profile=profile,
        quality_status=quality_status,
        quality_reference=quality_reference,
        lineage_upstream=lineage_upstream or [],
        lineage_reference=lineage_reference,
        vocabulary=vocab,
        now=now,
        params=pol.get("params", {}),
    )

    rule_results: list[dict[str, Any]] = []
    candidates: list[FindingCandidate] = []
    for rule_id in pol["rules"]:
        try:
            out = reg.run(rule_id, ctx)
        except Exception as exc:
            rule_results.append({"run_id": run_id, "dataset_id": dataset_id, "rule_id": rule_id,
                                 "passed": "ERROR", "result_count": 0,
                                 "detail": f"{type(exc).__name__}: {exc}", "evaluated_at": now})
            continue
        rule_results.append({"run_id": run_id, "dataset_id": dataset_id, "rule_id": rule_id,
                             "passed": "PASS" if not out else "FAIL", "result_count": len(out),
                             "detail": "ok", "evaluated_at": now})
        candidates.extend(out)

    # finding lifecycle: previous occurrences (stable key) for THIS dataset
    # only — scanning all datasets would let one dataset's run resolve or
    # rewrite another dataset's findings (review round-4.1 P1)
    existing: dict[tuple, dict] = {}
    if write:
        try:
            f_tbl = catalog.load_table("governance_dwd.cdxr_finding")
            rows = f_tbl.scan(
                row_filter=E.EqualTo("dataset_id", dataset_id)
            ).to_arrow().to_pylist()
            for row in rows:
                key = (row["dataset_id"], row["rule_id"], row.get("field_name") or "")
                if key not in existing or row["last_detected_at"] > existing[key]["last_detected_at"]:
                    existing[key] = row
        except Exception:
            existing = {}

    findings: list[GovernanceFindingV1] = []
    evidence: list[GovernanceEvidenceV1] = []
    seen_keys: set[tuple] = set()
    reopened_count = 0
    for cand in candidates:
        key = (dataset_id, cand.rule_id, cand.field_name or "")
        if key in seen_keys:
            continue
        seen_keys.add(key)
        prev = existing.get(key)
        f, evs, reopened = _candidate_to_finding(cand, run_id, dataset_id, meta,
                                                 quality_reference, lineage_reference,
                                                 now, prev=prev)
        findings.append(f)
        evidence.extend(evs)
        if reopened:
            reopened_count += 1

    # lifecycle: problems that were active (OPEN / UNDER_REVIEW) in an earlier
    # run of THIS dataset but produced no candidate this run are resolved —
    # persist a RESOLVED occurrence so readers can project the current state
    # (review round-4 P1: without it the finding stays OPEN forever and the
    # review queue never clears). WAIVED is terminal and stays untouched.
    # Only rules actually evaluated this run may auto-resolve: an ERROR result
    # or a rule missing from the policy must NOT resolve its old findings —
    # absence of evidence is not evidence of absence when the rule never ran
    # (review round-4.1 P2).
    evaluated_rule_ids = {r["rule_id"] for r in rule_results
                          if r["passed"] in ("PASS", "FAIL")}
    resolutions: list[GovernanceFindingV1] = []
    for key, prev in existing.items():
        if key in seen_keys:
            continue
        prev_status = prev.get("status") or FindingStatus.OPEN.value
        if prev_status not in (FindingStatus.OPEN.value, FindingStatus.UNDER_REVIEW.value):
            continue
        # defensive: the filtered scan must never yield another dataset's finding
        assert prev.get("dataset_id") == dataset_id, (
            f"existing finding {prev.get('finding_id')} belongs to "
            f"{prev.get('dataset_id')}, not {dataset_id}")
        if prev.get("rule_id") not in evaluated_rule_ids:
            continue
        resolutions.append(_resolution_finding(prev, run_id, dataset_id, meta, now))

    failed_rules = [r for r in rule_results if r["passed"] == "ERROR"]
    run_status = "FAILED" if failed_rules else "COMPLETED"
    run_error = ("; ".join(f"{r['rule_id']}: {r['detail']}" for r in failed_rules)
                 if failed_rules else "")

    profile_result = build_trust_profile(
        dataset_id=dataset_id,
        snapshot_id=meta.get("snapshot_id"),
        findings=findings,
        quality_status=quality_status,
        quality_reference=quality_reference,
        lineage_reference=lineage_reference,
        dimension_of_rule=DIMENSION_OF_RULE,
        generated_at=now,
        rule_count=len(rule_results),
        failed_rule_count=len(failed_rules),
    )

    run_model = GovernanceRunV1(
        run_id=run_id,
        dataset_id=dataset_id,
        dataset_layer=meta.get("layer", ""),
        snapshot_id=meta.get("snapshot_id"),
        status=run_status,
        started_at=now,
        finished_at=now,
        rules_executed=len(rule_results),
        findings_created=len(findings),
        findings_reopened=reopened_count,
        error=run_error,
    )

    written: dict[str, str] = {}
    if write:
        ensure_governance_tables(catalog)
        written["governance_meta.cdxr_rule_registry"] = write_rows(
            catalog, "governance_meta.cdxr_rule_registry", [{
                "rule_id": spec.rule_id, "rule_name": spec.rule_id,
                "dimension": spec.dimension, "description": spec.description,
                "default_severity": spec.default_severity,
                "params": dump_json(pol.get("params", {})),
                "registered_at": now,
            } for spec in (reg.get(r) for r in pol["rules"])], now)
        written["governance_meta.cdxr_policy_registry"] = write_rows(
            catalog, "governance_meta.cdxr_policy_registry", [{
                "policy_name": policy, "rule_ids": dump_json(p["rules"]),
                "params": dump_json(p.get("params", {})), "registered_at": now,
            } for policy, p in (policies or build_default_policies()).all().items()], now)
        written["governance_dws.cdxr_issue_trend"] = write_rows(
            catalog, "governance_dws.cdxr_issue_trend", [{
                "dataset_id": dataset_id, "date_day": now[:10], "rule_id": r["rule_id"],
                "open_count": r["result_count"], "new_count": r["result_count"],
                "resolved_count": 0, "updated_at": now,
            } for r in rule_results], now)
        written["governance_dwd.cdxr_run"] = write_rows(catalog, "governance_dwd.cdxr_run", [{
            "run_id": run_id, "dataset_id": dataset_id, "dataset_layer": meta.get("layer", ""),
            "snapshot_id": meta.get("snapshot_id") or "", "status": run_model.status,
            "started_at": now, "finished_at": now, "rules_executed": len(rule_results),
            "findings_created": len(findings), "findings_reopened": reopened_count,
            "error": run_error,
        }], now)
        written["governance_dwd.cdxr_finding"] = write_rows(catalog, "governance_dwd.cdxr_finding",
            [_finding_row(f, meta) for f in findings + resolutions], now)
        written["governance_dwd.cdxr_evidence"] = write_rows(catalog, "governance_dwd.cdxr_evidence",
            [_evidence_row(e) for e in evidence], now)
        written["governance_dwd.cdxr_rule_result"] = write_rows(catalog, "governance_dwd.cdxr_rule_result",
            rule_results, now)
        written["governance_ods.cdxr_run_raw"] = write_rows(catalog, "governance_ods.cdxr_run_raw", [{
            "run_id": run_id, "dataset_id": dataset_id, "snapshot_id": meta.get("snapshot_id") or "",
            "run_type": run_type, "raw_payload": dump_json({"profile": profile, "manifest": manifest}),
            "event_at": now,
        }], now)
        written["governance_ods.cdxr_evidence_raw"] = write_rows(catalog, "governance_ods.cdxr_evidence_raw", [
            {"evidence_id": e.evidence_id, "run_id": run_id, "dataset_id": dataset_id,
             "source_type": e.source_type, "source_reference": e.source_reference,
             "raw_payload": dump_json({"observed_value": e.observed_value,
                                       "expected_value": e.expected_value}),
             "event_at": now} for e in evidence], now)
        written["governance_dws.cdxr_dataset_score_daily"] = write_rows(
            catalog, "governance_dws.cdxr_dataset_score_daily", [{
                "dataset_id": dataset_id, "score_date": now[:10],
                "governance_score": profile_result.governance_score,
                "status": profile_result.status,
                "open_finding_count": profile_result.open_finding_count,
                "highest_severity": profile_result.highest_severity,
                "generated_at": now,
            }], now)
        written["governance_dws.cdxr_dimension_summary"] = write_rows(
            catalog, "governance_dws.cdxr_dimension_summary", [{
                "dataset_id": dataset_id, "snapshot_id": meta.get("snapshot_id") or "",
                "dimension": dim, "score": score,
                "open_finding_count": len([f for f in findings
                                           if f.status == FindingStatus.OPEN.value
                                           and DIMENSION_OF_RULE.get(f.rule_id, "other") == dim]),
                "updated_at": now,
            } for dim, score in sorted(profile_result.dimension_scores.items())], now)
        written["governance_dws.cdxr_rule_coverage"] = write_rows(
            catalog, "governance_dws.cdxr_rule_coverage", [{
                "dataset_id": dataset_id, "rule_id": r["rule_id"], "executed": r["passed"],
                "findings_count": r["result_count"], "last_run_at": now,
            } for r in rule_results], now)
        written["governance_ads.dataset_trust_profile"] = write_rows(
            catalog, "governance_ads.dataset_trust_profile", [{
                "dataset_id": dataset_id, "snapshot_id": meta.get("snapshot_id") or "",
                "governance_score": profile_result.governance_score,
                "status": profile_result.status,
                "open_finding_count": profile_result.open_finding_count,
                "highest_severity": profile_result.highest_severity,
                "dimension_scores": dump_json(profile_result.dimension_scores),
                "quality_status": quality_status,
                "quality_reference": quality_reference,
                "lineage_reference": lineage_reference,
                "finding_ids": dump_json(profile_result.finding_ids),
                "generated_at": now,
                "rule_count": profile_result.rule_count,
                "failed_rule_count": profile_result.failed_rule_count,
            }], now)
        # review queue: only currently-active findings (OPEN / UNDER_REVIEW)
        written["governance_ads.governance_review_queue"] = write_rows(
            catalog, "governance_ads.governance_review_queue", [{
                "finding_id": f.finding_id, "dataset_id": dataset_id, "severity": f.severity,
                "confidence": f.confidence, "summary": f.summary, "queued_at": now, "assignee": "",
            } for f in findings
              if f.status in (FindingStatus.OPEN.value, FindingStatus.UNDER_REVIEW.value)], now)

    return GovernanceRunResult(
        run=run_model,
        findings=findings,
        evidence=evidence,
        profile=profile_result.model_dump(),
        written=written,
        rule_results=rule_results,
    )


def _finding_row(f: GovernanceFindingV1, meta: dict) -> dict:
    return {
        "finding_id": f.finding_id, "run_id": f.run_id, "rule_id": f.rule_id,
        "dataset_id": f.dataset_id, "field_name": f.field_name or "",
        "risk_type": f.risk_type, "risk_status": f.risk_status.value,
        "severity": f.severity.value, "confidence": f.confidence,
        "reason_codes": dump_json(f.reason_codes), "evidence_refs": dump_json(f.evidence_refs),
        "snapshot_id": f.snapshot_id or "", "data_version": f.data_version,
        "quality_reference": f.quality_reference or "", "lineage_reference": f.lineage_reference or "",
        "status": f.status.value, "first_detected_at": f.first_detected_at,
        "last_detected_at": f.last_detected_at, "created_at": f.created_at,
        "recommendation": f.recommendation.value, "summary": f.summary,
    }


def _evidence_row(e: GovernanceEvidenceV1) -> dict:
    return {
        "evidence_id": e.evidence_id, "finding_id": e.finding_id,
        "source_type": e.source_type, "source_reference": e.source_reference,
        "source_snapshot": e.source_snapshot, "observed_value": e.observed_value,
        "expected_value": e.expected_value or "", "confidence": e.confidence,
        "evaluator_version": e.evaluator_version, "created_at": e.created_at,
    }
