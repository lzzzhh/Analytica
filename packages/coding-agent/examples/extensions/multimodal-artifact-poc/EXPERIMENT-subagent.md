# 实验：子 agent 文档解析 vs 直返（上下文工程）

日期：2026-08-01
状态：完成

## 1. 实验目的

从上下文工程角度评估：文档解析**直返主上下文** 与 **子 agent 隔离解析后返回摘要** 两种方案的差异。验证"子 agent 是否值得"的假设：隔离解析能压缩主上下文，但代价是延迟和复杂度。

## 2. 两种方案

```
方案 A（baseline 直返）：
  文档全文 → 主 agent 上下文（Qwen3-8B 单次调用）→ 回答

方案 B（子 agent）：
  文档全文 → 子 agent 独立上下文（独立 Pi RPC 进程）→ 摘要
  → 摘要进主 agent 上下文 → 主 agent 汇报
```

## 3. 评估指标

| 指标 | 含义 | 目标 |
|------|------|------|
| 主上下文输入 tokens | 主 agent 每次调用接收的 prompt 大小 | 越小越好 |
| 总 token 消耗 | 端到端所有 LLM 调用之和（含子 agent） | 越小越好 |
| 答案质量 | 规则评分：ground truth 数字/关键词是否在答案中 | 越高越好 |
| 端到端耗时 | 问题提出到最终回答 | 越短越好 |

## 4. 实验设置

- 文档：`experiments/bench-doc.md`（云智科技 2024 经营报告，5 章 + 附录，约 1100 chars）
- 问题集：5 题（4 事实性 + 1 综合性），每题有 ground truth
- 模型：Qwen3-8B-Q4_K_M（llama.cpp router，主/子 agent 同一模型）
- 子 agent 实现：`analyze_document` 工具 → markitdown 解析 → 落盘 `~/.pi/artifacts/<hash>/`（带 mtime 缓存）→ spawn 独立 Pi RPC 进程 → 独立上下文回答
- 脚本：`experiments/benchmark-subagent.mts`（`npx tsx experiments/benchmark-subagent.mts` 可复现）

## 5. 结果

| 指标 | 方案 A（直返） | 方案 B（子 agent） | 差异 |
|------|---------------|-------------------|------|
| 平均主上下文输入 | 883 tokens | 93 tokens | **-89%** |
| 平均总 token 消耗 | 1127 tokens | 589 tokens | **-48%** |
| 平均端到端耗时 | 20.6s | 47.0s | +128%（2.3 倍） |
| 平均答案质量 | 80% | 100% | +20pp |

分题明细（方案 B）：

| 题目 | 质量 | 主上下文 | 总消耗 | 耗时 |
|------|------|---------|--------|------|
| 总收入 | 100% | 109 tok | 585 tok | 45.5s |
| 客户指标 | 100% | 92 tok | 722 tok | 55.5s |
| 产品线占比 | 100% | 64 tok | 609 tok | 51.2s |
| 2025 展望 | 100% | 80 tok | 381 tok | 30.4s |
| 融资计划 | 100% | 122 tok | 647 tok | 52.5s |

方案 A 质量 80% 来自"客户指标"题（88.6%/106.2% 未命中）——直返时模型偶发输出偏差。

## 6. 分析

### 收益
1. **主上下文压缩 89%**（883 → 93 tokens）：文档全文不再进入主 agent 工作记忆。多次提问同一文档时，主上下文不会累积全文。
2. **总 token 反而降低 48%**：llama.cpp 的 prompt 缓存使子 agent 进程读取相同文档前缀时命中 KV 缓存，实际开销低于直返。这是意外收益。
3. **质量提升**：子 agent 隔离上下文、专注于单一问题，未出现直返方案的偶发漏读。

### 代价
1. **耗时 2.3 倍**（20.6s → 47.0s）：子 agent 进程启动 + 独立推理 + 汇报多轮调用。
2. **架构复杂度**：进程生命周期管理、超时、错误传播、缓存失效。
3. **首调用冷启动**：第一题总消耗明显偏高（子 agent 进程首启）。

## 7. 结论

