"""CDXR rule registry, policy registry and generic governance rules.

Generic kernel: rules reason about datasets/fields/snapshots through
RuleContext — manifest (schema), profile (scan statistics), quality result,
lineage and an injectable vocabulary. No domain terms appear here;
domains/risk injects its vocabulary via the registry.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Protocol

from app.governance.cdxr.engine import REASON_CODES, assess_validity, evaluate_feature
from app.governance.cdxr.contracts import Severity, SystemRiskStatus

# ---- generic rule-level reason codes (beyond the engine's leakage codes) ----
GENERIC_REASON_CODES = {
    "EMPTY_DATASET": {"severity": "CRITICAL", "default_action": "BLOCK"},
    "NO_FRESH_DATA": {"severity": "HIGH", "default_action": "REVIEW"},
    "SENSITIVE_FIELD": {"severity": "HIGH", "default_action": "REVIEW"},
    "DOMAIN_FIELD": {"severity": "MEDIUM", "default_action": "REVIEW"},
    "QUALITY_REFERENCE": {"severity": "MEDIUM", "default_action": "REVIEW"},
    "NO_LINEAGE": {"severity": "LOW", "default_action": "REVIEW"},
}

# freshness: a dataset whose newest record is older than this is stale
DEFAULT_STALENESS_SECONDS = 48 * 3600
# OCR/parser confidence below this triggers OCR_LOW_CONFIDENCE
DEFAULT_OCR_CONFIDENCE_THRESHOLD = 0.90
# feature column confidence below this triggers LOW_SCHEMA_CONFIDENCE
DEFAULT_SCHEMA_CONFIDENCE_THRESHOLD = 0.70


@dataclass
class Vocabulary:
    """Domain-injectable vocabulary (risk domain fills these in)."""
    sensitive_fields: tuple[str, ...] = ()
    domain_fields: tuple[str, ...] = ()
    risk_indicators: tuple[str, ...] = ()
    eav_label_column: str = "field_name"
    eav_value_column: str = "field_value"
    ocr_confidence_column: str = "confidence"


@dataclass
class RuleContext:
    """Everything a rule may read (deterministic inputs only)."""
    dataset_id: str = ""
    dataset_layer: str = ""               # ods | dwd | dws | ads
    snapshot_id: str | None = None
    data_version: str = ""
    manifest: dict[str, Any] = field(default_factory=dict)   # {"table_id","fields":[{name,confidence,time_role,...}]}
    profile: dict[str, Any] = field(default_factory=dict)    # {"row_count","missing_rates","max_timestamp",...}
    quality_status: str = ""              # PASS | WARN | FAIL | ""
    quality_reference: str = ""
    lineage_upstream: list[str] = field(default_factory=list)
    lineage_reference: str = ""
    vocabulary: Vocabulary = field(default_factory=Vocabulary)
    now: str = ""
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class FindingCandidate:
    """A rule's raw output; runner turns it into GovernanceFindingV1."""
    rule_id: str
    risk_type: str
    severity: str = Severity.MEDIUM.value
    confidence: float = 0.95
    reason_codes: list[str] = field(default_factory=list)
    field_name: str | None = None
    summary: str = ""
    quality_reference: str | None = None
    lineage_reference: str | None = None
    evidence: list[dict[str, Any]] = field(default_factory=list)


RuleFn = Callable[[RuleContext], list[FindingCandidate]]


@dataclass(frozen=True)
class RuleSpec:
    rule_id: str
    description: str
    dimension: str          # leakage | freshness | schema | quality | lineage | sensitive | domain
    default_severity: str
    fn: RuleFn
    enabled_by_default: bool = True


class RuleRegistry:
    """Registers rules by id; policies select which rules run with what params."""

    def __init__(self) -> None:
        self._rules: dict[str, RuleSpec] = {}

    def register(self, spec: RuleSpec) -> None:
        self._rules[spec.rule_id] = spec

    def get(self, rule_id: str) -> RuleSpec:
        return self._rules[rule_id]

    def list(self) -> list[str]:
        return sorted(self._rules)

    def run(self, rule_id: str, ctx: RuleContext) -> list[FindingCandidate]:
        return self._rules[rule_id].fn(ctx)


