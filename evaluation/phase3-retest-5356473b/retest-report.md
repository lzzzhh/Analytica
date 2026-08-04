# Phase 3 Retest — Commit 5356473b

## Conclusion

The repair is **partially verified**. Multimodal and Reviewer pass the frozen checks. Requirement and Data Analysis remain below the frozen success criteria, and the production Requirement advisor still cannot launch.

Overall status: `NEEDS_AGENT_FIXES`.

## Frozen scope

- Remote `main`: `5356473b2746daff6007802584da3afd8dba6613`
- Runtime profile: `all-enabled`
- Effective feature hash: `238202ebcc848449`
- Frozen scenario files are unchanged from Phase 3; canonical relative manifest hash: `d5c6af0fdae349d56469850c2fb3fb69e239c71165b611e210b02d7e9c3a788d`
- Product source executed from an isolated detached worktree.
- The clean checkout had no gitignored `dist/rpc-entry.js`. The evaluation reused the existing runtime artifact with SHA-256 `7c3b46714f2d357f8b0d5403164663b60c13e62ef14dfc360ee757bdc16e02a0`; no product source was changed.

## Metrics

| Agent | Metric | Previous | Retest | Status |
|---|---|---:|---:|---|
| Requirement | Route Accuracy | 9/12 (75%) | 11/12 (91.67%) | FAIL |
| Requirement | Constraint Recall | 0/39 (0%) | 1/39 (2.56%) | FAIL |
| Multimodal | pass@1 | 3/4 (75%) | 4/4 (100%) | PASS |
| Multimodal | pass@3 | 4/4 (100%) | 4/4 (100%) | PASS |
| Multimodal | Structured Extraction F1 | 97.22% | 100% | PASS |
| Data Analysis | Task Success Rate | 0/8 | 1/8 (12.5%) | FAIL |
| Data Analysis | Numerical Correctness | 0/26 | 5/26 (19.23%) | FAIL |
| Reviewer | Public registration | NOT_RUN | registered and feature-gated | PASS |
| Reviewer | High-Severity Defect Recall | ABSTAIN | 6/6 (100%) | PASS |
| Reviewer | False Positive Rate | 0/4 | 0/4 (0%) | PASS |

## Independently verified fixes

### PASS: Data Analysis RPC launch and error classification

The subagent now resolves `packages/coding-agent/dist/rpc-entry.js`, launches a real model process, and produces real completed artifacts in three scenarios. A clean-checkout missing-runtime probe returned `SUBAGENT_LAUNCH_FAILED`, not `SCRIPT_SYNTAX_ERROR`. The original total launch blocker is fixed.

### PASS: Reviewer public registration

The `review_data_analysis` tool is registered when `round5.review_tools` is effective and absent when disabled. The ArtifactStore → proposal → gate → Reviewer handoff regression passed. The direct Node test reports 7/7 passing checks.

### PASS: Reviewer analysis locations

All six injected severe defects returned valid HIGH/BLOCKER findings with artifact locations. All four clean cases returned no HIGH/BLOCKER finding.

### PASS: Multimodal canonicalization

All 12 model attempts produced exact structured facts: TP=36, FP=0, FN=0.

## Remaining defects

### P0: Data Analysis is not stable across the required task set

Only `da-02` (group comparison) fully passed.

- `da-01` produced a completed artifact but emitted failure rate `3.39` with `%` unit instead of the frozen numeric contract `0.0339`, and did not expose denominator `10000` as a structured value.
- `da-03` and `da-04` failed because the subagent did not produce a parseable plan.
- `da-05` and `da-06` failed plan validation because the generated plan changed the objective.
- `da-07` produced the correct values `16701` and `8443` but omitted the required explicit warning contract.
- `da-08` failed because the generated plan changed `timeField`.

The RPC transport fix is real, but a single five-row smoke artifact is insufficient evidence for the eight required business categories.

### P1: Requirement structured extraction remains incomplete

The frozen deterministic score is 1/39. The repair now fills some Chinese `constraints` and `outputRequirements`, but it still does not populate dataset subject, metrics, dimensions, comparison baselines, or all required output semantics. It also does not canonicalize extracted Chinese values to the frozen field values, so downstream consumption remains unstable.

`req-01` still routes a clear single-step count query to `NEEDS_CLARIFICATION`. `req-02` and the executable-file rejection are fixed.

### P1: Requirement advisor still uses the wrong RPC relative path

`probeAdvisor` resolves to nonexistent `packages/coding-agent/examples/dist/rpc-entry.js`. Its canary is `INFRA_ERROR`. The extension also still supplies model id `default-planner-model`; the claim that the default is a verified real OpenAI model is not supported by the production registration code.

### Test-runner caveat

`phase15-p0-regressions.test.ts` uses Node's `node:test` API. It passes when run directly with `tsx`, but Vitest CLI reports that the file contains no Vitest suite and cancels pending Node tests. The canonical command must be documented or the test converted to Vitest to prevent false CI claims.

## Required next repair

1. Make Data Analysis plan generation deterministic enough to preserve objective, analysis type, time field, and required views for all eight frozen categories.
2. Define one canonical percentage representation and always emit the denominator and mandatory DQ warnings structurally.
3. Populate Requirement Card dataset, metric, dimension, comparison, constraint, and output fields using stable canonical identifiers; fix `req-01` routing.
4. Correct the advisor adapter's RPC path and configure a real default model id, then make `probeAdvisor` pass from a clean runtime.
5. Clarify or normalize the Phase 15 test runner.

Golden values were not changed after observing the repaired system.