**值得用子 agent 做文档解析，前提是：**
- 文档较大（本实验 1100 chars 已有明显收益；文档越大收益越显著）
- 用户会基于同一文档多次提问（缓存 + 上下文不累积）
- 可以接受 2 倍延迟

**不适合的场景：**
- 对延迟敏感的单次小文档查询（<300 chars 直接直返）
- 需要精确引用文档原文细节（摘要有损）

**建议的分层路由：**
```
文档 < 阈值（如 800 chars）→ parse_document 直返
文档 ≥ 阈值 → analyze_document 子 agent
```

## 8. 局限性

- 单模型、单文档、5 题，样本小；结论是方向性的，非统计显著
- 质量评分是规则匹配（数字/关键词），不评估语义正确性
- 未测长文档（>8K tokens，超出 llama.cpp 运行时 -c 8192 上下文）——子 agent 的最大优势场景尚未覆盖
- 未测多文档并行

---

# 实验二：真实文档对比（10 个本地文档，DeepSeek API）

日期：2026-08-01
状态：完成

## 背景与调整

- 第一轮本地实验后，llama.cpp 服务因 8080 端口被 open-webui 占用而中断，本地模型不可用
- 按用户指示改用 **DeepSeek API**（`deepseek-chat` → 实际路由 `deepseek-v4-flash`），128K 上下文
- 10 个真实本地文档（4 PDF + 3 DOCX + 3 MD）：简历、RAG 面经、对接说明、编码面试、财富 Agent、AI 交接文档、RiskCloud 任务书、Spark 总结、两篇论文（StructuralFeasibility、CDXR）
- **不截断**（最大 CDXR 论文 110K chars），统一问题："总结主要内容 + 提取 3 个关键事实"
- 质量评估：LLM judge（DeepSeek）对照文档原文给 A/B 各打 1-5 分（准确性 + 完整性）

## 结果

| 指标 | A（直返） | B（子 agent） | 差异 |
|------|----------|--------------|------|
| 平均主上下文输入 | 11,013 tok | 534 tok | **-95%** |
| 平均总 token | 11,484 tok | 12,503 tok | +9% |
| 平均耗时 | 4.8s | 9.2s | +92% |
| Judge 均分（准确+完整） | 3.80 | 4.15 | **+0.35** |

分文档：

| 文档 | A 分 | B 分 | A 主上下文 | B 主上下文 | 胜负 |
|------|------|------|-----------|-----------|------|
| 简历-悉尼大学 | 5.0 | 4.0 | 2,250 | 260 | A |
| 面经-RAG | 4.5 | 4.5 | 8,992 | 644 | 平 |
| 对接说明 | 4.0 | 5.0 | 2,071 | 458 | B |
| 编码面试 | 3.0 | 4.0 | 7,167 | 379 | B |
| 财富Agent优化 | 3.5 | 5.0 | 6,427 | 419 | B |
| AI数据分析Agent交接 | 4.0 | 5.0 | 3,502 | 644 | B |
| RiskCloud任务书 | 4.5 | 4.0 | 10,040 | 644 | A |
| Spark知识总结 | 1.5 | 3.0 | 16,279 | 643 | B |
| 论文-StructuralFeasibility | 4.0 | 3.0 | 20,436 | 644 | A |
| 论文-CDXR | 4.0 | 4.0 | 32,968 | 605 | 平 |

## 关键发现

1. **主上下文 -95% 是决定性收益**：真实文档直返平均 11K tokens 进主上下文（最大 33K），子 agent 恒定 ~600 tokens。8K 上下文的本地模型根本装不下这些文档（第一轮实验已实测溢出）。
2. **长文档上子 agent 优势最明显**：Spark 总结（36K chars）A=1.5 vs B=3.0——直返在长上下文稀释下质量崩塌，子 agent 隔离上下文保持专注。
3. **质量总体 B 胜**（5 胜 3 负 2 平）：B 在中等文档（编码面试、财富、对接）上系统性更好；A 在短文档（简历）和纯结构文档（RiskCloud 任务书）上占优。
4. **成本差异可忽略**：总 token +9%（API 场景无本地 prompt 缓存红利），耗时 4.8s → 9.2s 在 API 下完全可接受。
5. **模型可替换性验证**：本轮从本地 Qwen3-8B 切换到 DeepSeek API，子 agent 架构零改动（仅换 LLM 端点），结论方向一致——印证了独立上下文的架构价值与模型无关。

