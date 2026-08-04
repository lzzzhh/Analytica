# Analytica Tool-Calling Evaluation Plan

## Goal

Evaluate Analytica's real tool-calling behavior against the user-provided DOCX specification, without modifying product code or the frozen Phase 3 results.

## Phases

- [x] Phase 1: Read and render the DOCX; extract its complete evaluation contract.
- [x] Phase 2: Freeze repository commit, runtime profile, models, scenarios, Golden outcomes, and status rules.
- [x] Phase 3: Identify the actual public Pi tool entrypoint and design an isolated evaluation runtime.
- [ ] Phase 4: Execute frozen tool-calling scenarios and capture raw transcripts, tool calls, arguments, results, and artifacts.
- [ ] Phase 5: Deterministically score routing, tool selection, arguments, call sequence, recovery, and completion.
- [ ] Phase 6: Audit evidence and publish the tool-calling report.

## Fixed Rules

- Product code is read-only; evaluation assets live only under this directory.
- The tested system is Analytica/Pi; Codex computes pass/fail independently.
- Scenarios and Golden outcomes are frozen before execution.
- Tool names, arguments, ordering, call counts, statuses, hashes, and deterministic assertions are program-scored.
- Missing evidence is `ABSTAIN`; infrastructure failure is `INFRA_ERROR` or `NOT_RUN`.
- No graph-structure redesign or Phase 3 metric rerun is in scope.

## Key Questions

1. What exact tool-calling capabilities and thresholds does the DOCX require?
2. Which public Pi entrypoint exercises those tools without test-only injection?
3. Which scenarios require live models, data, or external services?
4. How are tool-call correctness and task completion separated?

## Errors Encountered

- The tracked `build/feature-snapshot.json` is stale and belongs to commit `adc115db...`; it is not accepted as the runtime snapshot for this evaluation. The live snapshot must be generated during preflight.
- The clean fixed-commit worktree has neither `node_modules` nor tracked `packages/coding-agent/dist/rpc-entry.js`; execution must use a separately hashed runtime artifact without editing product source.
- The public registry has no Pipeline write, materialization, WriteGate, or Promotion tool. Workflows requiring them are safe-stop cases, not fabricated successes.

## Status

Design gate reached: 36 cases and deterministic scoring rules are frozen. Phase 4 waits for user confirmation.
