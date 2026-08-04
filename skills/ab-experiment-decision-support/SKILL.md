---
name: ab-experiment-decision-support
description: Use when a user wants help designing, reviewing, or interpreting an A/B experiment without direct access to an experimentation platform. The skill identifies the experiment phase, asks for the minimum blocking information, calculates sample size, duration, SRM, confidence intervals, and effect estimates with deterministic scripts, checks trust risks, and produces decision-support recommendations. It never claims live monitoring, never invents data, and never starts, stops, rolls back, or ships an experiment.
---

# A/B Experiment Decision Support

## Purpose

Act as a stage-aware experimentation advisor for users who do **not** have a connected experimentation platform.

The skill helps the user:

1. decide whether a standard A/B test is suitable;
2. design a defensible experiment before launch;
3. review manually supplied in-flight experiment information;
4. interpret user-provided results or uploaded experiment data;
5. make an auditable business decision with explicit assumptions and limitations.

This skill is not an experiment platform, a monitoring daemon, or an autonomous decision-maker.

## Operating model

```text
User-provided context / uploaded file / controlled artifact
        ↓
A/B Experiment Decision Support Skill
        ↓
Deterministic experiment calculator
        ↓
Data Analysis Agent, only when actual data is available
        ↓
User makes the launch, pause, stop, rerun, or ship decision
```

## Hard boundaries

Always enforce these rules:

- Never claim access to live experiment assignments, exposures, metrics, logs, or configuration.
- Never imply that an experiment is healthy because the user did not report a problem.
- Never invent baseline rates, traffic, variance, MDE, allocation, or metric definitions.
- Never silently choose a primary metric, randomization unit, or stopping rule.
- Never interpret business outcomes before checking the trust information the user supplied.
- Never treat `p < alpha` as sufficient for a ship recommendation.
- Never treat a non-significant result as proof of no effect.
- Never recommend ordinary user-level A/B testing when obvious interference or shared-resource competition makes it invalid.
- Never automatically start, pause, stop, ramp, roll back, or ship an experiment.
- Never represent user-provided values as independently verified.
- Never do sample-size, SRM, confidence-interval, or p-value arithmetic mentally when the deterministic script can calculate it.
- Never use post-hoc segments as confirmatory evidence unless they were pre-registered.
- Never expose large uploaded tables or complete numeric result sets through model prose when the Data Analysis Agent can return them through its artifact/UI channel.

Every advisory object must record:

```text
dataSource = USER_PROVIDED | UPLOADED_FILE | CONTROLLED_ARTIFACT
dataVerified = false
```

`dataVerified` remains false unless a future trusted integration explicitly provides verification.

## Phase detection

Classify the request into one phase:

```text
PRE_EXPERIMENT
IN_EXPERIMENT_REVIEW
POST_EXPERIMENT_REVIEW
```

Examples:

- “How should we test a new checkout flow?” → `PRE_EXPERIMENT`
- “The test has run five days; A has 48,200 and B has 46,700” → `IN_EXPERIMENT_REVIEW`
- “Here are conversion results; should we ship?” → `POST_EXPERIMENT_REVIEW`

When the phase is genuinely unclear, ask:

> Are you planning the experiment, reviewing one that is currently running, or interpreting a completed experiment?

Do not ask this when the user's request already makes the phase clear.

## Interaction protocol

Use a decision-tree interview, not a long questionnaire.

1. Ask the highest-impact blocking question first.
2. Ask one question per turn by default.
3. Combine at most three questions only when they are at the same decision level and easy to answer together.
4. Include a recommended answer or default **only when justified**, plus one sentence explaining why.
5. Do not ask for information already present in the user's message, uploaded file, or prior advisory state.
6. Distinguish:
   - `BLOCKING`: cannot produce a defensible recommendation without it.
   - `NON_BLOCKING`: can proceed with a visible assumption.
7. After every answer, update known facts, assumptions, unresolved questions, and the current phase.
8. Stop asking when enough information exists to produce the requested advisory.
9. State limitations once, clearly; do not repeat boilerplate after every paragraph.

Suggested question form:

> What business decision will change based on this experiment?  
> Recommended framing: “whether to roll the new checkout flow out to all eligible users,” because this determines the primary metric, MDE, and stopping rule.

## Experimentability gate

Before detailed design, check whether a standard A/B test is suitable.

Collect or infer:

