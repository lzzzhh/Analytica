# Analytica Pipeline Repair and Blind Retest Report

## Conclusion

`READY_FOR_AGENT_EVALUATION`

The repaired functional pipeline passed all 14 blind datasets. This conclusion
applies to isolated evaluation operation, not production authorization or
cryptographic producer authenticity.

## Repair scope

The delegated repair implemented:

- native arbitrary CSV/Parquet `--contract` CLI and read-only dry run;
- runtime JSON Schema validation with required `approvalId`;
- sealed Governance Phase 1 plus placement verification at `WriteGate`;
- a single atomic Iceberg overwrite snapshot and batch-id idempotency;
- contract-aware duplicate-key, null, type, schema-drift, and event-time checks;
- product-generated plan, quality, execution-manifest, and lineage artifacts;
- Round 5 Reviewer feature activation and persistent materialization handoff.

The full instruction supplied to the repair agent is in
`repair-agent-instructions.md`. No commit was created.

## Fixed environment

- Commit SHA: `fdaffc50f2679505d6056966111156c40363aade`
- Python: `/opt/anaconda3/bin/python3.13` (`3.13.5`)
- Node: `v22.22.2`
- PyArrow `19.0.0`; PyIceberg `0.11.1`; PySpark `3.5.3`; pytest `8.3.4`;
  jsonschema `4.23.0`; pandas `2.2.3`
- Warehouse root: `evaluation/phase2-retest/artifacts/runs`
- Runtime feature contents and hashes: `artifacts/environment.json`
- Native CLI command records: `artifacts/command-log.jsonl` (84 invocations)

## Frozen blind datasets

All inputs were downloaded from the UCI Machine Learning Repository on
2026-08-03 under CC BY 4.0. None reuse Chinook or the prior Bike Sharing input.

| Dataset | Frozen rows | Result |
|---|---:|---|
| Abalone | 4,177 | PASS |
| Iris | 150 | PASS |
| Wine | 178 | PASS |
| Wine Quality | 6,497 | PASS |
| Air Quality | 9,357 | PASS |
| Appliances Energy Prediction | 19,735 | PASS |
| Dry Bean | 13,611 | PASS |
| Rice (Cammeo and Osmancik) | 3,810 | PASS |
| Raisin | 900 | PASS |
| Forest Fires | 517 | PASS |
| Concrete Compressive Strength | 1,030 | PASS |
| Energy Efficiency | 768 | PASS |
| AI4I 2020 Predictive Maintenance | 10,000 | PASS |
| Seoul Bike Sharing Demand | 8,760 | PASS |

The source URLs, DOI, license, file sizes, SHA-256 values, schemas, null counts,
and observed row counts are frozen in `artifacts/dataset-source-manifest.json`.
The UCI metadata says 9,358 Air Quality rows while the frozen CSV has 9,357;
Wine Quality metadata says 4,898 while the combined direct CSV has 6,497.
Golden answers use the frozen-file observations and retain these discrepancies.

## Executed chain

For every dataset:

1. verify frozen file hash and infer a PyArrow profile;
2. create an isolated, explicitly test-only sealed approval fixture;
3. run native CLI dry run;
4. perform the first governed `eval_raw` write;
5. query the Iceberg table and compare row multiset, schema, row count, numeric
   sums, and snapshot with the golden answer;
6. repeat the identical CLI run and verify one unchanged snapshot;
7. attempt a write with a nonexistent approval and governance repository;
8. dry-run and execute a deterministic mutation containing seven defect classes.

The mutation write is required to fail before warehouse creation. Product plans,
quality reports, manifests, and lineage are under each run's
`pipeline-outputs` directory.

## Metrics

| Metric | Result | Status |
|---|---:|---|
| Pipeline Run Success Rate | 14/14 = 1.0000 | PASS |
| Data Correctness Rate | 70/70 = 1.0000 | PASS |
| Data Quality Defect Detection Precision | 98/98 = 1.0000 | PASS |
| Data Quality Defect Detection Recall | 98/98 = 1.0000 | PASS |
| Data Quality Defect Detection F1 | 1.0000 | PASS |
| Idempotent Rerun Success Rate | 14/14 = 1.0000 | PASS |
| Governance Enforcement Rate | 14/14 = 1.0000 | PASS |

`GOVERNANCE_BYPASS_CONFIRMED` was **not** observed. All 14 unapproved write
attempts returned nonzero and created no warehouse.

## Verification

- Pipeline/Governance: 55 passed, 2 skipped.
- Lakehouse Gateway materialization: 8 passed.
- Data Analysis and Feature/Reviewer Node tests: 56 passed.
- Evaluation harness Python compile and Ruff: passed.
- `git diff --check`: passed.
- Root `npm run check`: formatting, pinned dependencies, TypeScript import,
  shrinkwrap, and install-lock checks passed; `tsgo --noEmit` failed on existing
  `packages/ai/test/*` references to removed model IDs `glm-4.5-air` and
  `glm-5.1`. Those unrelated files were not changed.

## Assets

- Dataset Source Manifest: `artifacts/dataset-source-manifest.json`
- Raw frozen downloads: `downloads/`
- Dataset profiles: `artifacts/profiles/`
- Pipeline contracts: `artifacts/contracts/`
- Product plans/manifests/quality/lineage: `artifacts/runs/*/*/pipeline-outputs/`
- Warehouse snapshot index: `artifacts/warehouse-snapshot.json`
- Golden answers: `artifacts/golden/`
- Mutation definitions and files: `artifacts/mutation-definitions.json`,
  `artifacts/mutations/`
- Per-dataset results: `artifacts/results/`
- Aggregate metrics: `artifacts/metrics.json`
- Exact CLI execution log: `artifacts/command-log.jsonl`
- Preserved invalid first attempt: `artifacts-initial-invalid-mutation-design/`

## Remaining caveats

1. The evaluation approval actor is explicitly
   `TEST_ONLY_OPERATOR_FIXTURE`; it proves gate mechanics, not human approval.
2. The Gateway-to-ArtifactStore sidecar is content-hash protected but not
   producer-authenticated. A process with write access to the artifact directory
   can replace both bytes and sidecar. Strong provenance still needs an
   authenticated channel or external signing key.
3. Placement namespace consistency is only enforced for the built-in controlled
   target set. A caller constructing a custom controlled set can approve
   `targetLayer=ODS` for `eval_raw.*`; this was necessary for the requested
   isolated namespace but should not be described as production layer policy.
4. The full repository check remains red for unrelated stale AI model test IDs.
