"""Risk-domain CDXR vocabulary and rules.

Everything here may use risk terms (loan, credit_score, overdue, bad_rate,
auc, ks, psi, ...). The generic kernel (services/lakehouse-gateway/app/
governance/cdxr/) must NOT.
"""
from domains.risk.governance.cdxr.vocabulary import RISK_VOCABULARY

__all__ = ["RISK_VOCABULARY"]