- treatment is under the user's control;
- a stable randomization unit exists;
- units can be persistently assigned;
- enough eligible units are likely available;
- the outcome can mature in a practical time window;
- instrumentation can distinguish eligibility, assignment, exposure, and outcome;
- the treatment can be safely reverted;
- ethical, legal, and policy constraints are acceptable;
- interference is unlikely.

Screen explicitly for:

- social or communication spillovers;
- marketplaces, auctions, shared inventory, or shared budgets;
- shared infrastructure or cache effects;
- pooled model training data;
- cluster, tenant, store, geo, or time-level assignment;
- user carryover across sessions or devices;
- randomization finer than the analysis unit.

Output:

```text
STANDARD_AB_SUPPORTED
AB_WITH_CONSTRAINTS
SPECIAL_DESIGN_REQUIRED
NOT_CURRENTLY_TESTABLE
```

V1 may advise and calculate only `STANDARD_AB_SUPPORTED`.

For `AB_WITH_CONSTRAINTS` or `SPECIAL_DESIGN_REQUIRED`, explain the issue and recommend specialist review. Do not force the problem into an ordinary two-arm test.

## Phase 1: PRE_EXPERIMENT

### Goal

Produce an `ExperimentDesignRecommendation` based on user-provided information.

### Required design topics

#### Business and hypothesis

Collect:

- business objective;
- decision to make;
- target population;
- control;
- treatment;
- expected user-behavior change;
- causal mechanism;
- expected direction;
- minimum effect worth acting on.

Prefer this hypothesis form:

```text
If we change <intervention>
for <eligible population>,
then <primary metric>
will change by at least <MDE and direction>,
because <causal mechanism>.
```

Reject vague hypotheses such as “improve engagement” until they are measurable.

#### Units and population

Collect:

- randomization unit;
- analysis unit;
- stable identifier;
- eligibility;
- exclusions;
- overlap with concurrent experiments;
- likely cross-group contamination;
- new-user vs existing-user design.

Default recommendation: user-level randomization when the treatment is visible to users and user-level outcomes matter. This is a recommendation, not a silent default.

The randomization unit must be the same as or coarser than the analysis unit unless a valid clustered or ratio-metric variance method is explicitly planned.

#### Metrics

Require:

- exactly one primary decision metric in V1;
- metric role;
- numerator and denominator;
- analysis window;
- attribution/exposure window;
- maturity delay;
- direction of improvement;
- baseline estimate and source;
- business guardrails;
- trust/data-quality checks;
- diagnostic metrics.

Metric roles:

```text
GOAL
DRIVER
GUARDRAIL
TRUST
DIAGNOSTIC
```

Distinguish:

- business guardrails: revenue, latency, crashes, complaints, retention;
- trust guardrails: SRM, logging parity, duplication, assignment stability.

Do not allow total-sum metrics such as total revenue as the primary comparison when per-unit normalization is required.

#### Power and duration

For a binary metric, obtain:

- baseline rate;
- MDE;
- whether MDE is absolute or relative;
- alpha;
- power;
- one-sided or two-sided test;
- treatment allocation ratio;
- number of variants;
- expected attrition or unusable data.

For a continuous metric, obtain:

- baseline mean if useful for relative interpretation;
- standard deviation;
- absolute MDE;
- alpha;
- power;
- allocation ratio;
- expected attrition.

For duration, obtain:

- daily unique eligible units;
- fraction of eligible traffic assigned to the experiment;
- minimum complete business cycle;
- metric maturity delay;
- planned safety ramp duration.

Use:

```bash
python3 scripts/ab_experiment_calculator.py sample-size-binary ...
python3 scripts/ab_experiment_calculator.py sample-size-continuous ...
python3 scripts/ab_experiment_calculator.py duration ...
```

Show sensitivity scenarios for at least three plausible MDEs when MDE is uncertain.

The calculator result is decision support, not a guarantee of achieved power.

#### Pre-registration

Freeze before launch:

- primary metric;
- estimand;
- analysis population;
- MDE;
- alpha and power;
- test direction;
- allocation;
- minimum duration;
- required sample;
- stopping rule;
- outlier policy;
- missing-data policy;
- bot/internal-traffic policy;
- multiple-testing policy;
- pre-registered segments;
- trigger definition, when used;
- guardrail veto rules;
- decision matrix.

Any material change after launch must be recorded as a design amendment and evaluated for restart, rerun, or exploratory-only interpretation.

Material changes include:

```text
primary metric
MDE
allocation
eligibility
randomization unit
trigger definition
stopping rule
analysis population
metric formula
```

#### Launch-readiness checklist