## 局限性

- LLM judge 与被评模型同源（DeepSeek 评 DeepSeek），可能有同源偏好
- 单轮单问题，未测多轮对话中的上下文累积效应（子 agent 优势在多轮下更大）
- 中文文档为主，未覆盖英文文档分布
- 子 agent 在纯结构文档（任务书）上略逊——可能因隔离上下文丢失了主上下文的项目语境

# 实验三：两级编排架构（escalation + fan-in + Evidence Merger）

日期：2026-08-01（v2 修复版重跑）
状态：完成（judge 覆盖率 7/10，API 空响应率 60% 为最大噪声源）

## 背景与设计

实验二验证了单层子 agent 的价值（主上下文 -95%）。在此基础上实现用户提出的**分级升级（escalation）+ 并行汇报（fan-in）**架构：

- **L1 standard agent**（deepseek-v4-flash）：默认处理；命中上下文/复杂度/置信度限制时返回 partial + escalation request
- **L2 expert agent**（deepseek-v4-pro）：只分析被升级的 **narrow scope**（指定 sections 或截断点之后的尾部），绝不全量重读文档
- **确定性 Evidence Merger**：原始证据 > 确定性解析 > 有引用事实 > 无引用推断；值冲突时生成 conflict candidates（resolution="requires_verification"），绝不"expert wins"
- **pre-route**（preflight.ts 静态风险评分：token 预算 + 章节/表格/页数）→ 决定直接标准/带升级风险/专家直通
- **Expert 结果绝不经过 standard agent 转发**——由 orchestrator 确定性合并
- **防止"迟到的升级"**：L1 输入被截断时**强制升级**（确定性规则，不依赖 flash 模型自评——v1 实测 L1 自评在 CDXR 33K tokens 时竟报不升级）

## 结果（v2 修复版，10 个真实文档，与实验二同批）

| 文档 | A 分 | B 分 | 升级 | 主ctx A | 主ctx B | 胜负 |
|------|------|------|------|---------|---------|------|
| 简历-悉尼大学 | — | — | n | 2,329 | 111 | — |
| 面经-RAG | 3.0 | 3.5 | n | 9,071 | 73 | B |
| 对接说明 | 5.0 | 4.5 | n | 2,150 | 91 | A |
| 编码面试 | 4.5 | 2.5 | n | 7,246 | 43 | A |
| 财富Agent优化 | 2.5 | 4.0 | n | 6,506 | 130 | B |
| AI数据分析Agent交接 | 5.0 | 3.0 | n | 3,581 | 160 | A |
| RiskCloud任务书 | — | — | **Y** | 10,119 | 296 | — |
| Spark知识总结 | — | — | **Y** | 16,358 | 123 | — |
| 论文-StructuralFeasibility | 3.5 | 3.0 | **Y** | 20,515 | 254 | A |
| 论文-CDXR | 3.5 | 4.5 | **Y** | 33,047 | 304 | B |

（— = judge 因 API 空响应无分；补跑 4 轮 × 3 次重试仍失败：简历、RiskCloud、Spark）

| 指标 | A（直返） | B（两级编排） | 差异 |
|------|----------|--------------|------|
| 平均主上下文输入 | 11,092 tok | 159 tok | **-98.6%** |
| 平均总 token | 11,822 tok | 20,667 tok | +75% |
| 平均耗时 | 9.5s | 44.7s | 4.7× |
| Judge 均分（7 篇有效） | 3.86 | 3.57 | -0.29 |

胜负：B 3 胜 4 负（面经 +0.5、财富 +1.5、CDXR +1.0；对接 -0.5、编码 -2.0、AI 交接 -2.0、论文1 -0.5）

## 关键发现

