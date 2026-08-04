# Phase 2 Working Notes

This file records evidence and decisions during execution. It is not the final report.

## Initial known constraints

- The default Homebrew Python lacks required evaluation dependencies.
- `/opt/anaconda3/bin/python3.13` previously showed PyIceberg, PySpark, pytest, MarkItDown, and PaddleOCR available.
- The batch pipeline accepts an optional governance gate; absence of a gate must be tested as a separate enforcement scenario.
- The product pipeline appears fixture-oriented; arbitrary public-data support must be verified from the current source and actual execution rather than assumed.

## Decisions

- Keep all mutable state under `evaluation/phase2/`.
- Prefer synthetic or anonymized public datasets with explicit licenses.
- Generate quality mutations deterministically from frozen inputs rather than introducing a third external source unless needed.

## Evidence log

- Public datasets frozen with source and prepared-file hashes.
- Native local pipeline completed twice without a `WriteGate`.
- Governed Spark completed without a `WriteGate` after fixing worker/driver Python paths.
- Public data produced 12 Iceberg tables in `eval_raw`, `eval_staging`, and `eval_mart`.
- All 24 correctness assertions passed.
- Mutation evaluation detected only missingness: precision 1.0, recall 0.2, F1 0.333333.
- Rerun final hashes matched, but every table recorded `append -> delete -> append`, so idempotency failed the documented snapshot contract.
- Final conclusion: `NEEDS_PIPELINE_FIXES`.
