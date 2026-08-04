# Phase 3 Agent Evaluation Report

## Conclusion

Phase 3 is complete, but Analytica is **not ready for an unqualified Agent-evaluation pass**.

Scope note: all four metric files were completed before a concurrent repair process created commit `e7368b1d47386ef4e586770859357f82ef679520` at 13:10:56+10:00. These results are bound to `fdaffc5` plus the recorded worktree hashes. They are not presented as verification of a clean checkout of the new HEAD; the frozen suite must be rerun for that claim.

- Multimodal is the only evaluated business Agent with strong end-to-end results.
- Requirement routes 75% correctly but does not preserve any of the 39 frozen structured requirement slots.
- Data Analysis reaches the intended route in all eight cases, but its product RPC path is wrong; no analysis artifact is produced.
- Reviewer has no public extension entrypoint. Its semantic adapter accepts all four clean cases but abstains on all six injected high-severity defects because its output contract requires a file location that analysis contexts cannot supply.

## 1. Bound environment

| Item | Frozen value |
|---|---|
| Repository Commit | `fdaffc50f2679505d6056966111156c40363aade` |
| Tracked product diff SHA-256 | `8aa17a855dde5ca4988b92a4420da468c8f989d87e3190ae0537b47f557ab443` |
| Changed product file manifest SHA-256 | `9a7e36b21ad04bdbc4a70637425232cef671b8427ad8dbbbee0a565b1ce2d04c` |
| Scenario standard SHA-256 | `cf4e2727193abe12621526289f035ea33ca4f87bd6de649cc8f4e244e041bf15` |
| Python | `/opt/anaconda3/bin/python3.13` (`3.13.5`) |
| Node | `v22.22.2` |
| Pi | `0.83.0` |
| Runtime profile | `all-enabled`, effective feature hash `238202ebcc848449` |
| Phase 2 dataset manifest SHA-256 | `0ff8d4c6dd4f08462ef3beeaf2b57197bfc78404651f7d871b88e0749c773cbe` |
| Phase 2 warehouse snapshot SHA-256 | `e1d67a429143a26d8b70bcb316aee7ff57045e5dc217523d550495db848fd9e1` |

Dependency versions and the complete model map are in `environment.json`. Credential values were never recorded.

## 2. Execution and metrics

### Requirement Agent

Executed 12 frozen requests through `runRequirementPlanning`, which is the deterministic core used by public tool `prepare_business_task`. Advisor output was disabled for the core metric so a broken local advisor endpoint could not make the route score nondeterministic.

| Metric | Result | Status |
|---|---:|---|
| Route Accuracy | 9/12 = **75.00%** | FAIL |
| Constraint Recall | 0/39 = **0.00%** | FAIL |
| Production advisor canary | `/v1/models` returned HTML, not a model API response | INFRA_ERROR |

Route failures:

- `req-01` and `req-02`: expected `DIRECT_EXECUTION`, got `NEEDS_CLARIFICATION`.
- `req-12`: executable-path request expected `CANNOT_PLAN`, got `NEEDS_CLARIFICATION`.

The 0% recall is not based on raw-text matching. The scorer only reads structured Requirement Card fields. `dimensions`, `outputRequirements`, `constraints`, and `successCriteria` are initialized as empty arrays in the analyzer, and user answers are stored as assumptions rather than populating those fields.

### Multimodal Agent

Executed four Phase 2-derived Markdown reports three times each through `orchestrateDocumentAnalysis`. All 12 calls completed with `deepseek-v4-flash`; no L2 escalation occurred.

| Metric | Result | Status |
|---|---:|---|
| pass@1 | 3/4 = **75.00%** | PASS |
| pass@3 | 4/4 = **100.00%** | PASS |
| Structured Extraction Precision | 35/36 = **97.22%** | PASS |
| Structured Extraction Recall | 35/36 = **97.22%** | PASS |
| Structured Extraction F1 | **97.22%** | PASS |

The sole first-attempt failure was `mm-02`: the model emitted the correct value under label `总体平均质量`, while the frozen alias set expected `平均 quality`/`mean quality`/`quality 均值`. Under the pre-frozen exact normalized pair contract this is one FP plus one FN. It is a scoring-contract miss, not a wrong number, and pass@3 recovered on attempts 2–3.

### Data Analysis Agent

Hash-verified Phase 2 CSVs for AI4I, Wine Quality, Appliances Energy, Seoul Bike, and Air Quality were registered into an isolated evaluation ArtifactStore with their Phase 2 snapshot IDs. Eight frozen tasks covered all requested analysis categories.

| Metric | Result | Status |
|---|---:|---|
| Analysis Task Success Rate | 0/8 = **0.00%** | FAIL |
| Numerical Correctness | 0/26 = **0.00%** | FAIL |
| Intended subagent route | 8/8 | PASS |
| Completed analysis artifacts | 0/8 | FAIL |

All eight runs fail identically before model execution. `createDataAnalysisSubagentCaller` resolves `../../../../dist/rpc-entry.js` from its source directory to the nonexistent `packages/coding-agent/examples/dist/rpc-entry.js`. The built entrypoint exists at `packages/coding-agent/dist/rpc-entry.js`. The product maps the process error to `SCRIPT_SYNTAX_ERROR`, which is also a misleading failure classification.

