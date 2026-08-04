# Graph Engineering Security Boundaries

1. **数据获取分离**：业务数据只经 Lakehouse Gateway / 可信 Artifact /
   现有受控入口。Graph/Adapter 禁止：直连数仓、接收连接串/凭证、
   执行任意 raw SQL、接收任意本地文件路径作为业务输入。
2. **查询/分析分流**：count/sum/avg/min/max/过滤/单次 group by → Query
   Gateway；复杂分析 → run_data_analysis（隔离子 Agent + 受控 Runner）。
   LLM 不允许心算结果。
3. **数值零泄漏**：完整数字/表格/图表只在 AnalysisResultArtifact；主 Agent
   content、Graph Event、普通日志摘要均无数值。
4. **Data Analysis 边界不变**：独立 RPC 上下文/固定 workspace/env 白名单/
   禁 os/subprocess/网络/pip/heredoc/有限重试/SANDBOX_VIOLATION 不可重试/
   artifact 不可变/result validator/UI renderer。
5. **Reviewer 独立**：图不能决定/降低 ReviewMode；确定性检查先于语义；
   缺必须检查不 PASS；超预算 ABSTAIN 不静默截断。
6. **报告是 Skill**：无 Report Agent；报告节点 BLOCKED 也不虚构。
7. **Pipeline Governance 只建议**：remediation 是图输入建议，不自动执行。
8. **人工审批不可伪造**：approve/waive/governance/发布/生产写仅可信
   principal；Human Gate 显式 WAITING_FOR_HUMAN，LLM/Executor 不能批准。
9. **Feature 门禁**：round6.* 默认关；关时工具不注册/Executor 不创建/
   Event Store 不初始化/Adapter 不执行；现有路径零变化。
