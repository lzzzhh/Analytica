# Example Sessions

## 1. Pre-experiment sample size

User: "帮我设计一个 A/B 实验，转化率基线 5%，想检测 10% 相对提升"

Skill: phase=PRE_EXPERIMENT, one blocking question each turn:
1. "决策会改变什么？（决定是否全量上线新版结账流程）"
2. "随机化单位？（用户）"
3. "alpha/power？（0.05/0.8 双边）"

Then run:
```
python3 scripts/ab_experiment_calculator.py sample-size-binary 0.05 0.055 --alpha 0.05 --power 0.8
```
→ per-group sample size, total, sensitivity at 3 MDEs.

## 2. In-experiment SRM

User: "跑了 5 天，A 48200，B 46700"

Skill: phase=IN_EXPERIMENT_REVIEW, run:
```
python3 scripts/ab_experiment_calculator.py srm 1 1 48200 46700
```
→ chi2, p, SRM_SUSPECTED or NO_OBVIOUS_ISSUE_REPORTED. If suspected, stop
interpreting the outcome; investigate by day/platform/geo/etc.

## 3. Post-experiment decision

User uploads detail data (CSV).

Skill: phase=POST_EXPERIMENT_REVIEW → trust check first → Data Analysis Agent
computes metrics/SRM/CI/plots via artifact/UI channel → evidence class vs
practical threshold → decision memo.
