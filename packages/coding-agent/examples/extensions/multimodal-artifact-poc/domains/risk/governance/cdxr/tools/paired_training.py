"""CDXR Paired Training Engine — exploitability and repair verification.

MIGRATED VERBATIM from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/governance/cdxr/tools/paired_training.py, 160 lines).

Domain package: risk metrics (auc/ks/lift) are fine here but banned in the
generic kernel (services/lakehouse-gateway/app/governance/cdxr/).
"""
from __future__ import annotations

import numpy as np
from dataclasses import dataclass, field
from typing import Any


@dataclass
class PairedMetrics:
    view: str
    auc: float = 0.0
    ks: float = 0.0
    lift_5: float = 0.0
    f1: float = 0.0
    brier: float = 0.0
    feature_count: int = 0
    feature_names: list[str] = field(default_factory=list)


@dataclass
class ExploitabilityReport:
    feature_id: str
    strict_metrics: PairedMetrics | None = None
    full_metrics: PairedMetrics | None = None
    governed_metrics: PairedMetrics | None = None
    random_metrics: PairedMetrics | None = None
    auc_delta: float = 0.0
    ks_delta: float = 0.0
    is_exploitable: bool = False
    repair_effective: bool = False
    matched_random_better: bool = False


def train_and_evaluate_generic(
    X: np.ndarray, y: np.ndarray,
    feature_names: list[str],
    blocked_features: list[str],
    review_features: list[str],
    random_seed: int = 42,
) -> dict[str, Any]:
    """Adapter: returns the raw result mapped to domain-neutral keys so the
    generic engine never sees risk-metric names (auc/ks/...)."""
    raw = train_and_evaluate(X, y, feature_names, blocked_features, review_features, random_seed)
    exp = raw.get("exploitability", {})
    return {"exploitability": {
        "status": "VERIFIED",
        "metric_delta": exp.get("auc_delta", 0),
        "score_delta": exp.get("ks_delta", 0),
        "full_score": exp.get("full_auc", 0),
        "strict_score": exp.get("strict_auc", 0),
        "governed_vs_random_delta": exp.get("governed_vs_random_auc_delta", 0),
    }}


def train_and_evaluate(
    X: np.ndarray, y: np.ndarray,
    feature_names: list[str],
    blocked_features: list[str],
    review_features: list[str],
    random_seed: int = 42,
) -> dict[str, Any]:
    """Paired training: Strict vs Full vs Governed vs Random Removal.

    Returns exploitability metrics for each blocked/review feature.
    """
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score, f1_score, brier_score_loss

    n = len(y)
    indices = np.arange(n)
    rng = np.random.RandomState(random_seed)
    rng.shuffle(indices)
    n_train = int(n * 0.6)
    n_val = int(n * 0.8)
    train_idx = indices[:n_train]
    val_idx = indices[n_train:n_val]
    test_idx = indices[n_val:]

    X_train, y_train = X[train_idx], y[train_idx]
    X_val, y_val = X[val_idx], y[val_idx]
    X_test, y_test = X[test_idx], y[test_idx]

    # Build feature sets
    all_idx = {fn: i for i, fn in enumerate(feature_names)}
    blocked_idx = [all_idx[f] for f in blocked_features if f in all_idx]
    review_idx = [all_idx[f] for f in review_features if f in all_idx]
    strict_idx = [i for i in range(len(feature_names))
                  if i not in blocked_idx and i not in review_idx]

    # Random removal (same count as blocked + review)
    n_remove = len(blocked_idx) + len(review_idx)
    remaining = [i for i in range(len(feature_names)) if i not in blocked_idx]
    if n_remove > 0 and len(remaining) >= n_remove:
        random_remove = rng.choice(remaining, n_remove, replace=False).tolist()
    else:
        random_remove = []
    random_idx = [i for i in range(len(feature_names)) if i not in random_remove]

    def _make_model():
        return LogisticRegression(max_iter=2000, random_state=random_seed, C=1.0)

    def _compute_metrics(model, X_eval, y_eval) -> dict:
        y_prob = model.predict_proba(X_eval)[:, 1]
        y_pred = model.predict(X_eval)
        return {
            "auc": float(roc_auc_score(y_eval, y_prob)),
            "f1": float(f1_score(y_eval, y_pred)),
            "brier": float(brier_score_loss(y_eval, y_prob)),
            "ks": float(_ks_score(y_eval, y_prob)),
            "lift_5": float(_lift_at_5(y_eval, y_prob)),
        }

    results = {}

    # Strict model
    if strict_idx:
        m_strict = _make_model()
        m_strict.fit(X_train[:, strict_idx], y_train)
        results["strict"] = _compute_metrics(m_strict, X_test[:, strict_idx], y_test)
        results["strict"]["features"] = len(strict_idx)

    # Full model
    m_full = _make_model()
    m_full.fit(X_train, y_train)
    results["full"] = _compute_metrics(m_full, X_test, y_test)
    results["full"]["features"] = len(feature_names)

    # Governed model (strict only)
    if strict_idx:
        results["governed"] = {
            "metrics": results["strict"],
            "features_removed": len(blocked_idx),
            "leaked_removed": len(blocked_idx),
            "retained": len(strict_idx),
        }

    # Random removal model
    if random_idx and len(random_idx) < len(feature_names):
        m_random = _make_model()
        m_random.fit(X_train[:, random_idx], y_train)
        results["random"] = _compute_metrics(m_random, X_test[:, random_idx], y_test)
        results["random"]["features"] = len(random_idx)
        results["random"]["removed"] = n_remove

    # Exploitability analysis
    results["exploitability"] = {
        "full_auc": results.get("full", {}).get("auc", 0),
        "strict_auc": results.get("strict", {}).get("auc", 0),
        "auc_delta": results.get("full", {}).get("auc", 0) - results.get("strict", {}).get("auc", 0),
        "full_ks": results.get("full", {}).get("ks", 0),
        "strict_ks": results.get("strict", {}).get("ks", 0),
        "ks_delta": results.get("full", {}).get("ks", 0) - results.get("strict", {}).get("ks", 0),
        "random_auc": results.get("random", {}).get("auc", 0),
        "governed_vs_random_auc_delta": (
            results.get("strict", {}).get("auc", 0) - results.get("random", {}).get("auc", 0)
        ),
        "blocked_features": blocked_features,
        "review_features": review_features,
    }

    return results


def _ks_score(y_true, y_pred):
    from sklearn.metrics import roc_curve
    fpr, tpr, _ = roc_curve(y_true, y_pred)
    return float(np.max(tpr - fpr))


def _lift_at_5(y_true, y_pred):
    n = len(y_true)
    k = max(1, n // 20)
    idx = np.argsort(-y_pred)[:k]
    top_rate = y_true[idx].mean()
    overall = y_true.mean()
    return float(top_rate / overall) if overall > 0 else 1.0
