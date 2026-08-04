# A/B Experiment Decision Support Skill

这是一个**不接实验平台**的 A/B 实验辅助决策 Skill。

它不会自动拿到真实分流、曝光或指标数据，而是根据用户主动提供的信息，在实验前、实验中和实验后分阶段追问、计算和提出建议。

## 安装

将整个目录复制到 Claude Code 项目的技能目录：

```bash
mkdir -p .claude/skills
cp -R ab-experiment-decision-support .claude/skills/
```

也可以安装到用户级目录：

```bash
mkdir -p ~/.claude/skills
cp -R ab-experiment-decision-support ~/.claude/skills/
```

## 使用方式

常见触发语句：

```text
帮我设计一个 A/B 实验
这个实验应该需要多少样本？
实验跑了 5 天，帮我检查 SRM
这是 A/B 结果，应该上线吗？
```

Skill 会自动识别：

```text
PRE_EXPERIMENT
IN_EXPERIMENT_REVIEW
POST_EXPERIMENT_REVIEW
```

## 核心边界

- 不声称连接实验平台。
- 不虚构数据。
- 不自动暂停、停止、回滚或上线。
- 所有结论都标记为基于用户提供的数据。
- 样本量、周期、SRM、置信区间和 p-value 由确定性脚本计算。
- 复杂实验设计会要求专业复核，不强行套普通两组 A/B。
- 上传明细数据时，完整表格和图表应由 Data Analysis Agent 通过 Artifact/UI 通道返回。

## 内置计算器

```bash
python3 scripts/ab_experiment_calculator.py --help
```

支持：

- 二项指标样本量；
- 连续指标样本量；
- 周期估算；
- 两组 SRM；
- 二项结果分析；
- 连续结果分析。

V1 不支持 cluster、geo、switchback、网络干扰、自适应实验和高级 sequential testing。

## 验证

```bash
python3 -m unittest scripts/test_ab_experiment_calculator.py -v
```

## 版本

`0.3.0` — Decision Support Edition