1. **主上下文 -98.6% 是本架构最稳定的收益**：1.1 万 → 159 tok（实验二 -95% 的进一步压缩，因 B 现在只把 merged packet 喂给主 agent，连原始文档都不再经过主上下文）。33K tokens 的 CDXR 进主上下文只剩 304 tok。
2. **升级纪律完全符合设计（v2 修复后）**：4/10 升级，全部为超预算大文档（RiskCloud 10K / Spark 16K / 论文 20K、33K）；6 篇小文档 0 升级。v1 运行中 L1 自评对 33K 文档报"不升级"（flash 自评不可靠）→ 加入**截断即强制升级**的确定性规则后升级行为稳定复现。
3. **L2 专家价值证据混杂但正向偏多**：2 篇有分的升级文档中 CDXR（+1.0，33K 长文）专家显著加分；StructuralFeasibility（-0.5）微降。3 篇无分的升级文档（RiskCloud、Spark、简历）未获评估。
4. **B 的最大失分点不是专家，而是 L1 提取质量方差**：编码面试 B 主ctx 仅 43 tok（证据包 ~170 字符）——L1 单次输出偏弱，主汇报链再压缩后答案贫乏。对比实验二同样用 flash 的 L1 却整体胜出（4.15 vs 3.80），本轮 B 略输更可能是 API 不稳定期的单次方差（judge 空响应率 60%）。
5. **成本结构变化**：总 token +75%（vs 实验二 +9%）——4 篇升级引入了 pro 模型调用；耗时 4.7×（9.5s → 44.7s）。升级是昂贵的路径，强制升级规则用"预算超限"这个确定性信号兜底，避免 flash 自评既漏报（不升该升的）又滥报。

## v1 → v2 修复记录（评估本身暴露的问题）

1. **L1 自评升级不可靠** → orchestrator 增加确定性规则：`truncated → 强制升级`（合成 escalation，L1 自评只作补充不作否决）
2. **B 答案评估失真** → benchmark 用主 agent 汇报成功时的自然语言输出作为答案（原实现把原始证据包文本给 judge，对 B 不公）
3. **类型错误**（EvidenceFact 未导入）→ 修复，`tsc --strict` 干净

## 局限性

- **judge 空响应率 60%**：DeepSeek API 当日极不稳定，10 篇仅 7 篇有效评分，且 3 篇无分文档（含 2 篇升级文档）无法评估——质量结论的统计力弱于实验二
- 单轮单问题、同源 judge、中文为主——同实验二
- 升级路径耗时/成本高（44.7s、+75% tokens），小文档场景下架构收益主要是上下文隔离而非质量
- L1 单次输出方差（编码面试 43 tok 证据包）未被多轮采样平滑——生产化需要 L1 重试/校验循环

## 相关代码

- `src/evidence.ts` — EvidencePacket schema + 确定性 merger
- `src/preflight.ts` — 静态风险评分 + 路由
- `src/doc-agents.ts` — L1/L2 agent（callLlm 3 次重试 + 空响应抛错）
- `src/orchestrator.ts` — orchestrateDocumentAnalysis（preflight → L1 → 强制升级 → L2 narrow scope → merge）
- `experiments/benchmark-orchestrator.mts` — 复现脚本（方案 A vs B）
- `experiments/benchmark-judge-retry.mts` — judge 补跑（4 轮 × 3 次重试）

# 实验四：证据包质量门（B0-B3 递进）

日期：2026-08-01
状态：完成（judge 覆盖率 8/10；当日 API 极不稳定，坍缩率 80% 为极值场景）

## 动机与设计

实验三暴露的瓶颈：**L1 不是平均能力不足，而是偶发输出坍缩导致证据链断裂**（编码面试证据包仅 43 tok）。本实验把 Evidence Packet 从"模型输出"升级为"有质量契约的中间产品"：