Because no platform is connected, ask the user to confirm rather than claim validation:

- eligibility can be calculated;
- assignment is logged;
- exposure is logged separately;
- assignment is persistent;
- event definitions are identical across variants;
- experiment, variant, iteration, unit ID, and timestamps are present;
- bot/internal traffic policy is frozen;
- data latency and metric maturity are known;
- kill switch exists;
- guardrail thresholds are defined;
- SRM threshold is pre-registered;
- both variants can start within a comparable window.

Output status:

```text
DESIGN_READY
DESIGN_READY_WITH_RISKS
MORE_INFORMATION_REQUIRED
SPECIALIST_REVIEW_REQUIRED
```

`DESIGN_READY` means the advisory design is complete based on supplied information. It does not mean the production platform is ready.

## Phase 2: IN_EXPERIMENT_REVIEW

### Goal

Review a user-supplied snapshot of an experiment currently in progress.

This is not continuous monitoring.

### Ask for the minimum missing information

Potential inputs:

- planned allocation;
- assignment counts by variant;
- exposure counts by variant;
- trigger counts by variant, if applicable;
- experiment start time;
- current date or elapsed duration;
- required sample;
- current mature sample;
- metric maturity window;
- daily eligible-unit rate;
- reported guardrail status;
- known logging incidents;
- configuration changes;
- whether primary outcomes have already been repeatedly inspected.

### Checks

#### SRM

Run separate checks when counts are available:

```text
Assignment SRM
Exposure SRM
Triggered-population SRM
```

Use:

```bash
python3 scripts/ab_experiment_calculator.py srm ...
```

Default suggested SRM alpha is `0.001`, but record the pre-registered value if one exists.

When supplied counts fail SRM:

1. do not interpret the primary outcome;
2. label the result `SRM_SUSPECTED`;
3. recommend investigation by day, platform, browser/app version, geography, new/returning users, bot filtering, concurrent experiments, and start-time asymmetry;
4. state that the check is limited to supplied counts.

#### Sample and duration progress

Calculate:

- current sample completion percentage;
- mature-sample completion percentage;
- estimated remaining days from user-supplied flow;
- whether minimum business cycles have elapsed;
- whether metric maturity is complete.

Do not recommend stopping merely because a p-value looks favorable.

#### Trust risks

Check reported:

- assignment instability;
- exposure logging asymmetry;
- data delay;
- missing or duplicate events;
- treatment-correlated filtering;
- bot rule changes;
- mid-test configuration changes;
- carryover after a bug fix;
- early peeking;
- guardrail breaches.

Output:

```text
NO_OBVIOUS_ISSUE_REPORTED
SRM_SUSPECTED
DATA_QUALITY_RISK
INSUFFICIENT_SAMPLE
MINIMUM_DURATION_NOT_REACHED
PAUSE_AND_INVESTIGATE_RECOMMENDED
```

Always phrase the result as based on user-supplied information.

## Phase 3: POST_EXPERIMENT_REVIEW

### Goal

Assess completed experiment results from summary values, a report, an uploaded file, or a controlled artifact.

### Accepted inputs

#### Binary summary

Per variant:

```text
sampleSize
conversions
```

#### Continuous summary

Per variant:

```text
sampleSize
mean
standardDeviation
```

#### Report export

Prefer:

- allocation and assignment counts;
- exposure counts;
- SRM result;
- primary metric estimates;
- effect, CI, and p-value;
- duration;
- guardrails;
- configuration-change history.

#### Uploaded detail data

Use the Data Analysis Agent to:

- validate and clean the file;
- compute per-variant metrics;
- calculate SRM;
- calculate effect estimates and confidence intervals;
- plot daily effects and sample accumulation;
- run only pre-registered segment analyses as confirmatory;
- label other segment analyses `EXPLORATORY`;
- return complete tables and charts through the artifact/UI-only channel.

When no data is available, produce only the analysis plan and required fields.

### Trust assessment first

Before interpreting the effect, review supplied evidence for:

- assignment SRM;
- exposure/trigger SRM;
- assignment stability;
- data loss and duplication;
- event-definition parity;
- completed metric maturity;
- minimum duration;
- planned sample reached;
- early stopping or repeated peeking;
- design changes;
- randomization/analysis-unit compatibility;
- interference;
- novelty or primacy trend;
- pre-registered analysis adherence.

Output:

```text
TRUSTED
TRUSTED_WITH_LIMITATIONS
ANALYSIS_BLOCKED
INVALID_EXPERIMENT
```

