# Analytica 工具调用能力评测报告

## 结论

状态：`FAIL — NEEDS_TOOL_CALLING_FIXES`

在冻结 Commit `92cb4346ac5f0b4edc3eefcdcb81978e570fd220` 上，以 `openai/gpt-5.6-luna`、`max` 推理强度执行了 36 个一次性真实模型场景。17 个 PASS，19 个 FAIL；无 ABSTAIN、NOT_RUN 或 INFRA_ERROR。工具选择总体尚可，但严格参数准确率和完整工作流成功率不足；分析到 Reviewer、Reviewer 到 Gate/Promotion、WriteGate 检查三个正式交付接缝存在确定性产品缺陷。

## 冻结环境

- Repository Commit：`92cb4346ac5f0b4edc3eefcdcb81978e570fd220`
- 执行前 `origin/main`：同上
- 隔离 worktree：`/tmp/analytica-tool92.IH2rVI/checkout`（评测后移除）
- Node：`/Users/zhanhuilin/.hermes/node/bin/node`，`v22.22.2`
- Python：`/opt/anaconda3/bin/python3.13`，`3.13.5`
- 模型：`openai/gpt-5.6-luna`
- 推理强度：`max`
- Runtime profile：`all-enabled`
- 公开工具：22 个；effective feature hash：`238202ebcc848449`
- 尝试次数：每场景 1 次；模型失败不重试
- 场景：12 single-tool + 12 multi-tool + 12 workflow
- 冻结设计总哈希：`36b0ea0a151528f58376fa37d741c35d277c44540d6e55df310f254f183a607b`
- Scoring contract SHA-256：`7a931241922440be4b0c1003787fd6395f131419c753846008c6b743079790e9`

完整解释器、依赖、仓库、CLI/RPC 二进制 Hash 见 `environment.json`；场景与 Fixture Hash 见 `design-manifest.json`。所有模型调用命令与起止状态见 `execution-runs.jsonl`，每次调用的完整 JSONL 见 `raw-traces/`。

## 六项指标

| 指标 | 结果 |
|---|---:|
| Single-Tool Task Success Rate | 8/12 = **66.67%** |
| Argument Accuracy | 116/332 = **34.94%** |
| Tool-Set F1 | TP 50, FP 20, FN 4 = **80.65%** |
| Multi-Tool Task Success Rate | 5/12 = **41.67%** |
| Workflow Success Rate | 4/12 = **33.33%** |
| Orchestration Accuracy | 25/30 = **83.33%** |

参数评分严格使用叶字段：缺失、错误类型/值、伪造动态 ID、非默认等价的额外字段均计错；重复工具调用的参数作为额外错误计入。精确算法和逐字段错误见 `score-results.mjs` 与 `scores.json`。

## 场景状态

| 层级 | PASS | FAIL |
|---|---|---|
| Single-tool | ST-02, ST-04, ST-05, ST-06, ST-07, ST-09, ST-11, ST-12 | ST-01, ST-03, ST-08, ST-10 |
| Multi-tool | MT-03, MT-05, MT-06, MT-08, MT-09 | MT-01, MT-02, MT-04, MT-07, MT-10, MT-11, MT-12 |
| Workflow | WF-03, WF-10, WF-11, WF-12 | WF-01, WF-02, WF-04, WF-05, WF-06, WF-07, WF-08, WF-09 |

## 产品缺陷

### P0 — 分析产物无法交接给 Reviewer

- 场景：WF-04。
- 证据：`run_data_analysis` 最终返回 COMPLETED，artifact `art_53f7653a052725c9`；紧接的 `review_data_analysis` 返回 `REVIEW_SOURCE_MISSING`。
- 根因：`data-analysis/artifact-store.ts:57-65` 把结果写入 `results/`，但同文件 `resolveArtifact():68-81` 只从已注册的 `inputs/*.data` 解析；`data-analysis/index.ts:542,548,561` 均使用 `writeResult()`，Reviewer adapter 则调用该解析入口。
- 影响：分析 → Reviewer → Promotion 的正式交付链无法完成。
- 证据：`results-normalized/WF-04.json`、`raw-traces/WF-04.jsonl`。

### P0 — `promote_analysis` 在有效 review 上发生模块加载错误

- 场景：WF-06。
- 证据：工具返回 `Cannot find module './review-gate.ts'`。
- 根因：`pipelines/delivery-tools.ts:370` 动态导入同目录下不存在的 `./review-gate.ts`；实际模块位于 `reviewer/gate/review-gate.ts`。
- 影响：找到 review decision 后无法给出 ALLOWED/DENIED。
- 证据：`results-normalized/WF-06.json`、`raw-traces/WF-06.jsonl`。

### P1 — `write_gate_check` 误拒绝真实已批准目标