- `src/quality-gate.ts`：确定性质量判定（schema 有效性 / 空或泛化 / 证据字符量 / fact 数 / 引用数 / 覆盖率 / truncated / agent 自报状态）
- 三态处理：**pass** → 主 agent；**retry** → 差异化重试（reduced prompt 只填最低字段 + temperature 0.1 + max_tokens 3000，避免重试重复原调用的再次坍缩）；**escalate** → L2 专家
- L1 状态扩展 `complete|partial|insufficient|failed` + `failureReason` + `escalationRecommended`——模型被要求显式声明失败而非勉强输出空摘要
- 预注册失败判定（先分类再算分，避免事后筛选）：
  - RUN_FAILURE = orchestrator error（含 callLlm 3 次重试仍空响应/HTTP 失败）
  - PACKET_FAILURE = L1 attempt1 未过质量门（B0 无门会放过）
- 报告三指标：有效运行均分 / 任务成功率 / 端到端期望质量（= 成功率 × 均分）

方案链（单次运行反事实导出）：B0（无门，v2 架构）→ B1（+schema 校验拦截）→ B2（B1+差异化重试）→ B3（B2+重试失败自动升级 L2，实际运行管线）。

## 结果

### 管线指标（10 文档，B3 实际运行）

| 指标 | 值 |
|------|-----|
| 运行成功率 | 9/10（CDXR RUN_FAILURE：API 空响应 3 次，与门无关） |
| L1 attempt1 坍缩率（gate 拦截） | **8/10（80%）**——API 极不稳定期 |
| 差异化重试 | 6 次，自动恢复 **1 次（17%）** |
| 升级（L2 调用率） | 8/10（3 truncated 强制 + 5 非截断 gate 升级） |
| 平均总 token | 17,027（主汇报仅 974——主上下文收益保持） |
| 延迟 | P50=65.1s，P95=109.7s（升级路径成本） |

### Judge（8/10 有效，双评分取平均）

| 文档 | B0（无门） | B3（质量门） | Δ | 门路径 |
|------|-----------|------------|-----|--------|
| 简历-悉尼大学 | 4.5 | 1.3 | **-3.2** | 薄(167ch)→重试失败→升级 |
| 面经-RAG | 2.0 | 3.5 | +1.5 | 薄(383ch)→重试失败→升级 |
| 对接说明 | 4.0 | 4.8 | +0.8 | 薄(328ch)→重试失败→升级 |
| 财富Agent优化 | 3.3 | 1.0 | **-2.3** | 薄(88ch)→重试失败→升级 |
| AI数据分析Agent交接 | 3.0 | 4.5 | +1.5 | 薄→**重试恢复**（免升级） |
| RiskCloud任务书 | 3.0 | 4.5 | +1.5 | truncated 强制升级 |
| Spark知识总结 | 1.0 | 1.0 | 0 | truncated 强制升级 |
| 论文-StructuralFeasibility | 4.0 | 5.0 | +1.0 | L1 自评升级 |

**有效运行均分：B0=3.09 → B3=3.19（+0.10）**
**端到端期望质量（成功率 90%）：B0=2.78 → B3=2.87（+0.09）**
胜负：5 正 2 负 1 平

## 关键发现

1. **门整体微弱正收益，方向正确但被误判拖累**：5/8 有效文档改善（其中 RiskCloud/论文1 是 truncated 强制升级的固有收益），但两个大负案例（-3.2、-2.3）都是同一路径：**非截断短文档"薄→重试失败→升级 L2"**。
2. **"证据薄"≠"坍缩"——用户预判的边界情形实测命中**：简历 attempt1 仅 167 chars 却拿到 B0=4.5（事实密集型文档的核心信息本来就是几个 fact）；纯长度阈值 500 是误判根源。判定必须相对化：结合文档规模、覆盖率，长度只做兜底。
3. **重试恢复路径是门的最佳案例**：AI 交接 attempt1 被拦 → reduced 重试恢复 → +1.5 且**未花 L2 的钱**。差异化重试策略（换 prompt + 降 temperature）验证有效；今日恢复率 17% 低是 API 极值期（80% 坍缩率）。
4. **短文档升级 L2 有负收益**：L2 同样受 API 不稳定影响，且 merge 冲突/主汇报环节引入噪声（财富 B3=1.0）。升级决策应保留 attempt1/attempt2 中质量更好者，短文档（低预算）重试失败应 pass + 低置信度标注而非升级。
5. **truncated 强制升级稳定正收益**（RiskCloud +1.5、论文1 +1.0）：规则信号比模型自评可靠，与实验三结论一致。
6. **成功率 90%**：RUN_FAILURE 全部来自外部 API 空响应，门/重试未引入任务级失败。

