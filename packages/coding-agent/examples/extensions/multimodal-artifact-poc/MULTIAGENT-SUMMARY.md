# 多 Agent 多模态 PoC 综合总结

日期：2026-08-01
范围：multimodal-artifact-poc 全部多 agent / 多模态工作（实验一 ~ 实验五）
详细分轮记录见 `EXPERIMENT-subagent.md`，运行状态见 `POC_STATUS.md`

---

## 1. 最终架构

把"文档/图片解析"从**原生 Pi agent 的直返模式**（全文进主上下文）升级为**两层 agent + 确定性质量契约**的管线：

```
输入（PDF/DOCX/PPTX/图片/MD）                     主 agent 上下文
        │                                              ▲
        ▼                                              │
  ┌─────────────────────── preflight 静态路由 ─────────┐│
  │  token 预算 + 章节/表格/页数 → 风险分                ││
  │  ≥50 → expert-direct ｜ ≥30 → standard(可能升级)    ││
  │  <30 → standard                                     ││
  └──────────────┬──────────────────────────────────────┘│
                 ▼                                       │
   ┌─── L1 standard agent（flash）──────────────────┐    │
   │  输入 >6000 tok 时截断；输出 Evidence Packet    │    │
   │  status: complete|partial|insufficient|failed  │    │
   └──────────────────┬─────────────────────────────┘    │
                      ▼                                   │
        ┌─ Evidence Quality Gate v2（相对判定）─┐          │
        │ pass → 主 agent                     │          │
        │ retry → 差异化重试（reduced prompt + │          │
        │   temp 0.1 + max_tokens 3000）      │          │
        │ escalate → L2                        │          │
        └──────────┬───────────────────────────┘          │
                   ▼                                      │
      best-attempt selection（attempt1/2 取质量分高者）     │
                   │                                      │
                   ▼                                      │
   升级决策：truncated 硬信号 / agent 声明失败 /          │
   质量门失败（仅非短文档或特殊场景）                       │
                   │                                      │
                   ▼                                      │
   ┌─── L2 expert agent（pro）────────────────┐            │
   │ 只分析 narrow scope（升级 sections 或     │            │
   │ 截断点之后的尾部），绝不全量重读           │            │
   └──────────┬───────────────────────────────┘            │
              ▼                                           │
   expert 分数门控：expertScore > best standard 才 merge   │
              ▼                                           │
   确定性 Evidence Merger（parse > cited > inferred，      │
   冲突 → requires_verification，绝不"expert wins"）        │
              ▼                                           │
      merged packet（~160 tok）──→ 主 agent 汇报 ──────────┘
```

### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| 多模态解析 | `image-parser.ts` / `visual-parser.ts` / `doc-utils.ts` | 图片 OCR（PaddleOCR）、图表（PaddleOCR-VL）、文档（markitdown）→ 文本化证据 |
| 静态路由 | `preflight.ts` | 调用前按 token 预算 + 复杂度信号定风险分，预路由三档 |
| L1 标准 agent | `doc-agents.ts` | flash 模型，截断输入，输出四态 Evidence Packet，可自报 insufficient/failed |
| 质量门 v2 | `quality-gate.ts` | 相对判定（长度只兜底，主判据信息覆盖）、确定性质量分、三态裁决 |
| 差异化重试 | `doc-agents.ts` | reduced prompt（只填最低字段）+ temperature 0.1 + max_tokens 3000 |
| L2 专家 agent | `doc-agents.ts` | pro 模型，只分析 narrow scope |
| 确定性合并 | `evidence.ts` | 证据优先级 + 冲突显式化，不覆盖、不编造 |
| 编排 | `orchestrator.ts` | 全管线 + best-attempt selection + 短文档不升级 + 决策日志 |

### 关键设计决策

1. **L1 输入截断即强制升级**（确定性规则，不依赖模型自评）——v1 实测 flash 对 33K 文档自评"不升级"
2. **证据包质量由信息覆盖决定，不由篇幅决定**——`minimumEvidenceChars = max(300, documentChars×0.04)`，短文档 facts≥2 + 引用覆盖≥0.6 直接 pass
3. **保留最佳 attempt，绝不用"最后一次"覆盖好结果**——attempt1/2 按确定性 qualityScore 取高者；expert 分数低于 best standard 时整体弃用
4. **短文档不因质量门升级**（estimatedTokens ≤ 2000）——gate 失败 → 重试一次 → 仍失败 → 选高分 attempt + low_confidence；例外（深度分析/冲突事实/跨文档/复杂推理/两次解析失败）仍升级
5. **expert 结果绝不经过 standard agent 转发**——由 orchestrator 确定性合并，防止污染链
6. **每次调用预注册失败判定**（RUN_FAILURE / PACKET_FAILURE）——先分类再算分，避免事后筛选