class PolicyRegistry:
    """Named policies: rule ids + parameters (e.g. staleness threshold)."""

    def __init__(self) -> None:
        self._policies: dict[str, dict[str, Any]] = {}

    def register(self, name: str, rule_ids: list[str], params: dict[str, Any] | None = None) -> None:
        self._policies[name] = {"rules": rule_ids, "params": params or {}}

    def get(self, name: str) -> dict[str, Any]:
        return self._policies[name]

    def all(self) -> dict[str, dict[str, Any]]:
        return dict(self._policies)


# ---------------------------------------------------------------------------
# Generic rules (domain-neutral)
# ---------------------------------------------------------------------------

def _iso_now(ctx: RuleContext) -> str:
    return ctx.now or datetime.now(timezone.utc).isoformat()


def rule_empty_dataset(ctx: RuleContext) -> list[FindingCandidate]:
    """A table that exists in the catalog but holds no rows is not healthy."""
    if ctx.profile.get("row_count", 1) != 0:
        return []
    return [FindingCandidate(
        rule_id="empty_dataset_check",
        risk_type="EMPTY_DATASET",
        severity=GENERIC_REASON_CODES["EMPTY_DATASET"]["severity"],
        reason_codes=["EMPTY_DATASET"],
        summary="schema exists but the dataset holds no rows",
        evidence=[{"source_type": "snapshot", "source_reference": f"snapshot:{ctx.snapshot_id or 'latest'}",
                   "source_snapshot": ctx.snapshot_id or "", "observed_value": "row_count=0",
                   "expected_value": "row_count>0", "confidence": 0.95,
                   "evaluator_version": "cdxr.rules.v1", "created_at": _iso_now(ctx)}],
    )]


def rule_freshness_check(ctx: RuleContext) -> list[FindingCandidate]:
    """Newest record older than staleness threshold → NO_FRESH_DATA."""
    max_ts = ctx.profile.get("max_timestamp")
    if not max_ts:
        return []
    staleness = int(ctx.params.get("staleness_seconds", DEFAULT_STALENESS_SECONDS))
    try:
        newest = datetime.fromisoformat(str(max_ts).replace("Z", "+00:00"))
        now = datetime.fromisoformat(_iso_now(ctx).replace("Z", "+00:00"))
    except ValueError:
        return []
    # normalize: date-only values are naive; treat them as UTC
    if newest.tzinfo is None:
        newest = newest.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    age = (now - newest).total_seconds()
    if age <= staleness:
        return []
    return [FindingCandidate(
        rule_id="freshness_check",
        risk_type="NO_FRESH_DATA",
        severity=GENERIC_REASON_CODES["NO_FRESH_DATA"]["severity"],
        reason_codes=["NO_FRESH_DATA"],
        summary=f"newest record is {age / 3600:.0f}h old (threshold {staleness / 3600:.0f}h)",
        evidence=[{"source_type": "snapshot", "source_reference": f"snapshot:{ctx.snapshot_id or 'latest'}",
                   "source_snapshot": ctx.snapshot_id or "", "observed_value": f"max_timestamp={max_ts}",
                   "expected_value": f"age<={staleness}s", "confidence": 0.95,
                   "evaluator_version": "cdxr.rules.v1", "created_at": _iso_now(ctx)}],
    )]


