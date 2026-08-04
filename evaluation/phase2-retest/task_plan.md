# Analytica Pipeline Repair and Blind Retest Plan

## Goal

Have a delegated repair agent address the verified pipeline blockers, independently review the patch, then rerun a fresh evaluation on at least 10 previously unused public datasets.

## Phases

- [x] Phase 1: Define repair scope and acceptance criteria.
- [x] Phase 2: Delegate implementation and wait for targeted verification.
- [x] Phase 3: Independently inspect the diff and reproduce regression tests.
- [x] Phase 4: Select and freeze 10+ new public datasets without disclosing them to the repair agent.
- [x] Phase 5: Execute native CLI dry-run, governed ingestion, DQ mutation, snapshot, lineage, query, and rerun scenarios.
- [x] Phase 6: Compute aggregate and per-dataset metrics.
- [x] Phase 7: Deliver the blind-retest report and readiness conclusion.

## Key questions

1. Can the native product CLI ingest arbitrary CSV/Parquet inputs without an evaluation adapter?
2. Are all standard CLI writes blocked unless a valid `WriteGate` authorization exists?
3. Does each logical overwrite create exactly one committed snapshot without an intermediate empty state?
4. Do contract-aware quality checks detect duplicate keys, missing required values, type errors, schema drift, and time gaps?
5. Does the product emit lineage and manifests for arbitrary-source runs?
6. Are Reviewer features and the required Artifact handoff usable for Phase 3?

## Decisions made

- Keep the fresh dataset list blind to the repair agent to reduce test overfitting.
- Require at least 10 new datasets; none may reuse Chinook or UCI Bike Sharing.
- Do not count infrastructure failures as business failures.
- Do not accept evaluation-only adapters as proof of native CLI support.
- Do not commit unless explicitly requested.

## Errors encountered

- Independent bool/date type reproduction initially failed to import `pipelines` because an ad-hoc script executed from `/tmp` did not inherit the POC root on `sys.path`; rerun with an explicit `PYTHONPATH`.

## Status

Complete. Fourteen blind datasets passed the functional pipeline, correctness,
quality detection, idempotency, and governance-enforcement scenarios. Final
conclusion: `READY_FOR_AGENT_EVALUATION`, with the ArtifactStore producer-
authenticity caveat retained.
