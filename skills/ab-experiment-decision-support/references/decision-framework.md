# Decision Framework — compact lifecycle decision tree

## Phase detection
User request → classify: PRE_EXPERIMENT | IN_EXPERIMENT_REVIEW | POST_EXPERIMENT_REVIEW.
Unclear → ask "planning, reviewing in-flight, or interpreting completed?"

## Pre-experiment
1. Experimentability gate → STANDARD_AB_SUPPORTED | AB_WITH_CONSTRAINTS |
   SPECIAL_DESIGN_REQUIRED | NOT_CURRENTLY_TESTABLE
2. If STANDARD: hypothesis (if-then-because), unit, ONE primary metric, MDE,
   alpha/power, allocation, duration, pre-registration, launch checklist.
3. Status → DESIGN_READY | DESIGN_READY_WITH_RISKS | MORE_INFORMATION_REQUIRED |
   SPECIALIST_REVIEW_REQUIRED.

## In-experiment
Checks in order: SRM (assignment/exposure/trigger) → sample+duration progress →
trust risks. Output: NO_OBVIOUS_ISSUE_REPORTED | SRM_SUSPECTED |
DATA_QUALITY_RISK | INSUFFICIENT_SAMPLE | MINIMUM_DURATION_NOT_REACHED |
PAUSE_AND_INVESTIGATE_RECOMMENDED. Never recommend stopping on a p-value alone.

## Post-experiment
1. Trust assessment FIRST: SRM, stability, loss/dup, event parity, maturity,
   duration, sample, peeking, design changes, interference. →
   TRUSTED | TRUSTED_WITH_LIMITATIONS | ANALYSIS_BLOCKED | INVALID_EXPERIMENT.
2. If blocked/invalid → stop, do not interpret primary outcome.
3. Deterministic calc: effect, CI, p-value (scripts only).
4. Evidence vs practical threshold → CLEAR_POSITIVE | CLEAR_NEGATIVE |
   PRACTICALLY_NEGLIGIBLE | POSITIVE_BUT_BELOW_THRESHOLD |
   NEGATIVE_BUT_BELOW_THRESHOLD | INCONCLUSIVE | UNDERPOWERED | INVALID.
5. Recommendation → EVIDENCE_SUPPORTS_SHIP | EVIDENCE_SUPPORTS_NO_SHIP |
   CONTINUE_OR_COLLECT_MORE | RERUN_RECOMMENDED | FOLLOW_UP_EXPERIMENT_RECOMMENDED |
   RESULTS_NOT_TRUSTWORTHY.