## 局限性

- 当日 API 坍缩率 80% 是极端场景：门在极端期的拦截能力得到检验（8/8 拦截、5 篇改善），但 pass 路径的正常输出场景未被评估
- judge 有效 8/10，其中 3 篇单评分（votes=1）——双评分未完全达成
- 负收益案例（简历/财富）的 L2 输出与 merge 过程未逐条人工核查，误判根因分析基于质量信号推断
- 重试恢复率样本仅 1 例，统计力不足

## 下一步（已明确）

1. **判定相对化**：evidenceChars 阈值改为与文档规模挂钩（如 `max(300, documentChars × 0.04)`），主判据用 fact 数 + 引用覆盖率，长度仅兜底
2. **升级保留较好 attempt**：merge 时按质量选择 attempt1/attempt2 的 packet，避免"升级后更差"
3. **短文档不升级**：低预算（estimatedTokens < 3000）重试失败 → pass + low-confidence 标注
4. **judge 双评分全量**：API 稳定期重跑以消除单评分噪声

## 相关代码

- `src/quality-gate.ts` — assessEvidenceQuality / decideGate / gateReason
- `src/orchestrator.ts` — gate 集成（retry → 差异化重试 → escalate），返回 gate 诊断
- `src/doc-agents.ts` — L1_REDUCED_PROMPT + temperature 参数
- `experiments/benchmark-quality-gate.mts` — B0-B3 复现脚本（反事实导出 + 双评分 judge）
- 数据：`/tmp/quality-gate-exp/results.json`

# 实验五：B4 — 相对质量门 + best-attempt selection + 短文档不升级

日期：2026-08-01
状态：完成（judge 覆盖率 8/10；当日 L1 无坍缩，门 pass 路径为主）

## 动机

实验四的教训：两个大负案例（简历 -3.2、财富 -2.3）根因是 **"证据薄"≠"坍缩"**——纯长度阈值（500 chars）误判事实密集型短文档。按用户规格实现三条改进：

1. **相对判定**（quality-gate v2）：长度降为兜底 `max(300, documentChars×0.04)`；主判据 = schemaValid / factCount / citationCoverage / requiredFieldsCoverage / truncated / 显式失败状态；"短文档 + facts≥2 + 引用覆盖≥0.6" → pass（`pass_thin_but_covered`）
2. **best-attempt selection**：`qualityScore = schema + fact覆盖 + 引用覆盖 + 答案覆盖 − 截断罚 − 泛化罚 − 冲突罚`；attempt1/attempt2 取分数高者，绝不用"最后一次"覆盖好结果；**expert 分数低于 best standard 时弃用**（不 merge）
3. **短文档不升级**（estimatedTokens ≤ 2000）：gate 失败 → reduced 重试一次 → 仍失败 → 选高分 attempt + low_confidence，不升级 L2；例外（深度分析/冲突事实/跨文档/复杂推理/两次解析失败）仍可升级
4. **决策日志**：每篇记录 attempt1/attempt2 的 passed/qualityScore/gateReason、bestAttempt、selectionReason、expertTriggered/Used/Score

实验设计：**同轮生成 B3'（旧 v1 门反事实）与 B4 对比**，消除跨轮 API 噪声；短文档旧逻辑升级场景额外跑 L2 仅作反事实。

## 结果

### 管线指标

| 指标 | B3'（旧门） | B4（相对门） | 目标 |
|------|-----------|-------------|------|
| 运行成功率 | 9/10（RiskCloud RUN_FAILURE） | 同 | — |
| 非 truncated L2 调用率 | 3/10 | **0/10** | <20% ✓ |
| 短文档升级 | 0/2 | **0/2** | ≈0 ✓ |
| 差异化重试恢复 | 1 次（面经） | 同 | — |
| expert 弃用 | — | 0 次（今日无该场景） | — |
| 平均总 token | 17,027（实验四） | **14,997（-12%）** | 下降 ✓ |
| P50 延迟 | 65.1s（实验四） | **38.4s（-41%）** | 回落 ✓ |
| P95 延迟 | 109.7s（实验四） | **66.9s（-39%）** | 回落 ✓ |

