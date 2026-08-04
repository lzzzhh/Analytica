"""CDXR — Cross-Data X-Ray: feature-leakage detection and repair governance.

MIGRATED from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/governance/cdxr/) and extended with rule registry, policy registry,
evidence entities, finding lifecycle, review actions, trust profiles and
governance score. The kernel is deterministic and calls no LLM; domain
vocabulary is injected by domains/risk.
"""
from app.governance.cdxr.engine import (
    REASON_CODES,
    assess_detectability,
    assess_validity,
    evaluate_feature,
)
from app.governance.cdxr.rules import (
    RuleContext,
    RuleRegistry,
    RuleSpec,
    Vocabulary,
    build_default_policies,
    build_default_registry,
)
from app.governance.cdxr.runner import GovernanceRunResult, run_governance

__all__ = [
    "REASON_CODES", "assess_detectability", "assess_validity", "evaluate_feature",
    "RuleContext", "RuleRegistry", "RuleSpec", "Vocabulary",
    "build_default_policies", "build_default_registry",
    "GovernanceRunResult", "run_governance",
]