def rule_sensitive_field_check(ctx: RuleContext) -> list[FindingCandidate]:
    """Sensitive field names present in schema (or EAV labels) → SENSITIVE_FIELD."""
    vocab = ctx.vocabulary
    if not vocab.sensitive_fields:
        return []
    found: list[str] = []
    for fld in ctx.manifest.get("fields", []):
        name = str(fld.get("name", "")).lower()
        if any(s in name for s in vocab.sensitive_fields):
            found.append(name)
    # EAV label values (e.g. ocr_result.field_name rows)
    eav_labels = [str(v).lower() for v in ctx.profile.get("eav_label_values", [])]
    for label in eav_labels:
        if any(s in label for s in vocab.sensitive_fields) and label not in found:
            found.append(label)
    if not found:
        return []
    return [FindingCandidate(
        rule_id="sensitive_field_check",
        risk_type="SENSITIVE_FIELD",
        severity=GENERIC_REASON_CODES["SENSITIVE_FIELD"]["severity"],
        reason_codes=["SENSITIVE_FIELD"],
        field_name=", ".join(found),
        summary=f"sensitive fields present: {', '.join(sorted(found))}",
        evidence=[{"source_type": "profile", "source_reference": f"profile:{ctx.dataset_id}",
                   "source_snapshot": ctx.snapshot_id or "", "observed_value": f"fields={','.join(found)}",
                   "expected_value": "no sensitive fields", "confidence": 0.95,
                   "evaluator_version": "cdxr.rules.v1", "created_at": _iso_now(ctx)}],
    )]


def rule_domain_field_check(ctx: RuleContext) -> list[FindingCandidate]:
    """Domain-specific field names present → DOMAIN_FIELD (domain marker)."""
    vocab = ctx.vocabulary
    if not vocab.domain_fields:
        return []
    found = []
    for fld in ctx.manifest.get("fields", []):
        name = str(fld.get("name", "")).lower()
        if any(s in name for s in vocab.domain_fields):
            found.append(name)
    if not found:
        return []
    return [FindingCandidate(
        rule_id="domain_field_check",
        risk_type="DOMAIN_FIELD",
        severity=GENERIC_REASON_CODES["DOMAIN_FIELD"]["severity"],
        reason_codes=["DOMAIN_FIELD"],
        field_name=", ".join(found),
        summary=f"domain-specific fields present: {', '.join(sorted(found))}",
        evidence=[{"source_type": "profile", "source_reference": f"profile:{ctx.dataset_id}",
                   "source_snapshot": ctx.snapshot_id or "", "observed_value": f"fields={','.join(found)}",
                   "expected_value": "domain-neutral", "confidence": 0.95,
                   "evaluator_version": "cdxr.rules.v1", "created_at": _iso_now(ctx)}],
    )]


def rule_quality_reference_check(ctx: RuleContext) -> list[FindingCandidate]:
    """Reference (not duplicate) the existing quality result."""
    if ctx.quality_status in ("WARN", "FAIL"):
        return [FindingCandidate(
            rule_id="quality_reference_check",
            risk_type="QUALITY_REFERENCE",
            severity="HIGH" if ctx.quality_status == "FAIL" else "MEDIUM",
            reason_codes=["QUALITY_REFERENCE"],
            summary=f"existing quality status is {ctx.quality_status}",
            quality_reference=ctx.quality_reference or None,
            evidence=[{"source_type": "quality", "source_reference": ctx.quality_reference or "",
                       "source_snapshot": ctx.snapshot_id or "", "observed_value": f"quality={ctx.quality_status}",
                       "expected_value": "PASS", "confidence": 0.95,
                       "evaluator_version": "cdxr.rules.v1", "created_at": _iso_now(ctx)}],
        )]
    return []


def rule_lineage_reference_check(ctx: RuleContext) -> list[FindingCandidate]:
    """Missing lineage/upstream → informational finding."""
    if ctx.lineage_upstream:
        return []
    return [FindingCandidate(
        rule_id="lineage_reference_check",
        risk_type="NO_LINEAGE",
        severity=GENERIC_REASON_CODES["NO_LINEAGE"]["severity"],
        reason_codes=["NO_LINEAGE"],
        summary="no upstream lineage recorded for this dataset",
        lineage_reference=ctx.lineage_reference or None,
        evidence=[{"source_type": "lineage", "source_reference": ctx.lineage_reference or "",
                   "source_snapshot": ctx.snapshot_id or "", "observed_value": "upstream=[]",
                   "expected_value": "upstream non-empty", "confidence": 0.95,
                   "evaluator_version": "cdxr.rules.v1", "created_at": _iso_now(ctx)}],
    )]


