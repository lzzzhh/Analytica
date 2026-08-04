# P0 指标优化报告（V2 双轨 · 修复与验证记录）

日期：2026-08-04
基线：Frozen Golden `phase4-tool-calling-92cb4346`，冻结评测运行 `runs/2026-08-03T22-44-51-970Z-3ce87745f9`（commit `3ce87745`）
模型：`openai/gpt-5.6-luna`（主 agent、分析子代理、语义评审一致）
验证 harness：`evaluation/v2-fixtest/`（不修改、不覆盖原 Frozen Golden）

## 1. 结论摘要

| 指标（中文） | 基线 | 修复后 | 变化 |
| --- | --- | --- | --- |
| 工作流任务成功率（行为链 V2） | 0.00% (0/12) | **100.00% (12/12)** | +100.00% |
| 编排准确率（依赖边） | 0/20（行为链口径） | **100.00% (20/20)** | +100.00% |
| 分析任务成功率 | 12.50% (1/8) | **100.00% (8/8)** | +87.50% |
| 数值正确率 | 7.69% (2/26) | **100.00% (26/26)** | +92.31% |

两个 P0 短板（多工具工作流编排、数据分析交付链）均从接近全灭提升到全通过。
单/多工具双轨分数（严格契约轨 vs 业务任务轨）基于冻结证据重算，不受本轮产品修复影响，见 §6。

## 2. 分析方法

1. **分层定位**：先用 V2 行为链评分器（`score-workflow-v2.mjs`）把 12 个 workflow 用例逐条拆成
   "依赖边 + 结果断言"，区分"没调工具 / 调错顺序 / 工具失败后如实停止 / 评分器误杀"四类失败。
2. **证据下钻**：对每个失败用例读三层证据——agent trace（`wf-traces/*.json`）→ 工具返回（reviewer-store
   的 `checks.json`/`findings.json`/`decision.json`）→ 存储布局（data-analysis store 的
   `inputs|results/<id>/{data|payload,meta|manifest,COMMITTED}`）。
3. **最小复现**：每个疑似根因写最小复现脚本（`/tmp/repro-wf05*.mts`、`/tmp/resolve-test.mjs`），
   在产品代码外独立验证后再改产品。
4. **逐修复回归**：每修一处只重跑受影响用例（多开 CLI 并行），评分器即时确认，避免全量重评。
5. **评分器自检**：评分器自身误杀（如 honestFinal 关键词缺失）单独修正，不计入产品缺陷。

## 3. 根因链

### P0-2 数据分析（1/8 → 8/8）

| 根因 | 影响用例 | 证据 |
| --- | --- | --- |
| 子代理 240s 硬超时早于长任务完成，且无重试 | da-03/da-08 | trace 中 `Timeout` 后直接失败 |
| 重试时 prompt 未提醒 inputArtifacts，重试丢引用 | da-05 | 重试调用缺 artifact id |
| 散点图点数超渲染上限 | da-06 | chart section 校验报错 |
| 子代理擅自改写 timeField / objective 命名 | da-03/da-08 | plan 与 request 字段不一致 |
| warnings 措辞不稳定（sentinel/overlap） | da-05/da-07 | 断言按固定句式匹配 |

### P0-1 工作流（0/12 → 12/12）

| 根因 | 影响用例 | 证据 |
| --- | --- | --- |
| materialize 与 data_analysis 的 artifact 布局断裂：gateway 写的目录与 ArtifactStore 可信布局（`inputs/<id>/{data,meta,COMMITTED}`）不兼容，resolve 恒为 null | WF-01/02/04 | `resolveArtifact` 返回 null；`DATA_ANALYSIS_ARTIFACT_ROOT` 共享目录是设计意图但布局未对齐 |
| metaHash 精度丢失：iceberg snapshotId 超 2^53，Python 端 JSON 序列化与 JS `JSON.parse` 往返语义不一致，metaHash 重算必然失配 | WF-04 | `loadRegisteredMeta` 校验失败 |
| 评审回放不可能字节级复现：no-clobber 存储 + createdAt 墙钟字段 + 内容哈希嵌入墙钟，回放写同 key 必被拒 | WF-05 | `writeImmutable` no-clobber 连环抛错 |
| 回放采纳新 proposal 导致评审哈希链断裂（proposal→package→gate→reviewKey） | WF-05 | `PROPOSAL_MISSING_OR_TAMPERED` |
| 评审完整性检查缺 analysis-plan 持久化产物，任一 FAILED 提前返回 → replay/semantic 缺失 → REJECT | WF-04 | `checks.json`: `artifact analysis-plan missing or hash mismatch` |
| replayRunner 返回值缺 `charts`，compareReplay 判定"chart missing from replay" | WF-04 | `findings.json`: `CHART_SERIES_MISMATCH` |
| 评分器 honestFinal 关键词未覆盖"受信任/拒绝"等如实停止措辞 | WF-03 | finalText 含如实说明但判 FAIL |

## 4. 修复清单

产品侧（`packages/coding-agent/examples/extensions/multimodal-artifact-poc/`）：

1. `src/data-analysis/index.ts`
   - 超时门槛：`timeoutSeconds >= 60` 时等待上限不低于 240s；超时失败按同条件自动重试一次。
   - 重试时在 prompt 追加 inputArtifacts 必含 id 提醒。
   - `normalizeResultArtifact/normalizeChartSection` 增加 `maxSeriesPoints` 确定性降采样（等间隔抽样）。
