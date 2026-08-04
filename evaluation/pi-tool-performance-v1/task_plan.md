# Task Plan: Analytica 工具调用性能实验 v1.0

## Goal
按指定实验方案在不修改产品代码的前提下完成可复现实验，并保存原始证据、确定性评分和最终报告。

## Phases
- [x] Phase 1: 读取并解析实验方案，冻结成功条件
- [x] Phase 2: 固定仓库、模型、运行时和数据/场景配置
- [ ] Phase 3: 已中止；现有运行被判定为测试对象错误
- [ ] Phase 4: 取消，不复算已排除数据
- [ ] Phase 5: 取消，不生成 Analytica 指标结论

## Key Questions
1. 方案要求的实验变量、样本量、对照组和指标是什么？
2. 当前仓库是否具备直接执行入口，是否存在基础设施阻断？
3. 结果是否能够与 frozen scenario、Commit、模型和配置绑定？

## Decisions Made
- 产品代码保持只读；实验资产写入本目录。
- 基础设施问题与产品失败分开记录。
- 阶段 1 严格执行 12 案例 × 4 条件 × 5 次，共 240 次；串行运行以避免并发负载污染时延。
- 使用当前真实工具名称、描述和 Schema 的快照，但以 15ms 确定性 mock 替代真实工具执行并关闭 Reviewer。
- 当前产品存在未提交修改，因此同时绑定 HEAD、产品 diff SHA-256、工具目录哈希和实验契约哈希。

## Errors Encountered
- 历史 Trace 缺少 Reviewer spawn/ready/request/completion 和 wrapper monotonic timestamps：阶段 0 标记 ABSTAIN；新实验阶段使用独立埋点缓解。
- Qoder 在阶段 1 期间继续修改产品源码，产品 diff SHA 发生变化：阶段 1 使用冻结 registry/mock，不受影响；真实阶段 4 在重新冻结前不得运行。

## Status
**INVALID_SCOPE_EXCLUDED** - 实验已停止。106 次记录是 Pi 开发侧数据，不是 Analytica 生产评测结果。
