# Data Analysis — 沙箱强度与限制（如实记录）

## 已实现的真实边界（PoC）

| 边界 | 实现 |
|------|------|
| 固定 cwd | `python3 <workspace>/analysis.py`，cwd = `~/.pi/artifacts/data-analysis/<run-id>/` |
| 禁止 -c/-e/heredoc | runner 只允许 `python3 <script-path>`；`validate_script.py` 静态拒绝脚本内的动态执行 |
| env 白名单 | PATH/HOME/LANG/LC_*/TZ/TERM 之外全部剔除；显式删除 LAKEHOUSE/AWS/S3/DATABASE/DB_/REDSHIFT/BIGQUERY/SNOWFLAKE/PGHOST/PGUSER/PGPASSWORD/API_KEY/TOKEN/SECRET |
| 超时 | 默认 120s（可配置），SIGTERM → EXECUTION_TIMEOUT |
| 大小限制 | 脚本 200KB；stdout/stderr 各 100KB；结果文件 1MB |
| 进程数 | 单脚本一次一个 python3 子进程；无并发 |
| 尝试次数 | ≤2（`analysis_retry` 关时 1） |
| 依赖 | 执行前 `spawnSync python3 -c "import X"` 探测；缺依赖 → SCRIPT_IMPORT_ERROR（不自动安装） |
| 静态预检 | `validate_script.py`：禁 os/subprocess/socket/requests/urllib/http.client/ftplib/paramiko/shutil/pickle/ctypes、os.system、eval/exec/__import__/compile、pip/curl/wget/nc、绝对路径 open、连接串、input/breakpoint/pdb |
| 网络 | env 无代理/凭据；未配置任何外发白名单（依赖 env 空壳，未验证防火墙级隔离） |
| 输入 | workspace/input/ 只读拷贝；输出目录可写；日志默认不进 Agent 上下文 |
| 凭据 | 子进程 env 不含任何数据库/云凭据 |

## PoC 限制（必须如实声明）

1. **无 OS 级沙箱**：子进程与主进程同用户，理论上可读用户可读的任何文件。我们依赖：(a) 脚本由隔离上下文子 Agent 生成；(b) `validate_script.py` 静态拒绝；(c) env 白名单；(d) 输入只读拷贝。
2. **网络隔离未验证**：本机无防火墙验证；不声明"已实现强沙箱"。
3. **`python3 -c` 出现位置**：仅 runner 内部依赖探测使用（非用户代码执行）；用户脚本路径必须落盘。
4. 推荐分析依赖（如可用）：json/csv/math/statistics/datetime/pandas/numpy/pyarrow/scipy/statsmodels/matplotlib——不假设已安装，缺依赖明确失败。

## 结论

当前为"现有平台能提供的最强限制"（受控 runner + 静态预检 + env 白名单 + 大小/超时约束），不是强沙箱。生产部署需 OS 级隔离（容器/seccomp）或独立沙箱服务。
