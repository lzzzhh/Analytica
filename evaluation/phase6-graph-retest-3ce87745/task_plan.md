# Task Plan: Full Graph-Architecture Retest at 3ce87745

## Goal

Re-evaluate all 26 established Analytica metrics on the graph-architecture commit and add a 27th metric for average successful end-to-end task completion time, without modifying product code.

## Phases

- [x] Phase 1: Read the graph-architecture delta, runtime contracts, public entrypoints, tests, and E2E assets.
- [x] Phase 2: Map all 27 metrics to frozen scenarios, Golden assertions, timing boundaries, slices, and status rules.
- [x] Phase 3: Create an isolated worktree/runtime; freeze Commit, model, feature snapshot, datasets, artifacts, graph configuration, and hashes.
- [x] Phase 4: Execute Pipeline/Governance and deterministic business-Agent suites.
- [x] Phase 5: Execute real-model Multimodal, Data Analysis, Reviewer, tool-calling, consistency, robustness, abstention, hallucination, hard-gate, and E2E timing suites.
- [x] Phase 6: Deterministically score every metric, compare against the previous evidence, and audit failures.
- [x] Phase 7: Publish the report, 27-metric matrix plus post-freeze token telemetry, raw evidence and hashes; stop services and remove temporary worktrees.

## Decisions Made

- Frozen baseline candidate: `3ce87745f9b1546a10ab7fd015dc543eec8bc7ba`; it must be reverified immediately before execution.
- Product code is read-only. Only `evaluation/phase6-graph-retest-3ce87745/` is writable.
- Average completion time uses wall-clock `finishedAt - startedAt` only for E2E cases that satisfy the full success Oracle. Median, p95, failure duration and infrastructure duration will be reported separately.
- Existing Golden answers remain anchors where the dataset bytes and task semantics are unchanged; graph-specific scenarios will be frozen before the first model call.
- No historical metric will be inherited as a current result; all 27 metrics must bind to the same Commit.

## Key Questions

1. Is the graph runtime the actual production/public path or only a tested internal subsystem?
2. Do Artifact handoffs, feedback/recovery edges, human authorization, WriteGate/ReviewGate/Promotion and formal delivery execute end to end?
3. Does the graph improve Data Analysis, Requirement robustness, Reviewer→Gate handoff, and overall consistency without weakening safety?
4. Which event defines a complete successful task for latency measurement, and can it be extracted deterministically?

## Errors Encountered

- None.

## Status

Complete. Final conclusion: `NEEDS_AGENT_AND_GRAPH_FIXES`.
