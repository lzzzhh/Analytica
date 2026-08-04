# Notes: Tool-Calling Evaluation at 92cb4346

## Coordination

- Source: `/Users/zhanhuilin/Documents/Analytica/COORDINATION_NOTICE.md`
- Required commit: `92cb4346ac5f0b4edc3eefcdcb81978e570fd220`
- Development Agent may work locally in `~/Documents/pi` but will not push during this evaluation.
- Evaluation writes only under this directory.

## Findings

- `origin/main` was independently verified as `92cb4346ac5f0b4edc3eefcdcb81978e570fd220`.
- Clean detached worktree: `/tmp/analytica-tool92.IH2rVI/checkout`.
- Diff from `5356473b`: seven files, including new `src/pipelines/delivery-tools.ts` and `tests/reviewer/phase16-delivery-tools.test.ts`.
- The user's local main checkout remains at `e7368b1d` with unrelated dirty/untracked files; none will be touched.
- Actual `all-enabled` registry probe: 22 public tools; effective feature hash `238202ebcc848449`.
- New public tools: `materialize_query`, `pipeline_ingest`, `write_gate_check`, `promote_analysis`.
- Specific Phase 16 regression: 10 tests passed, 0 failed.
- Scenario design remains 36 cases and passes `validate-design.mjs` with 22 public tools.
- Commit-dependent updates were made before any model call: `MT-02`, `MT-12`, `WF-04`, `WF-06`, `WF-09`, and `WF-12`.
- All 36 frozen cases were executed once through the public Pi JSON CLI with `openai/gpt-5.6-luna` at reasoning effort `max`.
- Final deterministic result: 17 PASS / 19 FAIL. No ABSTAIN, NOT_RUN, or INFRA_ERROR.
- Product blockers confirmed in WF-04 (analysis-to-reviewer store mismatch), WF-06 (bad promotion import), MT-12 (WriteGate mirror false negative), WF-05 (missing gateDecisionId), and WF-09 (ABSTAIN lookup gap).
