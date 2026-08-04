# Analytica Pipeline Repair Task

You are the implementation agent. Work in `/Users/zhanhuilin/Documents/Analytica` and follow the repository `AGENTS.md` exactly.

## Objective

Fix the verified blockers from `evaluation/phase2/phase2-report.md` so a separate evaluator can run a blind test on previously undisclosed public datasets. Do not optimize for or hardcode the existing Chinook or Bike Sharing fixtures.

## Required work

### 1. Native arbitrary-source pipeline CLI

- Add a supported product CLI path for declarative ingestion of external CSV and Parquet files into an explicitly configured local warehouse and namespace.
- The input contract must freeze source path, content hash, format, target table, expected schema or schema policy, primary key, event-time field when applicable, and quality rules.
- Add a true dry-run mode that performs parsing, schema inference/validation, plan construction, target resolution, and governance preflight without creating namespaces, catalog files, tables, snapshots, manifests that claim execution, or approval records.
- Produce a product-owned pipeline plan and execution manifest. Every required stage must have an explicit status; do not report success when a required stage is missing or partial.
- Preserve isolation: no production warehouse, S3, or external credentials.

### 2. Mandatory governance enforcement

- Standard CLI write paths, including `--govern`, must not write when no valid `WriteGate` authorization is supplied.
- Remove the current implicit `gate=None` authorization bypass from executable product paths.
- Runtime governance findings are not a substitute for write authorization.
- If tests need an ungated helper, it must be structurally test-only, explicit, and unreachable from normal CLI invocation. Do not add a user-facing flag that silently disables governance.
- Add regression tests proving that local and Spark-capable write paths fail before the first table/snapshot is created when authorization is absent or invalid.

### 3. Atomic and idempotent overwrite

- Fix the write primitive so one logical overwrite produces one committed Iceberg snapshot.
- A reader must not observe or time-travel to an intermediate empty-table snapshot.
- A rerun of the same batch must preserve row counts, primary-key uniqueness, deterministic content, clean manifest/state, and the documented snapshot semantics.
- Add tests that inspect snapshot operations and counts, not only final rows.

### 4. Contract-aware data quality

- Extend deterministic quality evaluation to emit machine-readable findings for:
  - duplicate primary keys;
  - missing required values;
  - type violations;
  - schema drift, including unexpected/missing columns and incompatible types;
  - event-time gaps when a frequency/tolerance contract is supplied.
- Keep existing basic row-count/missing-rate behavior where compatible, but do not infer business keys or temporal expectations silently. These rules must come from the source/pipeline contract.
- Add positive and negative regression tests. A clean dataset must not receive injected-defect findings.

### 5. Product lineage and evidence

- Arbitrary-source runs must emit product-owned lineage linking frozen source hashes to raw, staging/mart outputs, transforms, snapshots, quality results, approval binding, and run manifest.
- A failed or blocked write must not emit lineage or manifests that imply a successful delivery.

### 6. Phase 3 runtime prerequisites

- Make the intended Round 5 Reviewer feature set effective in the normal full evaluation runtime, or document and implement the explicit supported profile required to enable it.
- Close the production handoff gap between successful materialization and the trusted ArtifactStore used by Data Analysis, with tests proving that a real materialized artifact can be resolved by the downstream analysis path.
- Do not replace the trusted store with fixture-only registration or a permissive path lookup.

## Constraints

- Read every file you modify in full first.
- Make the smallest coherent change; no unrelated refactor or dependency addition.
- Do not weaken approval, sensitive-data, query, or warehouse isolation controls.
- Do not modify files under `evaluation/phase2-retest/`; those belong to the independent evaluator.
- Do not use undisclosed future datasets or add dataset-specific branches.
- Do not use real provider APIs, paid tokens, or production services.
- Do not commit.

## Required verification

- Reproduce each relevant baseline failure before fixing it where practical.
- Run every new or modified test directly and iterate until it passes.
- Run existing targeted pipeline, governance, quality, lineage, Reviewer, and ArtifactStore tests affected by the change.
- After code changes, run `npm run check` with full output and resolve all errors, warnings, and infos.
- Do not run the unrestricted full Vitest suite; follow `AGENTS.md` test commands.

## Completion report

Return a concise report containing:

- exact files changed;
- behavior fixed for each numbered requirement;
- tests and commands run with outcomes;
- any requirement not completed;
- remaining risks or environment limitations;
- confirmation that no commit was created.

Do not claim completion if any standard CLI write still succeeds without authorization, if overwrite still creates an intermediate delete snapshot, or if the arbitrary-source path still depends on evaluation-only code.
