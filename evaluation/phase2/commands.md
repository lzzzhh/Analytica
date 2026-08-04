# Phase 2 Reproduction Commands

Run from `/Users/zhanhuilin/Documents/Analytica` unless a command contains an explicit `cd`.

```bash
/opt/anaconda3/bin/python3.13 evaluation/phase2/capture_environment.py

cd packages/coding-agent/examples/extensions/multimodal-artifact-poc
node --experimental-strip-types scripts/print-effective-features.mts --json > /Users/zhanhuilin/Documents/Analytica/evaluation/phase2/runtime-feature-snapshot.json
cd /Users/zhanhuilin/Documents/Analytica

curl -fL --retry 3 -o evaluation/phase2/downloads/Chinook_Sqlite.sqlite https://github.com/lerocha/chinook-database/releases/download/v1.4.5/Chinook_Sqlite.sqlite
curl -fL --retry 3 -o evaluation/phase2/downloads/bike-sharing-dataset.zip 'https://archive.ics.uci.edu/static/public/275/bike+sharing+dataset.zip'
curl -fL --retry 3 -o evaluation/phase2/downloads/Chinook-LICENSE.md https://raw.githubusercontent.com/lerocha/chinook-database/v1.4.5/LICENSE.md

/opt/anaconda3/bin/python3.13 -m py_compile evaluation/phase2/evaluation_pipeline.py evaluation/phase2/capture_environment.py
/opt/anaconda3/bin/python3.13 evaluation/phase2/evaluation_pipeline.py prepare
/opt/anaconda3/bin/python3.13 evaluation/phase2/evaluation_pipeline.py dry-run
/opt/anaconda3/bin/python3.13 evaluation/phase2/evaluation_pipeline.py run --label first
/opt/anaconda3/bin/python3.13 evaluation/phase2/evaluation_pipeline.py run --label rerun
/opt/anaconda3/bin/python3.13 evaluation/phase2/evaluation_pipeline.py validate
/opt/anaconda3/bin/python3.13 evaluation/phase2/evaluation_pipeline.py metrics

cd packages/coding-agent/examples/extensions/multimodal-artifact-poc
PIPELINE_TEST_ROOT=/Users/zhanhuilin/Documents/Analytica/evaluation/phase2/governance-bypass /opt/anaconda3/bin/python3.13 -m pipelines.run --mode batch --profile small --engine local --reset
PIPELINE_TEST_ROOT=/Users/zhanhuilin/Documents/Analytica/evaluation/phase2/governance-bypass /opt/anaconda3/bin/python3.13 -m pipelines.run --mode batch --profile small --engine local

# Initial governed Spark attempt: INFRA_ERROR because the worker selected Python 3.14.
PIPELINE_TEST_ROOT=/Users/zhanhuilin/Documents/Analytica/evaluation/phase2/governed-no-writegate PIPELINE_GOVERNANCE_ROOT=/Users/zhanhuilin/Documents/Analytica/evaluation/phase2/governed-no-writegate/governance /opt/anaconda3/bin/python3.13 -m pipelines.run --mode batch --profile small --engine spark --govern --reset

# Corrected environment-only retry.
PYSPARK_PYTHON=/opt/anaconda3/bin/python3.13 PYSPARK_DRIVER_PYTHON=/opt/anaconda3/bin/python3.13 PIPELINE_TEST_ROOT=/Users/zhanhuilin/Documents/Analytica/evaluation/phase2/governed-no-writegate PIPELINE_GOVERNANCE_ROOT=/Users/zhanhuilin/Documents/Analytica/evaluation/phase2/governed-no-writegate/governance /opt/anaconda3/bin/python3.13 -m pipelines.run --mode batch --profile small --engine spark --govern --reset
```

The first local CLI invocation completed successfully, but its shell wrapper attempted to assign zsh's read-only `status` variable after execution. The execution manifest was independently verified; subsequent wrappers used `exit_code`.
