# Analytica Phase 2 Evaluation Plan

## Goal

Evaluate public-data ingestion and pipeline behavior in an isolated warehouse, produce reproducible evidence and the four requested V1 metrics, without modifying product code.

## Scope and constraints

- Repository under evaluation: `/Users/zhanhuilin/Documents/Analytica`
- Evaluation outputs: `evaluation/phase2/`
- Product code is read-only.
- Use the Conda Python runtime with PyIceberg, PySpark, and pytest.
- Do not write to production namespaces or warehouses.
- Do not suppress quality failures or treat infrastructure failures as business failures.
- Use only `PASS`, `FAIL`, `ABSTAIN`, `NOT_RUN`, or `INFRA_ERROR` for scenario status.

## Phases

| Phase | Status | Evidence |
|---|---|---|
| 1. Freeze repository and runtime environment | completed | environment manifest, feature snapshot, command log |
| 2. Select, license-check, download, and freeze datasets | completed | source manifest, hashes, schemas, row counts |
| 3. Inspect and exercise the real CLI/pipeline entry points | completed | plans, dry-run output, run manifests |
| 4. Validate transforms, quality checks, snapshots, lineage, and queries | completed | profiles, DQ reports, golden answers |
| 5. Run deterministic mutations and idempotent reruns | completed | mutation definition, metric inputs |
| 6. Test governance enforcement without `WriteGate` | completed | isolated bypass run evidence |
| 7. Compute metrics and write the final report | completed | metrics JSON and `phase2-report.md` |

## Success criteria

- Every claim is backed by a frozen artifact or command output.
- Public input files have source, license, download date, SHA-256, size, schema, and row count.
- The evaluation warehouse is isolated and reproducible.
- Metrics distinguish product failure, abstention, and infrastructure failure.
- The final conclusion is exactly one of the requested conclusion values.

## Errors and blockers

| Timestamp | Attempt | Result | Resolution |
|---|---|---|---|
| 2026-08-03T01:25Z | Capture native CLI exit code using shell variable `status` | zsh rejected assignment because `status` is read-only; the pipeline itself completed and wrote a valid manifest | Use `exit_code` for later wrappers; independently verified the manifest exists and reports success |
| 2026-08-03T01:31Z | Build dataset source manifest | Prepared-table path mapped `bike_sharing` to a nonexistent underscore directory | Corrected manifest path mapping to the frozen `bike-sharing` directory and reran preparation |
| 2026-08-03T01:32Z | Dry-run Chinook transform | Final Genre join retained its unique column as `name`, not `name_genre` | Corrected the explicit rename and reran dry-run |
| 2026-08-03T01:34Z | Validate idempotent snapshot state | Two logical writes produced `append -> delete -> append`; the rerun created an intermediate empty-table snapshot, contrary to the claimed single atomic commit | Mark idempotent rerun FAIL despite stable final rows and hashes; preserve snapshot operations as evidence |
| 2026-08-03T01:32Z | Governed Spark path without `WriteGate` | Spark worker resolved Homebrew Python 3.14 while driver used Conda Python 3.13, causing `PYTHON_VERSION_MISMATCH` | Classify attempt as `INFRA_ERROR`; rerun with `PYSPARK_PYTHON` and `PYSPARK_DRIVER_PYTHON` fixed to the recorded Conda interpreter |
