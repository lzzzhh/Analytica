# Verification Commands

```bash
git rev-parse HEAD
/opt/anaconda3/bin/python3.13 --version
node --version

jq -r '.[] | "\(.id) \(.slug)"' evaluation/phase2-retest/dataset-candidates.json |
while read -r dataset_id dataset_slug; do
  curl --fail --location --retry 3 --silent --show-error \
    "https://archive.ics.uci.edu/static/public/${dataset_id}/data.csv" \
    --output "evaluation/phase2-retest/downloads/${dataset_slug}.csv"
done
shasum -a 256 evaluation/phase2-retest/downloads/*.csv
wc -c evaluation/phase2-retest/downloads/*.csv

PYTHONPATH=packages/coding-agent/examples/extensions/multimodal-artifact-poc \
  /opt/anaconda3/bin/python3.13 evaluation/phase2-retest/run_blind_retest.py

/opt/anaconda3/bin/python3.13 -m pytest -q \
  pipelines/tests/test_arbitrary.py \
  pipelines/tests/test_pipeline.py \
  pipelines/governance/tests/test_write_gate.py \
  pipelines/governance/tests/test_write_gate_concurrency.py \
  pipelines/batch/tests/test_engine_governance.py \
  pipelines/batch/tests/test_engines.py

/opt/anaconda3/bin/python3.13 -m pytest -q tests/test_data_analysis_materialize.py

node --experimental-strip-types --test \
  examples/extensions/multimodal-artifact-poc/tests/data-analysis.test.mts \
  examples/extensions/multimodal-artifact-poc/tests/features.test.mts

/opt/anaconda3/bin/python3.13 -m py_compile \
  evaluation/phase2-retest/run_blind_retest.py
/opt/anaconda3/bin/python3.13 -m ruff check \
  evaluation/phase2-retest/run_blind_retest.py
git diff --check
npm run check
```

The 84 dataset-specific native CLI invocations, including absolute paths,
timestamps, exit codes, stdout, and stderr, are in
`artifacts/command-log.jsonl`.
