# 已排除的 Pi 工具调用开发侧实验

状态：INVALID_SCOPE_EXCLUDED

本实验直接调用 Pi CLI，并仅挂载 Analytica 的冻结工具 Schema 与 mock 执行器，
因此被测对象是开发环境中的 Pi，而不是生产环境 Analytica。

已采集的 106 次调用不得计算、汇总或引用为 Analytica 的工具调用能力、
端到端性能或任何正式评测指标。本文件不包含有效的 Analytica 评测结论。