def rule_schema_confidence_check(ctx: RuleContext) -> list[FindingCandidate]:
    """Fields whose schema confidence is below threshold → LOW_SCHEMA_CONFIDENCE."""
    threshold = float(ctx.params.get("schema_confidence_threshold", DEFAULT_SCHEMA_CONFIDENCE_THRESHOLD))
    low = [fld for fld in ctx.manifest.get("fields", [])
           if float(fld.get("confidence", 1.0)) < threshold]
    if not low:
        return []
    return [FindingCandidate(
        rule_id="schema_confidence_check",
        risk_type="LOW_SCHEMA_CONFIDENCE",
        severity=REASON_CODES["LOW_SCHEMA_CONFIDENCE"]["severity"],
        reason_codes=["LOW_SCHEMA_CONFIDENCE"],
        field_name=", ".join(fld.get("name", "") for fld in low),
        summary=f"{len(low)} field(s) with schema confidence < {threshold}",
        evidence=[{"source_type": "manifest", "source_reference": f"manifest:{ctx.manifest.get('table_id', ctx.dataset_id)}",
                   "source_snapshot": ctx.snapshot_id or "",
                   "observed_value": f"low_confidence_fields={len(low)}",
                   "expected_value": f"confidence>={threshold}", "confidence": 0.95,
                   "evaluator_version": "cdxr.rules.v1", "created_at": _iso_now(ctx)}],
    )]


def rule_leakage_check(ctx: RuleContext) -> list[FindingCandidate]:
    """Run the CDXR engine per feature (validity + detectability + decision)."""
    vocab = ctx.vocabulary
    findings = []
    for fld in ctx.manifest.get("fields", []):
        name = str(fld.get("name", ""))
        if not name:
            continue
        column_role = {
            "business_stage": fld.get("business_stage", "unknown"),
            "semantic_role": fld.get("semantic_role", "unknown"),
            "time_role": fld.get("time_role", "unknown"),
            "feature_eligibility": fld.get("feature_eligibility", "ALLOW"),
            "confidence": float(fld.get("confidence", 1.0)),
            "table_id": ctx.manifest.get("table_id", ctx.dataset_id),
        }
        validity = assess_validity(name, column_role, ctx.manifest)
        if validity["reason_codes"]:
            codes = validity["reason_codes"]
            severity = max((REASON_CODES[c]["severity"] for c in codes), key=_severity_order)
            findings.append(FindingCandidate(
                rule_id="leakage_check",
                risk_type="LEAKAGE",
                severity=severity,
                confidence=0.95,
                reason_codes=codes,
                field_name=name,
                summary=f"feature not available at prediction time: {', '.join(codes)}",
                evidence=[{"source_type": "profile", "source_reference": f"profile:{name}",
                           "source_snapshot": ctx.snapshot_id or "",
                           "observed_value": f"validity={validity['status']}",
                           "expected_value": "PASS", "confidence": 0.95,
                           "evaluator_version": "cdxr.engine.v1", "created_at": _iso_now(ctx)}],
            ))
            continue
        assess = evaluate_feature(name, column_role, ctx.manifest, profile=ctx.profile,
                                  risk_indicators=vocab.risk_indicators)
        if assess.decision in ("BLOCK", "NEEDS_REVIEW") and assess.detectability.get("score", 0) > 0:
            findings.append(FindingCandidate(
                rule_id="leakage_check",
                risk_type="LEAKAGE",
                severity="HIGH" if assess.decision == "BLOCK" else "MEDIUM",
                confidence=assess.confidence,
                reason_codes=assess.validity.get("reason_codes", []) + (["DETECTABILITY"] if assess.detectability.get("signals") else []),
                field_name=name,
                summary=f"leakage signals detected (detectability {assess.detectability.get('score')}, decision {assess.decision})",
                evidence=[{"source_type": "profile", "source_reference": f"profile:{name}",
                           "source_snapshot": ctx.snapshot_id or "",
                           "observed_value": f"signals={','.join(assess.detectability.get('signals', []))}",
                           "expected_value": "no signals", "confidence": assess.confidence,
                           "evaluator_version": "cdxr.engine.v1", "created_at": _iso_now(ctx)}],
            ))
    return findings


