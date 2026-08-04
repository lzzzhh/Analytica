# CDXR 集成基线（第三轮改造前工作区快照）

日期：2026-08-01
记录时点：第三轮改造开始前（湖仓迁移与种子数据尚未提交，与上一轮报告一致）

## 1. Git 状态

| 项 | 值 |
|----|-----|
| 分支 | `feature/cloud-lakehouse-datasource` |
| HEAD | `67a899ac99c3b167740dec1986de2666c3edc12d`（main 基线提交，未变） |
| 已修改文件 | `README.md`、`index.ts`、`src/evidence.ts`（+80/-8） |
| 未跟踪 | 11 项：`.gitignore`、`contracts/`、`docs/`、`domains/`、`experiments/`（3 个 .mts）、`infra/`、`services/`、`src/data-tools/`、`tests/` |

## 2. 与上一轮报告的一致性核对

- ✅ 湖仓迁移完成（7 张表真实数据在 `.data/warehouse`，pyiceberg SQL catalog，绝对路径）
- ✅ 种子数据已加载（7 表 60 天确定性数据，`expected_results.json` 生成）
- ✅ Python 60/60、TS 11/11、E2E OK、tsgo 0 error（非既有错误）
- ✅ `verify-seed.mts` 5 个真实查询全过
- ⚠️ `agent-analysis.mts`（上轮验收场景）2/3 通过：LLM 自由文本偶发不完整，已内置"验证失败自动重生成（≤3 轮）"；确定性数值一致性由 verify-seed 保证——列为已知限制

## 3. 保护承诺（本轮）

- 不切换分支、不清理工作区、不 reset、不覆盖已有新文件、不提交、不推送
- 原 RiskCloud 仓库（/Users/zhanhuilin/Documents/风控大数据/LeakBench-RiskCloud）只读
- 现有湖仓/多模态/多 Agent/质量门/7 个数据工具/掩码/ODS 拒绝全部保持

## 4. 相关路径

- data-agent 仓库根：`/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc`
- 本地数仓：`.data/warehouse`（绝对路径 sqlite catalog）
- 原 CDXR 模块：`/Users/zhanhuilin/Documents/风控大数据/LeakBench-RiskCloud/riskcloud/governance/cdxr/` @ `e386f920`