---

## 2. 演进过程（每轮做了什么）

| 阶段 | 内容 | 结果 | 暴露的问题 |
|------|------|------|-----------|
| 前置 | 多模态解析（OCR/视觉/文档）+ 结构化输出 | 图片/PDF/DOCX 全链路可用 | 复杂图表指令对 OCR-VL 不友好（只接受极简指令） |
| 实验一 | 子 agent 隔离解析 vs 直返（本地 Qwen3-8B，合成文档 5 题） | 主上下文 -89%、总 token -48%、质量 80%→100%、耗时 +128% | 小样本；>8K 长文档未覆盖 |
| 实验二 | 10 个真实文档 + DeepSeek API | 主上下文 -95%、judge 3.80→4.15（+0.35）、5 胜 3 负 2 平 | 长文档（33K）直返质量崩塌；同源 judge |
| 实验三 | 两级编排（escalation + fan-in + 确定性 merger） | 主上下文 -98.6%（159 tok）、升级纪律验证（4/10 全为大文档） | L1 自评升级不可靠；**L1 偶发输出坍缩**（编码面试证据包仅 43 tok） |
| 实验四 | 证据包质量门（B0-B3）+ 差异化重试 + 预注册统计 | 门拦截坍缩（当日坍缩率 80%）、B0 3.09→B3 3.19、端到端 2.78→2.87 | 绝对长度阈值误判事实密集型短文档（简历 -3.2、财富 -2.3）；短文档升级 L2 有负收益 |
| 实验五 | B4：相对门 + best-attempt + 短文档不升级 | 非 truncated L2 0/10、短文档升级 0/2、P50 -41%、P95 -39%、token -12%、质量零折损 | 拦截路径当日未复现；judge 噪声 ±1.5 被量化 |

---

## 3. 遇到的问题与修复

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 本地 llama.cpp 8080 端口被 open-webui 占用，服务中断 | 环境冲突 | 切换到 DeepSeek API（128K 上下文），顺带验证了**模型可替换性**（本地→API 零架构改动） |
| 2 | 本地 8K 上下文装不下真实文档 | 上下文限制 | 子 agent 隔离解析（实验一/二核心动机） |
| 3 | 直返长文档质量崩塌（Spark 36K chars 仅 1.5 分） | 长上下文稀释 | 隔离上下文 + 两级编排 |
| 4 | L1 自评对 33K 文档报"不升级" | flash 自评不可靠 | **truncated 强制升级**确定性规则（自评只作补充不作否决） |
| 5 | B 答案评估失真 | benchmark 把原始证据包文本给 judge | judge 改用主 agent 汇报文本 |
| 6 | L1 偶发输出坍缩导致证据链断裂（证据包仅 43 tok） | 单次采样方差 | 质量门三态（pass/retry/escalate）+ 差异化重试（换 prompt + 降温度，避免重试重复坍缩） |
| 7 | "证据薄"被误判为"坍缩"（简历 167 chars 实际质量 4.5 分） | 绝对长度阈值 | 相对判定：`max(300, documentChars×0.04)`，信息覆盖为主判据，`pass_thin_but_covered` |
| 8 | 短文档升级 L2 反而更差（财富 -2.3） | 升级成本高 + L2 也受 API 不稳定影响 | 短文档（≤2000 tok）不因质量门升级，重试失败 → pass + low_confidence |
| 9 | 好结果被后续 attempt 覆盖 | 用"最后一次"而非"最好一次" | best-attempt selection（确定性 qualityScore 比较 attempt1/2/L2） |
| 10 | judge 空响应率 60%（API 极不稳定） | 外部 API | callLlm 3 次重试 + 指数退避 + judge 外层重试 + 双评分（votes=2） |
| 11 | judge 对相同答案评出 4.8 vs 4.0、2.5 vs 1.0 | LLM judge 评分噪声（实测 ±1.5） | 双评分取平均；跨轮分数只作方向参考；同轮反事实对比（B3' vs B4 同轮生成） |
| 12 | 结果统计失真（剔除故障样本） | 事后筛选 | 预注册失败判定（RUN_FAILURE / PACKET_FAILURE）+ 三指标（成功率/有效均分/端到端期望质量） |

---

## 4. 对比原生 Pi agent（直返）：优势

