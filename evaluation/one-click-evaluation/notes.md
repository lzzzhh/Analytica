# Notes: Analytica One-Click Evaluation

## Findings

- Phase-6 contains reusable runners and deterministic scorers, but they are hard-bound to the prior repository path, temporary worktree, Commit, design Hash and output directory.
- A fresh run must therefore generate an isolated copy of the runner scripts with only those bindings substituted; frozen scenario and scoring sources remain unchanged.
- The full dependency order is: freeze/environment -> isolated worktree -> Pipeline -> tool runtime -> gateway -> Agent suites -> tool suite -> global suite -> graph E2E -> latency/token/summary/hash.
- Tool and global model suites require a local Lakehouse Gateway on port 18101 and a fresh runtime warehouse.
- Model runs use an isolated HOME, so `OPENAI_API_KEY` must be present; the script must never record its value.
- Existing runners distinguish business failures through scored artifacts. A non-zero runner process, missing dependency, occupied gateway port or missing output is an infrastructure failure.
- Existing phase-6 runner output can be skipped because it is evidence bound to an older execution; every one-click invocation needs a new output directory.

## Implementation Decision

- Implement a small Node orchestration driver plus a shell entrypoint.
- Generate run-local copies of existing evaluation scripts, substituting only repository/worktree/Commit/design-hash bindings.
- Preserve all commands, stage timings and status in `run-state.json`; always clean the temporary gateway and worktree.
- Support `--dry-run` and `--help`. Full execution remains explicit through the named `run-full-evaluation.sh` entrypoint.
