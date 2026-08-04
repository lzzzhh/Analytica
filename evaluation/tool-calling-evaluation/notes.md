# Tool-Calling Evaluation Notes

## Source

- `/Users/zhanhuilin/Downloads/Analytica 工具调用能力评测.docx`

## Extracted Contract

- Three layers with at least ten cases each: single-tool use, multi-tool selection, and dependent orchestration.
- Single-tool metrics: task success and argument accuracy.
- Multi-tool metrics: Tool Set F1 and task success.
- Workflow metrics: workflow success and orchestration accuracy.
- Required coverage includes missing/invalid arguments, unavailable tools, feature on/off, no-tool tasks, similar-tool confusion, equivalent tool sets, partial failure, duplicate calls, conditional stop/retry, strict/none review, ABSTAIN, DQ failure, and cache/idempotency.
- Every case contains the fourteen required fields from the DOCX.
- Status vocabulary is fixed to PASS, FAIL, ABSTAIN, NOT_RUN, and INFRA_ERROR.
- Design and execution are separate: batch real-model runs begin only after the test set is confirmed.

## Product Registry at 5356473b

- 18 public registered tools under `all-enabled`.
- 5 Multimodal/document tools, 8 Lakehouse/CDXR tools, Requirement Planning, Data Analysis, Governance Dashboard, Review Gate inspection, and analysis Reviewer.
- Pipeline writes remain CLI/E2E-only.
- Legacy governance tool implementations are not in the public registration map.

## Frozen Design

- 12 single-tool cases: `ST-01`–`ST-12`.
- 12 multi-tool cases: `MT-01`–`MT-12`.
- 12 workflow cases: `WF-01`–`WF-12`.
- All scenario files pass `validate-design.mjs`.
- Proposed measured model: `openai/gpt-5.6-luna:max`, one attempt per case; only confirmed infrastructure failures may be rerun.

## Execution Blockers to Resolve in Preflight

- Generate and hash the actual effective feature snapshot; do not use the stale tracked build snapshot.
- Provide a fixed-commit Pi RPC runtime because `dist/rpc-entry.js` is gitignored.
- Start an isolated test Lakehouse Gateway and freeze its catalog/snapshot IDs.
- Seed deterministic Reviewer/gate and DQ-failure fixtures for conditional workflows.
- Generate and hash the chart image used by `ST-08`.