1. **主上下文压缩 95~98.6%**（11,092 → 159 tok）——文档全文不再进入主 agent 工作记忆，多次提问同一文档不累积；33K 的论文进主上下文只剩 304 tok
2. **质量下限有保障**：质量门拦截 L1 坍缩（80% 坍缩极端日 8/8 拦截、5/8 改善）；升级/重试/弃用全部确定性裁决，不依赖模型临场发挥
3. **长文档质量优势最大**：CDXR 33K（3.5→4.5）、Spark 36K（1.5→3.0）——直返在长上下文稀释下质量崩塌
4. **成本纪律**：B4 后非 truncated L2 调用率 0/10（只有截断这种硬信号才升级）；短文档绝不烧 L2 的钱
5. **可观测性**：每篇文档有决策日志（attempt1/2 分数、gateReason、selectionReason、expertUsed），可事后审计误拦截/漏拦截
6. **无幻觉传递**：merger 确定性合并（parse > cited > inferred），事实冲突显式化为 requires_verification，绝不"expert wins"
7. **模型可替换**：本地 Qwen3-8B → DeepSeek API 零架构改动，结论方向一致
8. **多模态输入统一**：图片 OCR / 视觉图表 / PDF/DOCX/PPTX 全部走同一条证据管线，主 agent 只看到结构化文本

## 5. 指标提升汇总

| 指标 | 直返（原生） | 最终架构（B4） | 提升 |
|------|-------------|---------------|------|
| 主上下文输入 | 11,092 tok | **159 tok** | **-98.6%** |
| 总 token | 11,822 tok | 14,997 tok（升级场景）/ 12,503 tok（无升级） | +27% / +6% |
| P50 延迟 | 9.5s | 38.4s（实验四 65.1s → **-41%**） | +4×（见劣势） |
| P95 延迟 | — | 66.9s（实验四 109.7s → **-39%**） | — |
| 质量（实验二，无质量门） | 3.80 | 4.15 | **+0.35** |
| 质量（实验四，质量门，API 极值期） | 3.09（B0） | 3.19（B3） | +0.10 |
| 端到端期望质量 | 2.78（B0） | 2.87（B3） | +0.09 |
| L2 调用率（非截断） | —（无 L2） | **0/10** | 成本纪律 |
| 短文档误升级 | 2/2 | **0/2** | — |
| 运行成功率 | 10/10 | 9/10（唯一失败 = 外部 API 空响应） | 门/重试零引入失败 |

跨轮分数受 judge 噪声（±1.5）影响，**最有把握的收益是主上下文 -98.6% 与成本纪律**；质量收益在长文档场景（+1.0~+1.5）最稳健。

## 6. 劣势与适用边界

1. **延迟显著增加**：P50 38.4s vs 直返 9.5s（约 4 倍）——多一次 L1 调用 + 可能的重试/升级链。对延迟敏感的单次小文档查询，直返更合适（<300 chars 建议直返）
2. **总 token 在升级场景更高**：4 篇大文档升级引入 pro 调用，总 token +75%（实验三）；B4 后降为 +27%，但仍高于直返
3. **架构复杂度**：进程/生命周期/超时/错误传播/缓存失效/配置面，比单次直返大一个数量级
4. **摘要有损**：主 agent 只看到 merged packet，精确引用原文细节的场景不如直返（需要原文片段时走证据引用回查）
5. **小文档/纯结构文档直返占优**：简历（2,329 tok 直返 5.0）、RiskCloud 任务书（A 胜）——隔离上下文丢失主上下文的项目语境
6. **依赖外部 API 稳定性**：RUN_FAILURE（3 次空响应）和 judge 失败会吃掉有效样本；极端不稳定期需重试/双评分兜底
7. **未实证路径**：best-attempt 否决 attempt1、expert 弃用两条逻辑 0 次实际触发（今日 L1 稳定）——逻辑经类型检查，待坍缩日验证
8. **评估噪声**：LLM judge 与被评模型同源、单次评分噪声 ±1.5，跨轮分数只能作方向参考

## 7. 结论：什么情况下值得用

**值得**：文档较大（>2K tokens）/ 用户会多次提问同一文档 / 多轮对话中不想累积文档全文 / 质量下限比延迟重要（生产级文档问答）

**不值得**：<300 chars 单次小查询 / 需要逐字引用原文 / 延迟敏感实时交互 / 纯结构短文档

## 8. 代码与数据索引

- 源码：`src/`（orchestrator / quality-gate / evidence / doc-agents / preflight / image-parser / visual-parser / subagent）
- 实验脚本：`experiments/benchmark-{subagent,real-docs,orchestrator,quality-gate,b4,judge-retry}.mts`
- 数据：`/tmp/subagent-exp/`、`/tmp/real-docs-exp/`、`/tmp/orchestrator-exp/results.json`、`/tmp/quality-gate-exp/results.json`、`/tmp/b4-exp/results.json`
- 分轮记录：`EXPERIMENT-subagent.md`；状态总览：`POC_STATUS.md`
