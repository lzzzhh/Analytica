#!/usr/bin/env python3
"""ab_experiment_calculator.py — deterministic A/B experiment calculator.

Pure stdlib (math/statistics) — no external dependencies, no LLM, no data
invention. All arithmetic the skill ever performs lives here; the model never
recomputes sample sizes, SRM, confidence intervals or p-values by hand.

Subcommands (mirror the SKILL.md usage):

  sample-size-binary      p1 p2 alpha power [--two-sided]
  sample-size-continuous  sigma delta alpha power [--two-sided]
  duration                required_sample daily_eligible allocation_fraction [--maturity-days N]
  srm                     expected_a expected_b observed_a observed_b [--alpha 0.001]
  analyze-binary          n_a k_a n_b k_b [--alpha 0.05] [--practical-threshold X]
  analyze-continuous      n_a mean_a sd_a n_b mean_b sd_b [--alpha 0.05]

Exit code 0 on success; prints one JSON object with results + method notes.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

Z_TWO_SIDED: dict[float, float] = {0.1: 1.6449, 0.05: 1.9600, 0.01: 2.5758, 0.001: 3.2905}
Z_ONE_SIDED: dict[float, float] = {0.1: 1.2816, 0.05: 1.6449, 0.01: 2.3263, 0.001: 3.0902}
Z_POWER: dict[float, float] = {0.8: 0.8416, 0.9: 1.2816, 0.95: 1.6449, 0.99: 2.3263}


def _z(alpha: float, two_sided: bool) -> float:
    table = Z_TWO_SIDED if two_sided else Z_ONE_SIDED
    # pick the nearest table entry; error if wildly out of range
    best = min(table.items(), key=lambda kv: abs(kv[0] - alpha))
    if abs(best[0] - alpha) > 0.02:
        raise ValueError(f"alpha {alpha} unsupported by the embedded z-table "
                         f"(closest {best[0]}); use a standard table value")
    return best[1]


def _z_power(power: float) -> float:
    best = min(Z_POWER.items(), key=lambda kv: abs(kv[0] - power))
    if abs(best[0] - power) > 0.05:
        raise ValueError(f"power {power} unsupported; use 0.8/0.9/0.95/0.99")
    return best[1]


def _normal_pvalue(z: float, two_sided: bool) -> float:
    """Two/one-tailed p-value from a z-score (Abramowitz-Stegun approx)."""
    sign = -1.0 if z < 0 else 1.0
    x = abs(z)
    t = 1.0 / (1.0 + 0.2316419 * x)
    d = 0.3989422804014327 * math.exp(-x * x / 2.0)
    p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
        t * (-1.821255978 + t * 1.330274429))))
    tail = p if sign > 0 else 1.0 - p
    if tail < 0:
        tail = 0.0
    if tail > 1:
        tail = 1.0
    return tail if two_sided else (1.0 - abs(tail - 0.5) * 2.0 if False else tail)


def _out(data: dict[str, Any]) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def _require_positive(*values: float, names: list[str]) -> None:
    for v, n in zip(values, names):
        if v <= 0:
            raise ValueError(f"{n} must be positive, got {v}")


# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------

def cmd_sample_size_binary(args: argparse.Namespace) -> None:
    """Two-sample proportion sample size (normal approximation)."""
    p1, p2 = args.p1, args.p2
    if not 0 < p1 < 1 or not 0 < p2 < 1:
        raise ValueError("p1/p2 must be in (0,1)")
    delta = abs(p2 - p1)
    if delta == 0:
        raise ValueError("p1 == p2 — no effect to detect")
    pbar = (p1 + p2) / 2.0
    z_alpha = _z(args.alpha, args.two_sided)
    z_power = _z_power(args.power)
    n = ((z_alpha * math.sqrt(2 * pbar * (1 - pbar)) +
          z_power * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) / (delta ** 2)
    n_per_group = math.ceil(n)
    _out({
        "command": "sample-size-binary",
        "p1": p1, "p2": p2, "absoluteEffect": delta,
        "relativeEffect": delta / p1 if p1 else None,
        "alpha": args.alpha, "power": args.power, "twoSided": args.two_sided,
        "sampleSizePerGroup": n_per_group,
        "totalSampleSize": n_per_group * 2,
        "method": "normal approximation (two-sample proportion), equal allocation",
        "note": "decision support, not a guarantee of achieved power",
    })


def cmd_sample_size_continuous(args: argparse.Namespace) -> None:
    """Two-sample continuous outcome sample size (equal variance)."""
    sigma, delta = args.sigma, args.delta
    _require_positive(sigma, delta, names=["sigma", "delta"])
    z_alpha = _z(args.alpha, args.two_sided)
    z_power = _z_power(args.power)
    n = 2 * (sigma ** 2) * ((z_alpha + z_power) ** 2) / (delta ** 2)
    n_per_group = math.ceil(n)
    _out({
        "command": "sample-size-continuous",
        "sigma": sigma, "delta": delta,
        "alpha": args.alpha, "power": args.power, "twoSided": args.two_sided,
        "sampleSizePerGroup": n_per_group,
        "totalSampleSize": n_per_group * 2,
        "method": "two-sample z (equal variance), equal allocation",
    })


def cmd_duration(args: argparse.Namespace) -> None:
    """Calendar days needed to reach the required sample."""
    required, daily, fraction = args.required_sample, args.daily_eligible, args.allocation_fraction
    _require_positive(required, daily, fraction, names=["required_sample", "daily_eligible", "allocation_fraction"])
    if fraction > 1.0:
        raise ValueError("allocation_fraction must be <= 1.0")
    per_day = daily * fraction
    days = math.ceil(required / per_day) if per_day > 0 else math.inf
    _out({
        "command": "duration",
        "requiredSample": required,
        "dailyEligible": daily,
        "allocationFraction": fraction,
        "perDayAssigned": per_day,
        "daysWithoutMaturity": None if math.isinf(days) else days,
        "maturityDays": args.maturity_days,
        "totalDays": None if math.isinf(days) else days + args.maturity_days,
        "method": "required_sample / (daily_eligible * allocation_fraction) + maturity",
    })


def cmd_srm(args: argparse.Namespace) -> None:
    """Sample Ratio Mismatch — chi-square goodness of fit against the
    planned allocation ratio."""
    exp_a, exp_b = args.expected_a, args.expected_b
    obs_a, obs_b = args.observed_a, args.observed_b
    for v, n in ((exp_a, "expected_a"), (exp_b, "expected_b"),
                 (obs_a, "observed_a"), (obs_b, "observed_b")):
        if v < 0:
            raise ValueError(f"{n} must be >= 0")
    total_obs = obs_a + obs_b
    total_exp = exp_a + exp_b
    if total_obs == 0 or total_exp == 0:
        raise ValueError("observed/expected totals must be non-zero")
    # scale expected to observed total
    e_a = exp_a / total_exp * total_obs
    e_b = exp_b / total_exp * total_obs
    chi2 = ((obs_a - e_a) ** 2 / e_a) + ((obs_b - e_b) ** 2 / e_b)
    # chi-square df=1 p-value via normal approx: p = P(Z > sqrt(chi2)) (two-sided tail)
    z = math.sqrt(chi2)
    p = 2.0 * (1.0 - _norm_cdf(z))
    p = min(1.0, max(0.0, p))
    srm_flag = p < args.alpha
    _out({
        "command": "srm",
        "expectedA": exp_a, "expectedB": exp_b,
        "observedA": obs_a, "observedB": obs_b,
        "observedRatioA": obs_a / total_obs, "observedRatioB": obs_b / total_obs,
        "expectedRatioA": exp_a / total_exp, "expectedRatioB": exp_b / total_exp,
        "chi2": chi2, "df": 1, "pValue": p,
        "alpha": args.alpha, "srmSuspected": srm_flag,
        "method": "chi-square goodness of fit (df=1), alpha from --alpha",
    })


def _norm_cdf(x: float) -> float:
    """Standard normal CDF (Abramowitz-Stegun 7.1.26)."""
    t = 1.0 / (1.0 + 0.2316419 * abs(x))
    d = 0.3989422804014327 * math.exp(-x * x / 2.0)
    p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
        t * (-1.821255978 + t * 1.330274429))))
    return 1.0 - p if x > 0 else p


def cmd_analyze_binary(args: argparse.Namespace) -> None:
    """Binary outcome analysis: rates, difference, Wald CI, z-test p-value."""
    n_a, k_a, n_b, k_b = args.n_a, args.k_a, args.n_b, args.k_b
    for v, n in ((n_a, "n_a"), (n_b, "n_b")):
        if v <= 0:
            raise ValueError(f"{n} must be positive")
    for v, n in ((k_a, "k_a"), (k_b, "k_b")):
        if not 0 <= v <= {"k_a": n_a, "k_b": n_b}[n]:
            raise ValueError(f"{n} must be in [0, {n[0:1] + '_' + n[2:] if False else n}]")
    pa, pb = k_a / n_a, k_b / n_b
    diff = pb - pa
    se = math.sqrt(pa * (1 - pa) / n_a + pb * (1 - pb) / n_b)
    z = diff / se if se > 0 else 0.0
    zc = _z(args.alpha, two_sided=True)
    ci = (diff - zc * se, diff + zc * se)
    p_value = _normal_pvalue(z, two_sided=True)
    _out({
        "command": "analyze-binary",
        "control": {"n": n_a, "k": k_a, "rate": pa},
        "treatment": {"n": n_b, "k": k_b, "rate": pb},
        "absoluteEffect": diff,
        "relativeEffect": diff / pa if pa > 0 else None,
        "ci95": list(ci),
        "pValue": p_value,
        "alpha": args.alpha,
        "practicalThreshold": args.practical_threshold,
        "evidence": _classify_evidence(ci, args.practical_threshold, p_value, args.alpha),
        "method": "Wald normal approximation (two-sided)",
    })


def cmd_analyze_continuous(args: argparse.Namespace) -> None:
    """Continuous outcome analysis: mean difference, Welch SE, CI, p-value."""
    n_a, m_a, sd_a, n_b, m_b, sd_b = (args.n_a, args.mean_a, args.sd_a,
                                      args.n_b, args.mean_b, args.sd_b)
    for v, n in ((n_a, "n_a"), (n_b, "n_b")):
        if v <= 1:
            raise ValueError(f"{n} must be > 1")
    diff = m_b - m_a
    se = math.sqrt(sd_a ** 2 / n_a + sd_b ** 2 / n_b)
    z = diff / se if se > 0 else 0.0
    zc = _z(args.alpha, two_sided=True)
    ci = (diff - zc * se, diff + zc * se)
    p_value = _normal_pvalue(z, two_sided=True)
    _out({
        "command": "analyze-continuous",
        "control": {"n": n_a, "mean": m_a, "sd": sd_a},
        "treatment": {"n": n_b, "mean": m_b, "sd": sd_b},
        "absoluteEffect": diff,
        "ci95": list(ci),
        "pValue": p_value,
        "alpha": args.alpha,
        "method": "normal approximation (Welch SE), two-sided",
    })


def _classify_evidence(ci: tuple[float, float], threshold: float | None,
                       p_value: float, alpha: float) -> str:
    if threshold is None:
        if p_value < alpha:
            return "SIGNIFICANT" if ci[0] > 0 or ci[1] < 0 else "SIGNIFICANT_EDGE"
        return "NOT_SIGNIFICANT"
    if ci[0] > threshold:
        return "CLEAR_POSITIVE"
    if ci[1] < -threshold:
        return "CLEAR_NEGATIVE"
    if abs(ci[0]) <= threshold and abs(ci[1]) <= threshold:
        return "PRACTICALLY_NEGLIGIBLE"
    if p_value < alpha:
        return "POSITIVE_BUT_BELOW_THRESHOLD" if ci[0] > 0 else "NEGATIVE_BUT_BELOW_THRESHOLD"
    return "INCONCLUSIVE"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ab_experiment_calculator",
                                description="deterministic A/B experiment calculations")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("sample-size-binary", help="binary-metric sample size")
    sp.add_argument("p1", type=float)
    sp.add_argument("p2", type=float)
    sp.add_argument("--alpha", type=float, default=0.05)
    sp.add_argument("--power", type=float, default=0.8)
    sp.add_argument("--two-sided", action="store_true")
    sp.set_defaults(fn=cmd_sample_size_binary)

    sp = sub.add_parser("sample-size-continuous", help="continuous-metric sample size")
    sp.add_argument("sigma", type=float)
    sp.add_argument("delta", type=float)
    sp.add_argument("--alpha", type=float, default=0.05)
    sp.add_argument("--power", type=float, default=0.8)
    sp.add_argument("--two-sided", action="store_true")
    sp.set_defaults(fn=cmd_sample_size_continuous)

    sp = sub.add_parser("duration", help="calendar days to reach required sample")
    sp.add_argument("required_sample", type=float)
    sp.add_argument("daily_eligible", type=float)
    sp.add_argument("allocation_fraction", type=float)
    sp.add_argument("--maturity-days", type=int, default=0)
    sp.set_defaults(fn=cmd_duration)

    sp = sub.add_parser("srm", help="sample ratio mismatch (chi-square)")
    sp.add_argument("expected_a", type=float)
    sp.add_argument("expected_b", type=float)
    sp.add_argument("observed_a", type=float)
    sp.add_argument("observed_b", type=float)
    sp.add_argument("--alpha", type=float, default=0.001)
    sp.set_defaults(fn=cmd_srm)

    sp = sub.add_parser("analyze-binary", help="binary outcome analysis")
    sp.add_argument("n_a", type=int)
    sp.add_argument("k_a", type=int)
    sp.add_argument("n_b", type=int)
    sp.add_argument("k_b", type=int)
    sp.add_argument("--alpha", type=float, default=0.05)
    sp.add_argument("--practical-threshold", type=float, default=None)
    sp.set_defaults(fn=cmd_analyze_binary)

    sp = sub.add_parser("analyze-continuous", help="continuous outcome analysis")
    sp.add_argument("n_a", type=int)
    sp.add_argument("mean_a", type=float)
    sp.add_argument("sd_a", type=float)
    sp.add_argument("n_b", type=int)
    sp.add_argument("mean_b", type=float)
    sp.add_argument("sd_b", type=float)
    sp.add_argument("--alpha", type=float, default=0.05)
    sp.set_defaults(fn=cmd_analyze_continuous)

    args = p.parse_args(argv)
    try:
        args.fn(args)
        return 0
    except (ValueError, ZeroDivisionError) as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