def rule_ocr_confidence_check(ctx: RuleContext) -> list[FindingCandidate]:
    """EAV-style parse tables with low parser confidence → OCR_LOW_CONFIDENCE."""
    if ctx.dataset_layer != "ods":
        return []
    conf_col = ctx.vocabulary.ocr_confidence_column
    low_conf = ctx.profile.get("min_parser_confidence")
    threshold = float(ctx.params.get("ocr_confidence_threshold", DEFAULT_OCR_CONFIDENCE_THRESHOLD))
    if low_conf is None or low_conf >= threshold:
        return []
    return [FindingCandidate(
        rule_id="ocr_confidence_check",
        risk_type="OCR_LOW_CONFIDENCE",
        severity=REASON_CODES["OCR_LOW_CONFIDENCE"]["severity"],
        reason_codes=["OCR_LOW_CONFIDENCE"],
        summary=f"lowest parser confidence {low_conf:.2f} < {threshold}",
        evidence=[{"source_type": "snapshot", "source_reference": f"snapshot:{ctx.snapshot_id or 'latest'}",
                   "source_snapshot": ctx.snapshot_id or "",
                   "observed_value": f"min_{conf_col}={low_conf}", "expected_value": f">={threshold}",
                   "confidence": 0.95, "evaluator_version": "cdxr.rules.v1", "created_at": _iso_now(ctx)}],
    )]


def _severity_order(s: str) -> int:
    return {"INFO": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}.get(s, 2)


def build_default_registry(extra_rules: list[RuleSpec] | None = None) -> RuleRegistry:
    """Registry with the generic rules (domain vocabulary injected per run)."""
    reg = RuleRegistry()
    for spec in [
        RuleSpec("empty_dataset_check", "dataset exists but holds no rows", "schema",
                 GENERIC_REASON_CODES["EMPTY_DATASET"]["severity"], rule_empty_dataset),
        RuleSpec("freshness_check", "newest record older than staleness threshold", "freshness",
                 GENERIC_REASON_CODES["NO_FRESH_DATA"]["severity"], rule_freshness_check),
        RuleSpec("sensitive_field_check", "sensitive field names present", "sensitive",
                 GENERIC_REASON_CODES["SENSITIVE_FIELD"]["severity"], rule_sensitive_field_check),
        RuleSpec("domain_field_check", "domain-specific field names present", "domain",
                 GENERIC_REASON_CODES["DOMAIN_FIELD"]["severity"], rule_domain_field_check),
        RuleSpec("quality_reference_check", "reference existing quality result", "quality",
                 "MEDIUM", rule_quality_reference_check),
        RuleSpec("lineage_reference_check", "reference existing lineage result", "lineage",
                 "LOW", rule_lineage_reference_check, enabled_by_default=False),
        RuleSpec("schema_confidence_check", "fields below schema confidence threshold", "schema",
                 REASON_CODES["LOW_SCHEMA_CONFIDENCE"]["severity"], rule_schema_confidence_check),
        RuleSpec("leakage_check", "CDXR engine validity + detectability per feature", "leakage",
                 "MEDIUM", rule_leakage_check),
        RuleSpec("ocr_confidence_check", "low parser confidence in ods parse tables", "schema",
                 REASON_CODES["OCR_LOW_CONFIDENCE"]["severity"], rule_ocr_confidence_check),
    ]:
        reg.register(spec)
    for spec in (extra_rules or []):
        reg.register(spec)
    return reg


def build_default_policies() -> PolicyRegistry:
    """standard policy = all default rules (lineage check optional)."""
    policies = PolicyRegistry()
    policies.register("standard", [
        "empty_dataset_check", "freshness_check", "sensitive_field_check",
        "domain_field_check", "quality_reference_check", "schema_confidence_check",
        "leakage_check", "ocr_confidence_check",
    ], params={"staleness_seconds": DEFAULT_STALENESS_SECONDS,
               "ocr_confidence_threshold": DEFAULT_OCR_CONFIDENCE_THRESHOLD,
               "schema_confidence_threshold": DEFAULT_SCHEMA_CONFIDENCE_THRESHOLD})
    policies.register("with_lineage", policies.get("standard")["rules"] + ["lineage_reference_check"],
                      params=dict(policies.get("standard")["params"]))
    return policies
