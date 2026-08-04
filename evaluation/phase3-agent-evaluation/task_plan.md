# Phase 3 Agent Evaluation Plan

## Goal

Independently evaluate Requirement, Multimodal, Data Analysis, and Reviewer
behavior through real Analytica/Pi entrypoints using frozen Phase 2 data and
pre-registered deterministic scoring rules, without modifying product code.

## Phases

- [x] Phase 1: Freeze repository, runtime, model, dataset, and feature configuration.
- [x] Phase 2: Read the complete real entrypoints, existing fixtures, and tests for the four agents.
- [x] Phase 3: Freeze scenarios, expected routes/artifacts, Golden Answers, and metric formulas.
- [x] Phase 4: Execute Requirement Agent scenarios and compute Route Accuracy and Constraint Recall.
- [x] Phase 5: Execute Multimodal Agent scenarios and compute pass@1, pass@3, and extraction F1.
- [x] Phase 6: Execute Data Analysis Agent scenarios and compute task success and numerical correctness.
- [x] Phase 7: Execute Reviewer guardrail scenarios and compute defect recall and false-positive rate.
- [x] Phase 8: Audit evidence, classify infrastructure failures, and write the final report.

## Fixed rules

- Product code and product outputs are read-only.
- Evaluation-only files may be created under `evaluation/phase3-agent-evaluation`.
- Scenarios and Golden Answers are frozen before invoking the tested system.
- Deterministic programs compute route, constraint, F1, pass@k, schema, hash,
  numerical, and reviewer metrics.
- A system-generated self-assessment is never accepted as the pass decision.
- Missing evidence is `ABSTAIN`; infrastructure failure is `INFRA_ERROR` or `NOT_RUN`.
- Every failure must reference an artifact, log, code location, or recomputation.

## Key questions

1. Which checked-in CLI/tool surfaces actually invoke each Agent?
2. Can the configured model/provider run without paid or missing credentials?
3. Does Data Analysis consume the Phase 2 Artifact handoff rather than raw paths?
4. Can Reviewer inspect immutable agent outputs without altering them?

## Errors encountered

- The first worktree content-hash command reused zsh's special `path` variable and temporarily broke command lookup. It was rerun with `artifact_path` and absolute `/usr/bin/shasum`.
- The first Appliances golden calculation assumed a space in timestamps; the frozen source uses `YYYY-MM-DDHH:mm:ss`. The calculation was corrected before Agent execution by grouping on the frozen first seven characters.
- Data Analysis's product RPC path resolves to a nonexistent `packages/coding-agent/examples/dist/rpc-entry.js`; all eight frozen scenarios reached the Agent route but failed before model execution.
- Reviewer positive cases returned HIGH/BLOCKER findings without a file location. The adapter rejected all six; they are `ABSTAIN`, not false negatives.

## Status

Complete. The evidence package and report are ready for audit.
