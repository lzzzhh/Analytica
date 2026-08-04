// 中文指标名称映射（单一权威来源）。
// key 为 coverage-matrix.json / 各评分器使用的英文指标名，
// value 为对外报告使用的中文名。
export const METRIC_NAMES_ZH = {
  // global 全局
  "Task Success Rate": "任务成功率",
  "Consistency@3": "一致性@3",
  "Hallucination Rate": "幻觉率",
  "Correct Abstention Rate": "正确拒答率",
  "Robustness Drop": "鲁棒性下降",
  "Worst-Slice Accuracy": "最差切片准确率",
  // tool_calling 工具调用
  "Single-Tool Task Success Rate": "单工具任务成功率",
  "Argument Accuracy": "参数准确率",
  "Tool Set F1": "工具集F1",
  "Multi-Tool Task Success Rate": "多工具任务成功率",
  "Workflow Task Success Rate": "工作流任务成功率",
  "Orchestration Accuracy": "编排准确率",
  // requirement 需求遵循
  "Route Accuracy": "路由准确率",
  "Constraint Recall": "约束召回率",
  // multimodal 多模态
  "pass@1": "一次通过率(pass@1)",
  "pass@3": "三次通过率(pass@3)",
  "Structured Extraction F1": "结构化抽取F1",
  // data_analysis 数据分析
  "Analysis Task Success Rate": "分析任务成功率",
  "Numerical Correctness": "数值正确率",
  // pipeline 数据管道
  "Pipeline Run Success Rate": "管道运行成功率",
  "Data Correctness Rate": "数据正确率",
  "Data Quality Defect Detection F1": "数据质量缺陷检测F1",
  "Idempotent Rerun Success Rate": "幂等重跑成功率",
  // reviewer 审阅
  "High-Severity Defect Recall": "高危缺陷召回率",
  "Reviewer False Positive Rate": "审阅误报率",
  // hard_gate 硬门禁
  "Hard-Gate Violation Count / Rate": "硬门禁违规数/违规率",
  // latency / tokens 效能
  "Average Successful End-to-End Task Completion Time": "成功任务平均端到端耗时",
  "Average Observable Task Token Usage": "平均可观测任务Token用量",
  // V2 双轨评分附加指标
  "Contract Deviation Rate": "契约偏差率",
  "Business Single-Tool Success": "业务单工具任务成功率",
  "Business Multi-Tool Success": "业务多工具任务成功率",
  "Business Workflow Success": "业务工作流任务成功率",
  "Business Argument Accuracy": "业务参数准确率",
};

export function zhName(en) {
  return METRIC_NAMES_ZH[en] ?? en;
}
