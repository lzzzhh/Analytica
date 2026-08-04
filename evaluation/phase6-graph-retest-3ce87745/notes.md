# Notes: Full Graph Retest at 3ce87745

## Baseline

- Candidate Commit: `3ce87745f9b1546a10ab7fd015dc543eec8bc7ba`
- Previous full coverage matrix: `evaluation/phase5-missing-metrics-92cb4346/coverage-matrix.json`
- Previous missing-metrics suite: Task Success 62.50%, Consistency@3 58.33%, Hallucination 2.08%, Correct Abstention 100%, Robustness Drop 8.33pp, Worst Slice Data Analysis 0%, Hard-Gate 0/20.

## Graph Architecture Audit

- Public graph tools: `run_analysis_graph` and `inspect_graph_run`; registered only when `round6.graph_tool` is effective.
- The public runner compiles one `analysis.run` task and always requests a formal report.
- Production wiring is real through preflight governance, Data Analysis, evidence resolution/freezing, ReviewGate, Reviewer replay, Promotion authorization and graph event persistence.
- The report adapter is intentionally unavailable and throws `REPORT_SKILL_UNAVAILABLE`; therefore the public formal-report path cannot currently reach `GRAPH_COMPLETED` even when analysis and review pass.
- The production-path test explicitly treats failure at `sys.analysis-report` as the expected fail-closed terminal. This proves the guard but not full business delivery.
- Multimodal and Pipeline remain outside the graph migration boundary and must be re-evaluated through their existing public paths.
- Recovery is event-chain based, graph-version aware and idempotency-keyed. Human authorization is external and cannot be self-approved by the executor.
- Graph runtime and host wiring contain dynamic imports despite the repository rule requiring top-level imports; record as a code-quality finding, not a business-metric failure unless it affects execution.
- Full-task latency Oracle: a run is eligible only if its required business assertions pass, required Artifact handoffs resolve, the governed review/promotion path passes where applicable, and the terminal system state is successful. Failed, abstained and infrastructure runs are timed separately and excluded from the successful-task mean.
