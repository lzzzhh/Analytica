# Blind Retest Notes

## Repair baseline

- Baseline commit: `fdaffc50f2679505d6056966111156c40363aade`.
- Prior conclusion: `NEEDS_PIPELINE_FIXES`.
- Verified blockers: missing arbitrary-input CLI/dry-run, optional `WriteGate`, non-atomic observed overwrite history, narrow DQ checks, evaluation-generated lineage, disabled Round 5 Reviewer runtime features, and incomplete production Artifact handoff.

## Dataset secrecy

The new dataset identities and mutations will be recorded here only after the repair agent has completed implementation.

## Evidence log

- Repair Agent completed all six requested implementation areas without a commit.
- Reported targeted results: arbitrary pipeline 9 passed; engines 7 passed/2 skipped; pipeline/governance 47 passed; gateway materialization 8 passed; Data Analysis 27 passed; feature runtime 29 passed; Reviewer gate 29 passed.
- Root `npm run check` remains blocked by pre-existing unrelated stale model-ID errors under `packages/ai/test/*`; this must be independently confirmed and kept separate from repair-specific results.
- Independent reproduction found advertised `boolean` and `date` arbitrary-source fields could not be written because `_create_table` mapped them to Iceberg strings.
- Runtime contract validation omitted required `approvalId`; a target-level sealed approval could therefore authorize a contract without explicit approval binding.
- Both blockers were returned to the repair Agent with concrete regressions before blind datasets were disclosed.
