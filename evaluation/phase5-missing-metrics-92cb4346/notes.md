# Notes: Missing Metrics Evaluation at 92cb4346

## Scope

- Metric system source: `/Users/zhanhuilin/.codex/attachments/8071b743-6e4f-4bcf-b88b-1f7d8e0d35c1/pasted-text.txt`
- Product code remains read-only.
- Prior metric results must retain their original commit binding.

## Coverage Audit

- The table contains 26 metrics: 6 global, 6 tool-calling, 2 Requirement, 3 Multimodal, 2 Data Analysis, 4 Pipeline, 2 Reviewer, and 1 hard-gate metric.
- Nineteen business/tool metrics already have recorded measurements, but at different commits (`5356473b`, `fdaffc50` evaluation worktree state, and `92cb4346`). They remain separately commit-bound.
- Missing formal metrics: Task Success Rate, Consistency@3, Hallucination Rate, Correct Abstention Rate, Robustness Drop, Worst-Slice Accuracy, and Hard-Gate Violation Count/Rate.
- A new public-entrypoint suite covers six slices with two cases each: Requirement, Multimodal, Data Analysis, query tools, Reviewer, and safety/governance.
- Each case has three independent baseline runs plus one semantic perturbation run: 48 total task instances.

## Final Metrics

- Task Success Rate: 30/48 = 62.50%.
- Consistency@3: 7/12 = 58.33%.
- Hallucination Rate: 1/48 = 2.08%.
- Correct Abstention Rate: 12/12 = 100%.
- Robustness Drop: 8.33 percentage points.
- Worst-Slice Accuracy: 0% (Data Analysis).
- Hard-Gate Violations: 0/20.