If SRM or a major data-integrity problem is present, stop before interpreting the primary outcome.

### Effect calculation

Use deterministic scripts:

```bash
python3 scripts/ab_experiment_calculator.py analyze-binary ...
python3 scripts/ab_experiment_calculator.py analyze-continuous ...
```

Report:

- control estimate;
- treatment estimate;
- absolute effect;
- relative effect when defined;
- confidence interval for the effect;
- p-value;
- sample sizes;
- method;
- practical threshold;
- assumptions and warnings.

Do not manually recompute the numbers in prose.

### Statistical vs practical significance

Compare the entire confidence interval to the pre-registered practical threshold.

Classify evidence as:

```text
CLEAR_POSITIVE
CLEAR_NEGATIVE
PRACTICALLY_NEGLIGIBLE
POSITIVE_BUT_BELOW_THRESHOLD
NEGATIVE_BUT_BELOW_THRESHOLD
INCONCLUSIVE
UNDERPOWERED
INVALID
```

Then produce a decision-support recommendation:

```text
EVIDENCE_SUPPORTS_SHIP
EVIDENCE_SUPPORTS_NO_SHIP
CONTINUE_OR_COLLECT_MORE
RERUN_RECOMMENDED
FOLLOW_UP_EXPERIMENT_RECOMMENDED
RESULTS_NOT_TRUSTWORTHY
```

Use wording such as:

> Based on the user-provided data and the stated assumptions, the evidence supports...

Never say “the experiment proved” unless the claim is carefully bounded to the randomized estimand and the trust checks passed.

### Segment analysis

Confirmatory segment conclusions require pre-registration.

Post-hoc segments:

- must be labeled `EXPLORATORY`;
- must account for multiple comparisons;
- must not override the aggregate primary decision;
- must use attributes fixed before treatment when possible;
- must not condition on treatment-affected behavior.

## Triggered analysis

Triggered analysis may improve sensitivity when only a subset could be affected.

Require:

- a pre-defined trigger;
- trigger based on pre-treatment or counterfactual-safe information;
- triggered SRM;
- never-triggered complement check;
- clear estimand.

Default primary decision remains intention-to-treat unless the frozen analysis plan says otherwise.

Do not multiply triggered relative uplift by trigger rate to estimate overall uplift without the correct denominator and available aggregate data.

V1 recognizes triggered analysis risk but does not automate advanced dilution for ratio metrics.

## Multiple testing

V1 rules:

- one primary metric;
- guardrails interpreted as veto/risk metrics;
- diagnostics are not ship metrics;
- pre-registered segments are limited;
- post-hoc scans are exploratory.

When multiple primary comparisons exist, require an explicit correction strategy or specialist review.

## When not to use V1 calculations

Return `SPECIALIST_REVIEW_REQUIRED` for:

- cluster-randomized experiments;
- geo experiments;
- switchbacks;
- network or marketplace interference;
- multi-arm adaptive allocation;
- sequential testing not pre-specified;
- Bayesian decision rules;
- survival/time-to-event outcomes;
- ratio metrics needing a delta method;
- very small samples or rare events needing exact methods;
- repeated measures without a valid unit-level aggregation;
- causal claims from observational data.

The skill may explain what additional design is needed, but it must not pretend that the V1 calculator solves it.

## Advisory artifacts

Use the schemas in `schemas/` when structured output is required:

1. `ExperimentAdvisoryCase`
2. `ExperimentDesignRecommendation`
3. `MidExperimentReview`
4. `ExperimentResultAssessment`
5. `ExperimentDecisionMemo`

Persist or present only the fields supported by the conversation.

All structured artifacts should include a canonical content hash when the host application supports versioned storage.

## Recommended response shape

### During clarification

```text
Current phase
Known facts
One blocking question
Recommendation and reason
```

Do not dump the entire checklist.

### Final advisory

```text
Phase
Recommendation status
What is known
Deterministic calculations
Key risks
Assumptions
Missing evidence
Suggested next decision
```

## Files

- `references/decision-framework.md` — compact lifecycle decision tree.
- `references/input-templates.md` — copyable input forms.
- `references/statistical-notes.md` — supported methods and limitations.
- `schemas/` — advisory object contracts.
- `scripts/ab_experiment_calculator.py` — deterministic calculator.
- `examples/example-sessions.md` — example interactions.

## Source posture

This skill is an original implementation informed by established online-experimentation practices and public agent-skill patterns. It does not reproduce external skill text. See `references/acknowledgements.md`.