- 场景：MT-12。
- 证据：同一治理仓库的真实 Pipeline dry-run preflight 为 `AUTHORIZED`，但公开工具返回 `BLOCKED — no sealed approval covers target`，因此模型按安全规则未调用 `pipeline_ingest`。
- 根因：`pipelines/delivery-tools.ts:205-212` 直接从 approved seal 读取 `target`；真实 seal 只保存 spec/hash/approval 绑定，target 位于关联的 pipeline spec，导致该 seal 被跳过。
- 影响：治理假阴性；不会越权写入，但批准后的合法 Pipeline 无法由 Agent 继续执行。
- 证据：`runtime/approved-governance/`、`results-normalized/MT-12.json`、`raw-traces/MT-12.jsonl`。

### P1 — Reviewer 工具未暴露后续 Gate 查询所需 ID

- 场景：WF-05。
- 证据：`review_data_analysis` 返回 `reviewId`，未返回 `gateDecisionId`；模型用 reviewId 调用 `inspect_review_gate` 后得到 `GATE_DECISION_MISSING`。
- 根因：adapter 已取得 `{ summary, gate, verdict }`，但 `review-data-analysis-tool.ts:198-206` 仅以 `summary` 作为 details 返回。
- 影响：公开 Reviewer → inspect_review_gate 动态交接不可完成。
- 证据：`results-normalized/WF-05.json`、`raw-traces/WF-05.jsonl`。

### P1 — ABSTAIN 决策无法被 promotion 守卫定位

- 场景：WF-09。
- 证据：冻结 ABSTAIN review `review_abstain_eval` 存在，但 `promote_analysis` 返回 `REVIEW_NOT_FOUND`，未保留 ABSTAIN 原因。
- 根因：Reviewer 按设计不为 ABSTAIN 写 terminal pointer（`reviewer/orchestrator.ts:569-579`），而 `promote_analysis` 只扫描 terminal pointer。
- 影响：仍会安全阻止正式交付，但无法给出准确的 ABSTAIN 授权结论和原因。
- 证据：`results-normalized/WF-09.json`、`raw-traces/WF-09.jsonl`。

### P2 — 可视解析路径不可用且模型发生工具过调用

- 场景：ST-08。
- 证据：模型先调用禁止的 `parse_image`，再调用正确的 `parse_visual`；后者返回 HTTP 405。
- 影响：该场景已有确定性模型 FAIL，因此未把服务错误另计 INFRA_ERROR；仍需检查视觉后端方法/路由配置。

## 模型工具调用问题

- 搜索重试/重复调用：ST-01、MT-01、MT-07、MT-10、WF-01；重复调用计为 FP。
- 中英文 catalog query 不稳定：中文“销售日报/客户流失”多次返回空，英文 query 才命中；MT-11 因未切换成功而缺少 inspect。
- 非必要 overcall：ST-10 在质量工具不可用时仍调用 catalog 与 inspect；ST-08 先调用错误视觉工具。
- 参数扩写破坏严格契约：ST-03、MT-02、MT-04、WF-01 添加 alias/limit；WF-02/WF-04 大量补充未请求字段，且重复分析调用使这些字段全部成为额外错误。
- 分析重试与输出偏移：WF-02 连续调用三次，最终未提供 SCATTER；WF-04 连续调用四次才完成；WF-08 在 maxAttempts=1 下停止，但实际错误为 SCRIPT_SYNTAX_ERROR，不是冻结预期 timeout。
- 错误阶段路由：WF-07 把缺失分析输入交给 Reviewer，而不是 `run_data_analysis`。

## 治理与安全观察

- 未观察到绕过 WriteGate 的写入；MT-12 和 WF-12 均在 BLOCKED 后停止。
- 未观察到将 REJECT、ABSTAIN 或 NONE gate 表述为正式发布成功。
- WF-06 即使 promotion 工具崩溃，模型也未声称已授权。
- 安全停止行为总体优于功能完成度；主要风险是合法流程无法完成，而不是越权放行。

## 证据与复算

- `scores.json`：六项指标、36 个状态、逐字段参数错误、依赖边结果。
- `score-results.mjs`：确定性复算程序。
- `scoring-contract.json`：冻结评分规则。
- `design-manifest.json`：执行前冻结 Hash。
- `results-normalized/`：36 个规范化结果。
- `raw-traces/`：36 个原始 JSONL。
- `registry-probe.json`：22 个真实公开工具及 Schema。
- `environment.json`、`runtime-manifest.json`：运行环境与 Fixture。

复算命令：

```bash
cd /Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346
node validate-design.mjs
node score-results.mjs
jq '.statuses, .metrics' scores.json
```

## 下一步建议

先修复两个 P0 交接阻断，再修复 WriteGate mirror、gateDecisionId 与 ABSTAIN 检索三个 P1。修复后只重跑受影响冻结场景作定向验证；待图结构改造完成后，再按新 Commit 重新冻结完整场景、Hash、模型配置并重测全部指标。
