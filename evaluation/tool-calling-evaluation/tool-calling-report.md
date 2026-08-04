# Analytica Tool-Calling Evaluation Report — Design Gate

## Current result

The evaluation design is ready for confirmation. No batch model evaluation has run, so all metric values remain `NOT_RUN`.

## Bound version

- Commit: `5356473b2746daff6007802584da3afd8dba6613`
- Feature registry version: `1.0.0`
- Runtime profile: `all-enabled`
- Public tools: 18
- Proposed model: `openai/gpt-5.6-luna:max`

## Test set

| Layer | Cases | Primary metric(s) | State |
|---|---:|---|---|
| Single tool | 12 | Task Success, Argument Accuracy | NOT_RUN |
| Multi-tool | 12 | Tool Set F1, Task Success | NOT_RUN |
| Workflow | 12 | Workflow Success, Orchestration Accuracy | NOT_RUN |

The 36 cases cover normal paths, invalid IDs/fields, missing arguments, time boundaries, feature-off/unavailable tools, no-tool requests, similar-tool confusion, equivalent paths, duplicate/over-calls, partial failures, validated query execution, trusted-artifact analysis, Reviewer gating, STRICT/NONE branches, timeout stop, ABSTAIN, DQ failure, reuse, and governance bypass refusal.

## Registry finding

The DOCX's conceptual `Catalog -> QueryPlan -> Validate -> Execute -> Materialize -> Data Analysis -> ReviewGate -> Reviewer -> Promotion` chain is not fully exposed as public Agent tools at this commit. In particular, materialization, pipeline write, WriteGate, and Promotion are not registered tools. The evaluation therefore includes explicit safe-stop cases and will not report this abstract full chain as passing.

## Design verification

- `validate-design.mjs`: PASS
- Registered public tools counted: 18
- Cases counted: 36
- Required fields missing: 0
- Scenario JSON parse failures: 0

## Metrics

- Single-Tool Task Success Rate: NOT_RUN
- Argument Accuracy: NOT_RUN
- Tool Set F1: NOT_RUN
- Multi-Tool Task Success Rate: NOT_RUN
- Workflow Success Rate: NOT_RUN
- Orchestration Accuracy: NOT_RUN

Batch execution is intentionally paused at the confirmation gate required by the source specification.
