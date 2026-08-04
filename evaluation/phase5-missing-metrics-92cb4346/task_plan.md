# Task Plan: Missing Evaluation Metrics at 92cb4346

## Goal

Map the new project-wide evaluation table to existing evidence, then deterministically evaluate every metric that has not yet been measured without modifying product code.

## Phases

- [x] Phase 1: Audit prior reports, commits, scenarios, and metric coverage.
- [x] Phase 2: Define the missing-metric suite, Golden assertions, slices, and status rules.
- [x] Phase 3: Freeze commit, environment, scenarios, configuration, and hashes before execution.
- [x] Phase 4: Execute required repeat, abstention, perturbation, hallucination, and hard-gate cases.
- [x] Phase 5: Deterministically score metrics and classify failures with evidence.
- [x] Phase 6: Publish the consolidated metric coverage matrix and final report; clean temporary services/worktrees.

## Decisions Made

- Product code is read-only. Only `evaluation/phase5-missing-metrics-92cb4346/` is writable.
- The complementary run is bound to remote main `92cb4346ac5f0b4edc3eefcdcb81978e570fd220` unless the pre-execution verification changes.
- Previously measured metrics will be cited with their original commit; they will not be silently merged into a new-commit score.
- Missing metrics will be frozen before the first new model call and scored independently from raw traces.

## Key Questions

1. Which table metrics already have valid deterministic evidence, and at which commit?
2. Which missing global metrics require new repeated or perturbed executions rather than rescoring existing traces?
3. Can hard-gate violations be assessed across the currently reachable public paths without confusing safe false negatives with bypasses?

## Errors Encountered

- Initial design validation rejected `execute_query` as a forbidden tool in GM-TOOL-01 because it was intentionally absent from that case's exposed tool set. Removed the redundant assertion before freezing; execution policy already makes the call impossible.
- GM-REV-02 initially reused prior Reviewer state and failed with `no-clobber`, violating independent-run isolation. Preserved the original traces and used the scoring contract's confirmed-infrastructure retry allowance to rerun only those four variants with fresh per-run stores and unchanged prompts/Oracle.

## Status

Complete. All seven previously missing metrics are scored, all 26 table metrics are mapped to evidence, and temporary services/worktrees are removed.