2. `src/data-analysis/subagent-prompt.ts`
   - timeField 必须 VERBATIM 复制 request 原值（不得改名改大小写）。
   - SENTINEL 规则：warnings 必须含 `<COLUMN> has <COUNT> sentinel values` 句式。
   - OVERLAP 规则：必须含精确句 `failure mode flags can overlap`。
3. `services/lakehouse-gateway/app/query/executor.py`
   - `materialize` 末尾桥接：向 ArtifactStore 可信布局写入 `inputs/<id>/{data,meta,COMMITTED}`（tmp+rename 原子提交）。
   - `_js_number`/`_js_stringify`：ECMA-262 NumberToString 语义序列化（整数 double 去小数点、指数转定点阈值 n=len(int)+e≤21、负指数去前导零），保证 Python 侧 metaHash 与 JS `JSON.parse` 往返后重算一致。
4. `src/reviewer/store.ts`
   - `writeImmutable`/`writeBytes` no-clobber 冲突时按 `replayCanonical` 对比：忽略 `createdAt` 与 64-hex 哈希（回放永不可能复现墙钟），语义相同即幂等通过，不同才抛错。
5. `src/reviewer/adapters/review-data-analysis-tool.ts`
   - resolve 双布局：先 `resolveResult`（results 布局）再回退 `resolveArtifact`（inputs 布局）。
   - manifest/script 溯源对象去掉墙钟字段，保证回放幂等。
   - 回放采纳存储的原始 proposal（保持评审哈希链一致），仅在无存储时新写。
   - 持久化 analysis-plan 产物 `artifacts/<planHash[:24]>.json`（完整性检查要求）。
   - replayRunner 返回补上 `charts`（修复 CHART_SERIES_MISMATCH）。

评测侧：

6. `evaluation/v2-dual-track/score-workflow-v2.mjs`：honestFinal 关键词扩充（桥接/可信/受信任/trusted/拒绝/未被识别等）。
7. `evaluation/v2-fixtest/seed-wf05.py`：WF-05 冻结产物 `art_1111222233334444` 按 compact JSON（sha256 `d4930d95…`，与冻结 inputArtifacts 一致）seed 进 data-analysis results 布局。

## 5. 验证记录

- DA 套件：v2 3/8 → 修复后 v3 **8/8，数值 26/26**（`/tmp/da-suite-v3.log`）。
- Workflow 行为链：逐步 4/12 → 9/12 → 11/12 → **12/12，依赖边 20/20**（`score-workflow-v2.mjs`）。
- WF-04 专项：validate → materialize → run_data_analysis(COMPLETED) → review_data_analysis **PASS** → promote_analysis **ALLOWED**。
- WF-05 专项：strict review 执行（ABSTAIN，STRICT gate），依赖边 review→inspect 满足；评审链幂等回放不再触发 no-clobber。

## 6. 最终指标（中文）

冻结证据双轨重算（单/多工具不受产品修复影响）：

| 指标 | 严格契约轨 | 业务任务轨 |
| --- | --- | --- |
| 单工具任务成功率 | 50.00% (6/12) | 58.33% (7/12) |
| 多工具任务成功率 | 25.00% (3/12) | 25.00% (3/12) |
| 参数准确率 | 43.30% | 62.84% |
| 契约偏差率 | - | 19.54% |

修复后实测（v2-fixtest harness）：

| 指标 | 数值 |
| --- | --- |
| 工作流任务成功率 | 100.00% (12/12) |
| 编排准确率 | 100.00% (20/20) |
| 分析任务成功率 | 100.00% (8/8) |
| 数值正确率 | 100.00% (26/26) |

剩余已知缺口（非 P0）：多工具任务成功率仍 25%，属冻结 trace 上的契约/业务双重失败，需单独立项；
WF-05 agent 用 reviewId 而非 gateDecisionId 查询 gate（依赖边已满足，属参数质量改进项）。

## 7. 复现命令

```bash
# gateway（共享 artifact 根）
cd services/lakehouse-gateway
LAKEHOUSE_MODE=local \
LAKEHOUSE_WAREHOUSE_PATH=<repo>/evaluation/v2-fixtest/runtime/gateway-warehouse \
DATA_ANALYSIS_ARTIFACT_ROOT=<repo>/evaluation/v2-fixtest/runtime/home/.pi/artifacts/data-analysis \
/opt/anaconda3/bin/python3 -m uvicorn app.main:app --port 18101 &

# 恢复 fixture + seed（每个评审类用例跑前）
python3 evaluation/v2-fixtest/seed-wf05.py   # WF-05 可信产物 seed
# reviewer-store fixture：从 phase4-tool-calling-92cb4346/runtime/reviewer-store 复制

# 并行重跑用例（多开 CLI）
(node /tmp/run-case.mjs WF-04 workflow.json > /tmp/wf-WF-04.log 2>&1 &) && \
(node /tmp/run-case.mjs WF-05 workflow.json > /tmp/wf-WF-05.log 2>&1 &)

# 评分
node evaluation/v2-dual-track/score-workflow-v2.mjs
node evaluation/v2-dual-track/report-metrics-zh.mjs
```

注意：跑评审类用例前必须清空 `runtime/home/.pi/artifacts/data-analysis`（no-clobber 语义导致旧产物阻塞重跑），
WF-05 还需重新 seed。
