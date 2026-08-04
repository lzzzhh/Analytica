# Analytica One-Click Evaluation

Run the complete frozen 28-metric evaluation from the repository root:

```bash
./evaluation/run-full-evaluation.sh
```

The command creates a new detached worktree and a new evidence directory under `evaluation/runs/`, runs the frozen Pipeline, Agent, tool-calling, global, graph, latency and token suites, then removes temporary services and the worktree. Product files are not modified.

`SIGINT` and `SIGTERM` are recorded as infrastructure interruptions; the active command, gateway and temporary worktree are cleaned before exit unless `--keep-worktree` is set.

Before spending model tokens, inspect the exact binding and stage order:

```bash
./evaluation/run-full-evaluation.sh --dry-run
```

Validate Python dependencies, detached-worktree setup, runner generation and syntax without calling models:

```bash
./evaluation/run-full-evaluation.sh --preflight
```

Use a specific Conda Python or output directory when needed:

```bash
./evaluation/run-full-evaluation.sh \
  --python /opt/anaconda3/bin/python \
  --output evaluation/runs/manual-$(git rev-parse --short HEAD)
```

Requirements:

- `OPENAI_API_KEY` is set; its value is never written to evidence.
- `node_modules` exists.
- `packages/coding-agent/dist/cli.js` and `rpc-entry.js` exist and match the checkout being evaluated.
- The selected Python provides PyIceberg, PySpark, pytest, FastAPI, Uvicorn, PyArrow, pandas and jsonschema.
- The chosen gateway port is unused.

Outputs include `run-state.json`, command logs, raw model traces, the 28-metric `coverage-matrix.json`, `latency.json`, `token-usage.json`, `summary.md` and `evidence-manifest.json`.

Process failures are recorded as `INFRA_ERROR`. Business failures remain in the deterministic metric artifacts and do not cause the orchestration process to rewrite Golden answers.
