# Graph Engineering Migration

## 原则

渐进迁移，禁止 Big Bang。第一阶段只图化"数据分析正式报告"主链路。
现有 22 个公开工具保留（兼容 + 测试）；Graph Tool 是新增受控入口。

## 已完成

- Phase 0：round6.graph_* 15 features 注册 + manifests + checklist
- Phase 1：确定性 Core（contracts/canonical/errors/validator/compiler/
  scheduler/state-reducer/event-store）
- Phase 2：capability registry + executor + fake adapters
- Phase 3/4：data-analysis / reviewer（gate/execute/authorize）adapters
- Phase 5：deliverable verifier；report skill adapter（**阻塞：无本地接口**）
- Phase 6：run_analysis_graph + inspect_graph_run 工具（feature 门禁）

## 未迁移（明确非目标）

文档、多模态、Presentation、A/B Experiment、Pipeline 执行路径；
现有 Agent 工具链保持不变。

## 已知阻塞

analysis-report Skill 在 POC 内只有 SKILL.md 定义，无 TS 可调用实现。
按任务规则停止并报告；report 节点 fail-closed（REPORT_SKILL_UNAVAILABLE），
图不会虚构报告。待本地接口提供后接线（adapter 结构已就位）。
