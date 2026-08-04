"""CDXR governance CLI — standalone execution job.

Usage (from services/lakehouse-gateway):
    python -m app.governance.cdxr.run --dataset-id ads.model_metrics --snapshot latest

    python -m app.governance.cdxr.run --dataset-id ods.ocr_result \
        --time-column created_at --column-roles roles.json --as-of 2026-07-31T00:00:00Z

The CLI writes governance tables directly (governance identity); the Query
Gateway remains read-only. No LLM is involved.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from app.config import LakehouseConfig
from app.governance.cdxr.runner import run_governance
from app.governance.cdxr.store import ensure_governance_tables

# find the repo root that contains domains/ (may be several levels up)
for _parent in Path(__file__).resolve().parents:
    if (_parent / "domains").is_dir():
        sys.path.insert(0, str(_parent))
        break


def _open_catalog(config: LakehouseConfig):
    """Open the lakehouse catalog honoring LAKEHOUSE_MODE: glue for aws,
    SQL catalog for local (review: previously this always built a local
    SQLite catalog, making the CLI unusable with S3/Glue)."""
    from pyiceberg.catalog import load_catalog
    if config.is_aws:
        return load_catalog(
            "lakehouse",
            type="glue" if config.catalog_type == "glue" else "glue",
            warehouse=config.warehouse_path,
            region=config.region,
        )
    db_path = (Path(config.warehouse_path) / ".lakehouse-catalog.db").resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return load_catalog("lakehouse", type="sql",
                        uri=f"sqlite:///{db_path}", warehouse=str(db_path.parent))


def main(argv: list[str] | None = None) -> int:
    # Feature gate: the legacy governance CLI is disabled by default. It only
    # runs when legacy.cdxr_governance_cli is effective (feature registry).
    from app.features import get_default_resolver
    if not get_default_resolver().is_effective("legacy.cdxr_governance_cli"):
        print(
            "FEATURE_DISABLED: legacy.cdxr_governance_cli is not enabled. "
            "Set ENABLE_LEGACY_CDXR_GOVERNANCE_CLI=true (feature registry is the "
            "single source of truth; see docs/FEATURE_FLAGS.md).",
            file=sys.stderr,
        )
        return 2

    parser = argparse.ArgumentParser(description="CDXR governance run (deterministic)")
    parser.add_argument("--dataset-id", required=True, help="Iceberg table, e.g. ads.model_metrics")
    parser.add_argument("--snapshot", default="latest", help="snapshot id or 'latest'")
    parser.add_argument("--time-column", default=None, help="timestamp column for freshness")
    parser.add_argument("--policy", default="standard", choices=["standard", "with_lineage"])
    parser.add_argument("--as-of", default=None, help="run timestamp (ISO) for determinism")
    parser.add_argument("--column-roles", default=None, help="JSON file mapping field -> column_role")
    parser.add_argument("--vocabulary", default=None, help="JSON file with sensitive/domain/risk vocab")
    parser.add_argument("--lineage-upstream", default=None, help="comma-separated upstream dataset ids")
    parser.add_argument("--no-write", action="store_true", help="evaluate only, do not write tables")
    args = parser.parse_args(argv)

    config = LakehouseConfig.from_env()
    catalog = _open_catalog(config)

    column_roles = None
    if args.column_roles:
        with open(args.column_roles, encoding="utf-8") as fh:
            column_roles = json.load(fh)

    vocabulary = None
    if args.vocabulary:
        with open(args.vocabulary, encoding="utf-8") as fh:
            vocab_data = json.load(fh)
        from app.governance.cdxr.rules import Vocabulary
        vocabulary = Vocabulary(
            sensitive_fields=tuple(vocab_data.get("sensitive_fields", [])),
            domain_fields=tuple(vocab_data.get("domain_fields", [])),
            risk_indicators=tuple(vocab_data.get("risk_indicators", [])),
            eav_label_column=vocab_data.get("eav_label_column", "field_name"),
            eav_value_column=vocab_data.get("eav_value_column", "field_value"),
            ocr_confidence_column=vocab_data.get("ocr_confidence_column", "confidence"),
        )
    else:
        # default: inject the risk-domain vocabulary when the domain package exists
        try:
            from domains.risk.governance.cdxr.vocabulary import RISK_VOCABULARY
            vocabulary = RISK_VOCABULARY
        except Exception:
            vocabulary = None  # domain-neutral run (empty vocabulary)

    upstream = None
    if args.lineage_upstream:
        upstream = [s.strip() for s in args.lineage_upstream.split(",") if s.strip()]

    if not args.no_write:
        ensure_governance_tables(catalog)

    result = run_governance(
        catalog, args.dataset_id, args.snapshot,
        vocabulary=vocabulary, policy=args.policy, time_column=args.time_column,
        lineage_upstream=upstream, column_roles=column_roles, now=args.as_of,
        run_type="cli", write=not args.no_write,
    )

    out = {
        "run_id": result.run.run_id,
        "dataset_id": result.run.dataset_id,
        "snapshot_id": result.run.snapshot_id,
        "status": result.run.status,
        "rules_executed": result.run.rules_executed,
        "findings_created": result.run.findings_created,
        "trust_profile": result.profile,
        "findings": [
            {"finding_id": f.finding_id, "rule_id": f.rule_id, "severity": f.severity,
             "status": f.status.value, "risk_type": f.risk_type,
             "reason_codes": f.reason_codes, "summary": f.summary}
            for f in result.findings
        ],
        "written": result.written,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
