# Input Templates

## Pre-experiment
- Objective / decision to make / population / control / treatment
- Hypothesis: If <intervention> for <population> then <metric> changes ≥ <MDE> because <mechanism>
- Unit: randomization unit, analysis unit, stable id, eligibility
- Primary metric: role, numerator/denominator, window, maturity, direction, baseline
- Binary: baseline rate, MDE (abs/rel), alpha, power, one/two-sided, allocation
- Continuous: mean, sd, absolute MDE, alpha, power, allocation
- Duration: daily eligible, allocation fraction, business cycle, maturity days
- Guardrails, pre-registered segments, stopping rule

## In-experiment
- Planned allocation ratio; assignment counts by variant; exposure counts;
- start time; elapsed days; required sample; mature sample; maturity window;
- daily eligible; guardrail status; logging incidents; config changes

## Post-experiment
- Binary: n_a k_a n_b k_b per variant
- Continuous: n mean sd per variant
- Report export: allocation, exposure, SRM, estimates, CI, p, duration, guardrails, change history
