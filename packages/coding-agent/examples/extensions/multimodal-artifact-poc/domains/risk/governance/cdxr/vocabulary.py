"""Risk-domain vocabulary injected into the generic CDXR kernel.

The original engine hardcoded a risk_indicator list (default/delinquent/
overdue/bad) inside assess_detectability — extracted here verbatim so the
kernel stays domain-neutral and this file is the single place risk terms live.
"""
from app.governance.cdxr.rules import Vocabulary

# Verbatim from riskcloud/governance/cdxr/engine.py (risk_indicator branch).
RISK_INDICATORS = ("default", "delinquent", "overdue", "bad")

# Sensitive fields observed in the demo warehouse (EAV labels / column names).
SENSITIVE_FIELDS = ("id_number", "account_number", "card_number", "phone", "email")

# Fields that mark a dataset as belonging to the risk domain. AUTHORITATIVE
# vocabulary for the registry's domain labeling (app/catalog/dataset_registry
# loads this when the domain package is available); field names are preserved
# verbatim from the source data.
DOMAIN_FIELDS = (
    "loan", "borrower", "credit_score", "overdue", "bad_rate",
    "vintage", "auc", "ks", "psi", "applicant", "prediction",
)

RISK_VOCABULARY = Vocabulary(
    sensitive_fields=SENSITIVE_FIELDS,
    domain_fields=DOMAIN_FIELDS,
    risk_indicators=RISK_INDICATORS,
    eav_label_column="field_name",
    eav_value_column="field_value",
    ocr_confidence_column="confidence",
)
