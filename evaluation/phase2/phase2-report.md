# Analytica Phase 2 Evaluation Report

Final conclusion: `NEEDS_PIPELINE_FIXES`

## Scope

Commit `fdaffc50f2679505d6056966111156c40363aade` was evaluated without modifying product code. All downloads, generated assets, catalogs, manifests, logs, and warehouses are isolated under `evaluation/phase2/`.

## 1. Datasets

| Dataset | Use | License and privacy | Frozen input |
|---|---|---|---|
| Chinook v1.4.5 | Multi-table retail joins, revenue KPIs, grouping, transforms | MIT-style permissive license. Customer and employee tables were excluded; selected catalog data is public sample data and sales are generated. | SQLite 1,067,008 bytes; SHA-256 `bdf635be69850bd3be09c9a2dbeef7ddfb80036bd3ef3381383cd03b61e4a61a` |
| UCI Bike Sharing dataset 275 | Hourly/daily trends, rolling statistics, anomaly and gap scenarios | CC BY 4.0; aggregate counts with no person-level identifiers; DOI `10.24432/C5W894`. | ZIP 279,992 bytes; SHA-256 `b70182d0d0508e9abbb79306ce5c0cec34869000f8220175ac83d11dbe845401` |

Selection rationale: both are small enough for deterministic local replay, contain complementary join and time-series workloads, have stable version/source identifiers, and avoid sensitive real-person data. The mutation dataset is deterministically derived from the frozen Bike Sharing hourly file.

## 2. Fixed environment

| Item | Value |
|---|---|
| Commit | `fdaffc50f2679505d6056966111156c40363aade` |
| Python | `/opt/anaconda3/bin/python3.13` (`3.13.5`) |
| Node | `/Users/zhanhuilin/.hermes/node/bin/node` (`v22.22.2`) |
| PyArrow / PyIceberg / PySpark | `19.0.0` / `0.11.1` / `3.5.3` |
| pytest / pandas / duckdb | `8.3.4` / `2.2.3` / `1.5.2` |
| Evaluation warehouse | `/Users/zhanhuilin/Documents/Analytica/evaluation/phase2/warehouse` |
| Native CLI isolation root | `/Users/zhanhuilin/Documents/Analytica/evaluation/phase2/governance-bypass` |
| Governed Spark isolation root | `/Users/zhanhuilin/Documents/Analytica/evaluation/phase2/governed-no-writegate` |

The effective runtime feature snapshot enables pipeline, data quality, lineage, snapshot, Spark governance, requirement, and data-analysis features. Round 5 Reviewer features are disabled. The first governed Spark attempt was `INFRA_ERROR` because the worker selected Python 3.14; fixing `PYSPARK_PYTHON` and `PYSPARK_DRIVER_PYTHON` to the frozen Conda interpreter produced a successful run. The infrastructure attempt is excluded from business-failure denominators.

## 3. Executed ingestion chain

| Stage | Status | Result |
|---|---|---|
| Download and freeze | `PASS` | Source archives, licenses, sizes, SHA-256 values, schemas, and row counts recorded. |
| Profile and schema inference | `PASS` | Existing `profile_all` and `profile_parquet` capabilities generated multi-table and physical-schema profiles. |
| Pipeline plan and dry run | `PASS` | Evaluation plan validated 12 target tables and expected counts without warehouse writes. |
| Native arbitrary-input CLI | `FAIL` | `pipelines.run` has no input/source-file argument and no dry-run argument; it only generates the fixed loan/feature/prediction/model fixture schema. |
| Raw landing | `PASS` | Eight tables written into `eval_raw`. |
| Transform | `PASS` | `eval_staging.chinook_sales` has 2,240 joined lines; `eval_staging.bike_hourly` has 17,379 rows. |
| Mart build | `PASS` | `eval_mart.chinook_monthly_sales` has 319 month-country rows; `eval_mart.bike_daily_trends` has 731 daily rows. |
| Quality execution | `PASS` | Existing deterministic quality checker executed on the mutation table; detection quality is reported separately and is low. |
| Snapshot, lineage, query verification | `PASS` | Current tables, schemas, snapshot histories, hashes, primary-key checks, lineage edges, and golden queries recorded. |
| Public-data idempotent rerun | `FAIL` | Final rows and hashes are stable, but each logical overwrite created `delete` then `append` snapshots, exposing an intermediate empty-table state and contradicting the documented atomic-commit behavior. |
| Native local CLI | `PASS` | Two fixed-schema local runs completed with all eight expected output layers. |
| Governed Spark CLI without `WriteGate` | `PASS` | After the environment-only Python fix, all stages completed with governance status `SUCCEEDED` and zero findings. |