This is treated as a product functional failure rather than an external infrastructure failure: the required compiled entrypoint exists, but the checked-in product code addresses the wrong location. No product code was altered to bypass it.

### Reviewer Guardrails

The extension public entrypoint does not import or register the Reviewer tools, so public Reviewer evaluation is `NOT_RUN`. The underlying semantic adapter was independently invoked for 6 injected high-severity defects and 4 clean cases with `openai/gpt-5.6-luna`.

| Metric | Result | Status |
|---|---:|---|
| Public Reviewer entrypoint | unavailable | NOT_RUN |
| High-Severity Defect Recall | no valid denominator; 0/6 positive cases executable | ABSTAIN |
| Reviewer False Positive Rate | 0/4 = **0.00%** | PASS |

All six positive responses were rejected with `HIGH/BLOCKER finding must carry a location with a file`. The analysis semantic input schema contains no file location, while the parser requires one for HIGH/BLOCKER findings. Because the findings were rejected and raw model replies are not returned by the adapter, counting them as missed defects would invent evidence; recall therefore remains `ABSTAIN`.

## 3. Evidence used

- Frozen scenario and Golden files under `scenarios/`.
- Per-run immutable JSON under `results/requirement`, `results/multimodal`, `results/data-analysis`, and `results/reviewer`.
- Deterministic metric outputs in each Agent's `metrics.json`.
- Phase 2 source manifest, source hashes, profiles, and warehouse snapshot.
- Product code locations cited in Findings below.
- `evidence-manifest.json`, containing SHA-256 and byte size for every evaluation file.

## 4. Findings

1. **Data Analysis is completely blocked by a wrong RPC entrypoint path.** Evidence: `src/data-analysis/subagent.ts:24` and every `results/data-analysis/da-*.json`. Impact: all eight business categories fail, no numerical result or immutable analysis artifact exists.
2. **Reviewer is not exposed through the product extension.** Evidence: `index.ts:36-41` imports Requirement/Data Analysis/Governance only, and `index.ts:650-742` registers no Reviewer tool. Impact: formal delivery cannot reach the designed ReviewGate/Reviewer path.
3. **Reviewer positive analysis findings are structurally unparseable.** Evidence: `src/reviewer/adapters/pi-reviewer.ts:85-93` has no file field for analysis contexts, while lines 127-128 require `location.file` for HIGH/BLOCKER. Impact: all six injected severe defects abstain.
4. **Requirement Card extraction drops business constraints and output contracts.** Evidence: `src/requirement-planning/requirement-analyzer.ts:120-141`; deterministic metric is 0/39. Impact: downstream Agents receive plans that omit denominators, read-only rules, Top-N ordering, non-causality, and required delivery form.
5. **Requirement executable-input rejection is too narrow.** Evidence: forbidden patterns at `src/requirement-planning/contracts.ts:484-496` do not reject an instruction to read and execute `/tmp/run.py`; `req-12` returns clarification instead of rejection.
6. **Requirement production advisor endpoint is misbound in this environment.** The configured `http://127.0.0.1:8080/v1/models` returns Open WebUI HTML. Deterministic core scores remain valid, but advisor-backed routing was not credibly evaluated.
7. **Multimodal exact label normalization is brittle across Chinese/English synonyms.** One correct numeric extraction is scored as an FP/FN pair under the frozen alias contract. The reported metric is reproducible, but future evaluation should freeze canonical field IDs rather than free-form claim labels.

## 5. Commands executed

```text
git status --short
git rev-parse HEAD
/opt/anaconda3/bin/python3.13 -m json.tool <each scenario/result JSON>
find evaluation/phase3-agent-evaluation/scenarios ... | shasum -a 256
./node_modules/.bin/tsx evaluation/phase3-agent-evaluation/run_requirement.mts
./node_modules/.bin/tsx evaluation/phase3-agent-evaluation/run_multimodal.mts
./node_modules/.bin/tsx evaluation/phase3-agent-evaluation/run_data_analysis.mts
./node_modules/.bin/tsx evaluation/phase3-agent-evaluation/rescore_data_analysis.mts
./node_modules/.bin/tsx evaluation/phase3-agent-evaluation/run_reviewer.mts
curl --max-time 5 http://127.0.0.1:8080/v1/models
./node_modules/.bin/tsx evaluation/phase3-agent-evaluation/build_evidence_manifest.mts
```

## 6. Next-stage recommendation

Do not use the current Data Analysis or Reviewer results as evidence of formal-delivery readiness. After Analytica independently repairs the defects, rerun this frozen package without changing Golden values. Priority order:

1. Correct and test Data Analysis RPC path resolution; preserve the original process error instead of rewriting it as `SCRIPT_SYNTAX_ERROR`.
2. Register Reviewer tools in the extension's public feature-gated entrypoint.
3. Align Reviewer analysis prompt/schema/parser around a valid non-file evidence location, then rerun all 10 guardrail cases.
4. Populate Requirement Card structured fields from the request and confirmed answers, and expand the executable-input safety gate.
5. Rebind Requirement advisor to a verified OpenAI-compatible inference endpoint.

Multimodal may proceed to broader robustness testing. Requirement, Data Analysis, and Reviewer require repair and frozen-suite retesting first.
