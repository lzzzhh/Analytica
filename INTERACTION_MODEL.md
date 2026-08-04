# Analytica 协作模式 — 最终协议（已获评估者确认）

## 职责分离

- `~/Documents/pi`（开发 Agent 工作区）= 唯一开发、修复、测试、推送环境。
  流程：修改 → 全量测试（pipelines pytest / gateway pytest / TS tests / npm run check）→ 全部通过 → 推送 `github.com/lzzzhh/Analytica` main。
- `~/Documents/Analytica`（评估副本）= **只读产品代码**；仅允许写入 `evaluation/` 下的评测资产。
- 评估者（codex）不修改生产代码，不自行创建 GitHub Issue；结果通过用户转达给开发 Agent。

## 评测基线（评估者约束）

1. 基线 = **评测开始时从远端 main 解析出的特定 Commit SHA**，不是持续移动的 main。
   - 执行期间仓库 HEAD 不得变化。
   - 报告必须明确绑定该 SHA。
2. 运行时配置：`FEATURE_RUNTIME_PROFILE=all-enabled`，并冻结记录：
   - Runtime feature snapshot
   - Effective feature hash
   - Build feature manifest hash
   - 模型、Provider 和配置版本
   - Round 5 Reviewer 生效必须以公开工具注册和真实调用验证为准，不能仅依据 feature flag。
3. 评测报告统一存放 `evaluation/phaseN-<scope>/`，至少包含：环境清单、冻结场景、Golden Answer、执行日志、逐场景结果、指标文件、证据 Hash Manifest、总结报告。
   - 状态统一：`PASS / FAIL / ABSTAIN / NOT_RUN / INFRA_ERROR`。
4. 缺陷闭环：评估者报告 → 开发 Agent 在 pi 复现修复 → 测试通过 → 推送新 Commit → 评估者**重新冻结基线并复测**。

## 当前状态（重要修正）

- `e7368b1d` 是 Phase 2 修复提交，**尚未通过第三阶段复测**。
- 上一轮第三阶段结果绑定 `fdaffc50` + 当时工作区 Hash；并发提交发生在指标生成后，故该结论不继承。
- 因此：**`e7368b1d` 必须作为新基线重新执行冻结评测**；在评估者完成复测并返回 `PASS` 之前，不视为第三阶段通过。

## 开发 Agent 待办

- 等待评估者对 `e7368b1d` 的冻结评测结果。
- 评测期间不在 pi 中引入与评测无关的大改动；如评测发现问题，按缺陷闭环处理。
