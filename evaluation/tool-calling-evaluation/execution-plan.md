# Tool-Calling Evaluation Execution Plan

## Frozen scope

- Product commit: `5356473b2746daff6007802584da3afd8dba6613`
- Runtime profile: `all-enabled`
- Effective feature hash recorded by the prior fixed-commit environment: `238202ebcc848449`
- Candidate target model: `openai/gpt-5.6-luna`, reasoning effort `max`
- Cases: 36 total, one frozen attempt each; infrastructure-only reruns are allowed and separately logged.
- Product code remains read-only. No graph redesign and no rerun of earlier business metrics.

## Preflight before the first model call

1. Create a fresh detached worktree at the frozen commit.
2. Link or build the exact Pi RPC runtime without changing tracked source; hash `rpc-entry.js`.
3. Record Node, absolute Python interpreter, Python packages, npm lock hash, Pi version, model/provider, and credential-presence booleans.
4. Resolve `all-enabled`, record its effective feature snapshot, and enumerate the 18 registered public tools from the extension itself.
5. Start an isolated Lakehouse Gateway backed by a fresh copy of the repository test warehouse fixture. Never point it at production or the Phase 2 warehouse.
6. Copy the five frozen tabular artifacts into an isolated ArtifactStore and verify their content hashes.
7. Generate and hash one deterministic chart PNG for `ST-08`.
8. Seed hash-valid Reviewer fixtures for `$STRICT_ARTIFACT`, `$NONE_GATE`, `$ABSTAIN_ARTIFACT`, and the DQ-failure branch. Record fixture-generation commands and hashes.
9. Replace all `$...` placeholders in an immutable run manifest. If any placeholder cannot be resolved, mark only affected cases `NOT_RUN` or `INFRA_ERROR`; do not weaken the oracle.
10. Hash the tool registry, scenarios, scoring contract, resolved run manifest, and all inputs. After this point they are read-only.

## Real-model execution

- Invoke Pi through its public RPC/CLI entrypoint with the POC extension; do not call tool implementations directly as the measured path.
- Start every case in a fresh session with only its `availableTools`, runtime features, inputs, and user task.
- Capture raw JSONL RPC events, assistant text, tool name, arguments, start/end time, tool output, error, artifact IDs, and final response.
- Preserve the complete trace. Redact credential values only; never redact tool arguments or results needed by the Oracle.
- A tool not present in the actual registry is unavailable. Calling an invented tool is a model `FAIL`.

## Deterministic scoring

1. Normalize each raw trace without changing values.
2. Resolve dynamic references only from preceding recorded tool results.
3. Score exact/multiset tool selection, leaf argument fields, dependencies, branches, call counts, and deterministic result assertions.
4. Apply `PASS/FAIL/ABSTAIN/NOT_RUN/INFRA_ERROR` before metric aggregation.
5. Produce the six metrics in `scoring-contract.json`, plus failure distributions by confused tool pair, argument field, and workflow stage.
6. Audit every failure against raw trace, tool output, and Oracle. Pi output cannot override the scorer.

## Known product-surface constraints

- Pipeline plan, materialization, WriteGate, Promotion Guard, and production publication are not registered public Agent tools at this commit.
- Therefore the full abstract chain in the DOCX cannot be reported as a successful public-tool workflow. `WF-03` and `WF-12` test safe stopping and non-fabrication; they do not pretend missing bridges exist.
- Feature-disabled tools disappear rather than returning stubs.
- `run_data_analysis` accepts trusted ArtifactStore references, not arbitrary paths, SQL, or parsed-document text.

## Confirmation gate

No batch model call begins until the user confirms the frozen 36-case design and execution plan.
