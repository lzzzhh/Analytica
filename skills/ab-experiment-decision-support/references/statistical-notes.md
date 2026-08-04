# Statistical Notes — supported methods and limitations

## Supported (deterministic script)
- Binary sample size: two-sample proportion, normal approximation, equal allocation
- Continuous sample size: two-sample z, equal variance
- Duration: required_sample / (daily_eligible × allocation) + maturity
- SRM: chi-square goodness of fit (df=1), default alpha 0.001
- Binary analysis: rates, absolute/relative effect, Wald CI, normal z-test
- Continuous analysis: mean difference, Welch SE, normal CI, z-test

## Not supported in V1 (→ SPECIALIST_REVIEW_REQUIRED)
- Cluster / geo / switchback / network & marketplace interference
- Multi-arm adaptive allocation, un-pre-specified sequential testing
- Bayesian decision rules, survival/time-to-event, delta-method ratio metrics
- Exact methods for tiny samples / rare events, repeated measures

## Principles
- All arithmetic is script-only; never recompute by hand in prose
- `p < alpha` alone is not a ship recommendation; compare the whole CI to the
  practical threshold
- Non-significance is not proof of no effect
- Every advisory carries dataSource = USER_PROVIDED|UPLOADED_FILE|CONTROLLED_ARTIFACT
  and dataVerified = false
