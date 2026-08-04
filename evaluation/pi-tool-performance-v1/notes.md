# Notes: Analytica 工具调用性能实验 v1.0

## Invalidation

- 状态：`INVALID_SCOPE_EXCLUDED`
- 原因：运行器直接调用 Pi CLI；未通过生产环境 Analytica 正式入口。
- 已完成的 106 次记录仅属于 `DEV_BASELINE_PI_ONLY`，不得进入 Analytica 指标。
- 原始 Trace 只为审计保留，不对其生成正式指标或结论。
- 后续有效实验必须由 Codex 驱动 Analytica 正式入口，Analytica 自行完成内部 Agent 与工具调度。

## Source

- `/Users/zhanhuilin/.hermes/skills/agent-frameworks/pi-agent/Analytica_工具调用性能实验方案_v1.0.docx`

## Findings

### 实验范围

- 阶段 0：至少 20 个历史任务，验证能否重建主 Agent、工具、Reviewer 和返工时延。
- 阶段 1：12 个下一工具案例，在 A 唯一工具、B 相似工具、C 16 个低重叠工具、D 全目录下各重复 5 次，共 240 次。
- 阶段 2：确定性 15ms 模拟工具循环，对比当前返回 M0 与标准状态包 M1。
- 阶段 3：固定 T0–T3 轨迹，对比 R0–R3 Reviewer 策略。
- 阶段 4：只有前三阶段定位瓶颈后才进入真实 E0–E3 端到端对照。

### 核心指标

- 首次工具选择准确率、工具决策时延、首次正确工具时间、参数一次通过率。
- 完整序列准确率、冗余调用、恢复轮次、错误标签。
- Reviewer 冷启动、Reviewer 推理、错误放大倍数、超时率。
- 时延报告中位数、IQR、P90；准确率保留置信区间和工具混淆矩阵。

### 有效性约束

- 模型、推理强度、提示词、工具 Schema、目录顺序、随机种子和上下文哈希均冻结。
- PROVIDER_ERROR、INFRA_ERROR、REVIEWER_TIMEOUT 与业务错误分开。
- 不修改 Frozen Golden，不让 Reviewer 决定真值。
- 原 DOCX 14 页已渲染并逐页检查；LibreOffice 渲染缺少部分中文字形，但文本提取完整，实验约束可读。
