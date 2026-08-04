# Task Plan: Analytica One-Click Evaluation

## Goal

Provide one command that freezes the current environment, executes the existing evaluation suites in dependency order, preserves raw evidence, separates infrastructure failures from business failures, and produces a final metric matrix.

## Phases

- [x] Phase 1: Audit existing phase-6 runner contracts, side effects, dependencies, and cleanup requirements.
- [x] Phase 2: Define the CLI, execution stages, resume/dry-run behavior, and success/status contract.
- [x] Phase 3: Implement the orchestration script and concise usage documentation without modifying product code.
- [x] Phase 4: Validate shell syntax, dry-run stage ordering, dependency failure behavior, and isolated output creation.

## Key Questions

1. Which phase-6 scripts are reusable for a new Commit and which are hard-bound to `3ce87745`?
2. Which services and fixtures must be created and cleaned automatically?
3. How can long-running real-model suites resume without silently inheriting stale evidence?

## Decisions Made

- Product code remains read-only; new files belong under `evaluation/one-click-evaluation/`.
- The first version will orchestrate existing evaluators instead of duplicating their scoring logic.

## Errors Encountered

- Initial generated-runner validation treated the current Commit as stale because it equals the phase-6 template Commit. The validator now checks old Commit literals only when evaluating a different Commit.
- `npm run check` reached the repository TypeScript check and failed on pre-existing `packages/ai/test/*` references to removed `glm-4.5-air` and `glm-5.1` model IDs. The formatter also touched `rpc-client.ts`; that unrelated formatting change was restored. The one-click script's own syntax and preflight checks pass.

## Status

Complete. Full paid model execution was intentionally not repeated; `--preflight`, default/custom-port dry runs, shell syntax and generated Node/Python runner syntax passed.