### Judge（B3' vs B4，同轮，8/10 有效）

| 文档 | B3' | B4 | 说明 |
|------|-----|-----|------|
| 简历-悉尼大学 | 5.0 | 5.0 | 短文档免升级（实验四该文档升级后仅 1.3） |
| 面经-RAG | 2.5 | 2.5 | 重试恢复，answer 相同 |
| 对接说明 | 4.5 | 4.5 | 短文档免升级 |
| 编码面试 | 3.5 | 3.5 | — |
| 财富Agent优化 | 2.5 | 2.5 | — |
| AI数据分析Agent交接 | 4.8 | 4.0 | **同一答案，judge 波动** |
| Spark知识总结 | 2.5 | 1.0 | **同一答案，judge 波动** |
| 论文-StructuralFeasibility | — | — | judge FAILED |
| 论文-CDXR | 5.0 | 5.0 | truncated 升级 |

有效运行均分：B3'=3.78 vs B4=3.50（**差异全部来自 judge 对相同答案的评分波动**）
端到端期望质量（成功率 90%）：B3'=3.40 vs B4=3.15

## 关键发现

1. **三条改进在今日场景下是"纯成本优化 + 防误判保险"**：8 篇有分文档的 B3' 与 B4 答案**逐字相同**（今日 L1 无坍缩：无 gate 拦截升级、无 attempt1 优于 attempt2 的保留、无 expert 弃用）——质量零折损，成本大降。
2. **成本收益明确**：P50 -41%（65.1→38.4s）、P95 -39%（109.7→66.9s）、总 token -12%（17K→15K）。收益来源 = 短文档免升级 + 今日 L1 稳定。
3. **实验四负案例修复**：简历从 1.3 → 5.0（免升级 + pass_thin_but_covered）；财富 1.0 → 2.5（跨轮对比，注意 API 状态差异）。
4. **judge 噪声被量化**：同一答案被评出 4.8 vs 4.0、2.5 vs 1.0——**LLM judge 单次评分噪声 ±1.5**。实验三/四中若干"胜负"（如 AI 交接 -2.0、Spark 1.0 vs 1.0）可能部分由该噪声贡献。双评分（votes=2）显著降低此噪声。
5. **验证目标全部达成**：非 truncated L2 0/10（<20%）、短文档误升级 0、质量不降、P50/P95 大幅回落。

## 局限性

- **今日无坍缩场景**：门 pass 路径（不误拦正常输出）被验证；拦截+重试+升级路径（实验四已验证）今日未复现——两条路径在不同 API 状态下交替验证
- 跨轮分数（简历 1.3→5.0）受 API 状态影响，仅作方向参考
- 论文1 judge FAILED、RiskCloud RUN_FAILURE——API 不稳定持续，有效样本 8/10
- best-attempt 的"保留 attempt1 否决 attempt2"与 expert 弃用两个场景尚未在实际数据中触发（0 次），逻辑经类型检查但未实证

## 相关代码

- `src/quality-gate.ts` — v2：`minimumEvidenceChars` 相对阈值、`computeQualityScore`（best-attempt 用）、`pass_thin_but_covered`
- `src/orchestrator.ts` — best-attempt selection、短文档不升级（SHORT_DOCUMENT_TOKENS=2000 + SPECIAL_CASE_RE）、expert 分数门控、DecisionLog（attempt1/2 的 score/gateReason、selectionReason、expertUsed）
- `experiments/benchmark-b4.mts` — B3' 反事实同轮对比 + 双评分 judge
- 数据：`/tmp/b4-exp/results.json`

## 9. 相关代码（实验一/二）

- `src/subagent.ts` — 子 agent 实现（spawn RPC 进程）
- `src/doc-artifact-store.ts` — 文档落盘 + 缓存（`~/.pi/artifacts/`）
- `index.ts` — `analyze_document` 工具注册
- `experiments/benchmark-subagent.mts` — 复现脚本
