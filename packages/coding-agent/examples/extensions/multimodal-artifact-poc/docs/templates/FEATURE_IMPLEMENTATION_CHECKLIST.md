# Feature Implementation Checklist

## 开关设计

- Feature ID: round6.graph_engine（parent）+ graph_compiler / graph_validation / graph_executor / graph_scheduler / graph_event_store / graph_state_reducer / graph_artifact_edges / graph_feedback_routing / graph_review_integration / graph_skill_nodes / graph_human_gates / graph_observability / graph_frontend_render / graph_tool
- Parent feature: round6.graph_engine
- Dependencies: graph_executor → scheduler/state_reducer/event_store; graph_compiler → validation; graph_review_integration → round5.reviewer; graph_tool → executor
- Build flag: BUILD_GRAPH_ENGINE / BUILD_GRAPH_COMPILER / ...（registry envBuildName）
- Runtime flag: ENABLE_GRAPH_ENGINE / ...
- Build default: true（随 full profile 构建）；Runtime default: false（默认关，现有行为不变）
- Tool/API exposure: run_analysis_graph + inspect_graph_run（round6.graph_tool）；feature off 时不注册
- Disabled behavior: 工具不注册、Executor 不创建、Event Store 不初始化、Adapter 不执行、原有路径不变
- Enabled test: tests/reviewer/phase17-graph-features.test.ts（+ phase18-graph-core、phase19-graph-e2e）
- Disabled test: 同上（disabled 分支）
- Ablation config: no-graph-parallelism / no-graph-feedback-routing / no-graph-recovery / no-graph-observability（runtime config）
- Snapshot fields: round6.* 出现在 build/runtime/effective feature hash

## 接线检查

- [x] 工具注册出现在 REVIEW/DELIVERY/GHAPH *_TOOL_FEATURES 映射，且 feature ID 已注册
- [x] Graph Tool 有 `@_require`/isEffective 守卫（feature off 不注册）
- [x] 业务代码未直接读取 ENABLE_*（仅 resolver/生成器白名单）
- [x] registry 中 round6.* 在测试中有覆盖（enabled/disabled 两态）
- [x] `npm run check` 通过（仅既有 packages/ai/test 基线）（tsgo + hygiene）