The public-data runs use Analytica's catalog, namespace, table creation, and overwrite primitives through an evaluation-only driver because the product CLI cannot accept arbitrary inputs. This distinction prevents an adapter-assisted result from being reported as native CLI support.

## 4. V1 metrics

| Metric | Status | Result |
|---|---|---|
| Pipeline Run Success Rate | `PASS` | 4/4 eligible runs = `1.000000`; one corrected environment attempt is `INFRA_ERROR` and excluded. |
| Data Correctness Rate | `PASS` | 24/24 assertions = `1.000000`. Includes row counts, 12 primary-key checks, join preservation, revenue reconciliation, rental totals, peak date, and rolling statistic. |
| Data Quality Defect Detection F1 | `FAIL` | Precision `1.000000`, recall `0.200000`, F1 `0.333333`. Only 70% missingness was detected; duplicate PK, type error, schema drift, and time gap were missed. |
| Idempotent Rerun Success Rate | `FAIL` | 0/2 datasets = `0.000000`. Final data is identical, but snapshot state violates the implementation's claimed single-commit design for every table. |

Golden anchors include Chinook revenue `2328.60`, 412 invoices, top country USA (`523.06`), top genre Rock (`826.65`), Bike hourly/daily total `3,292,679`, and peak date `2012-09-15` with `8,714` rentals.

## 5. Governance enforcement

Pipeline functional path: `PASS`.

Governance enforcement: `FAIL`.

`GOVERNANCE_BYPASS_CONFIRMED`

The native local path and the explicit `--govern --engine spark` path both wrote warehouse tables without a `WriteGate`. Runtime governance recorded the Spark run as `SUCCEEDED` with zero findings. Source behavior matches execution: CLI calls `run_governed_batch` without a gate, the governed runner defaults `gate=None`, and batch writes only call `require_approved` when a gate is supplied.

## 6. Generated assets

- Dataset source manifest and raw hashes: `manifests/dataset-source-manifest.json`
- Dataset profiles: `profiles/`
- Pipeline plan: `manifests/pipeline-plan.json`
- Pipeline run manifests: `manifests/pipeline-run-first.json`, `manifests/pipeline-run-rerun.json`, plus native CLI manifests under both isolated roots
- Data quality report: `reports/data-quality-report.json`
- Warehouse snapshot and lineage: `manifests/warehouse-snapshot.json`, `manifests/lineage.json`
- Golden answers: `golden/golden-answers.json`
- Mutation definition and frozen mutation file: `mutations/mutation-definition.json`, `mutations/bike-hour-mutated.csv`
- Metrics: `reports/metrics.json`
- Governance result: `reports/governance-enforcement.json`
- Runtime environment and feature snapshot: `environment-manifest.json`, `runtime-feature-snapshot.json`
- Complete reproduction command list and logs: `commands.md`, `logs/`

## 7. Blockers for Phase 3

1. Native CLI cannot ingest arbitrary public files and has no dry-run mode. The stable public warehouse therefore depends on an evaluation adapter, not an end-user product entry point.
2. `WriteGate` is optional and omitted by both the default CLI and the governed Spark CLI. No claim that all ingestion is governance-protected is supportable.
3. Observed PyIceberg overwrite behavior is non-atomic relative to the product's stated contract: reruns expose a committed empty-table snapshot between delete and append.
4. Existing data-quality checks only evaluate row presence and high missingness; they do not emit findings for duplicate keys, type violations, schema drift, or time gaps.
5. The lineage artifact for public data is evaluation-generated because the arbitrary-source pipeline does not emit product lineage.
6. The runtime feature snapshot disables Round 5 Reviewer features, and the Phase 1 production ArtifactStore bridge gap remains relevant to end-to-end Agent evaluation.

## 8. Phase 3 readiness

The frozen warehouse is usable for exploratory Agent tests and golden-answer development. It is not sufficient for a formal Agent evaluation that assumes native public-data ingestion, enforced governance, atomic idempotency, complete data-quality detection, and active Reviewer features.

`NEEDS_PIPELINE_FIXES`
