/* Analytica Web UI — Home / Tools / Settings pages. */
import { api } from "/api.mjs";
import {
  EmptyView, ErrorView, KV, Section, Spinner, StatusBadge,
  fmtTime, html, useAsync, useLive,
} from "/ui.mjs";

export function HomePage({ nav }) {
  const health = useAsync(() => api("/api/health"), []);
  const runs = useAsync(() => api("/api/graph/runs"), [], (d) => d.runs.length === 0);
  const sessions = useAsync(() => api("/api/sessions"), [], (d) => d.sessions.length === 0);
  const artifacts = useAsync(() => api("/api/artifacts"), [], (d) => d.graphArtifacts.length === 0 && d.registeredArtifacts.length === 0);
  useLive(runs.retry);

  const artifactCount = artifacts.data
    ? artifacts.data.graphArtifacts.length + artifacts.data.registeredArtifacts.length
    : null;

  return html`<div>
    <div class="page-intro">
      <div>
        <h1 class="page-title">首页</h1>
        <p>继续最近的分析工作。</p>
      </div>
      ${health.status === "ready" ? html`<span class="service-status"><i></i>在线</span>` : health.status === "error" ? html`<span class="service-status service-status-error"><i></i>离线</span>` : null}
    </div>
    <div class="summary-strip">
      <button onClick=${() => nav("/chat")}><strong>${sessions.data?.sessions.length ?? "—"}</strong><span>会话</span></button>
      <button onClick=${() => nav("/graph-runs")}><strong>${runs.data?.runs.length ?? "—"}</strong><span>图运行</span></button>
      <button onClick=${() => nav("/artifacts")}><strong>${artifactCount ?? "—"}</strong><span>制品</span></button>
    </div>
    <div class="home-columns">
    <${Section} title="最近图运行">
      ${runs.status === "loading" ? html`<${Spinner} label="正在加载运行" />` : null}
      ${runs.status === "error" ? html`<${ErrorView} error=${runs.error} onRetry=${runs.retry} />` : null}
      ${runs.status === "empty" ? html`<${EmptyView} title="暂无图运行" hint="种子运行或生产运行将显示在这里。" />` : null}
      ${runs.status === "ready" ? html`<div class="workspace-list">
        ${runs.data.runs.slice(0, 5).map((r) => html`
          <button key=${`${r.storeLabel}:${r.runId}`} class="workspace-row"
            onClick=${() => nav(`/graph-runs/${r.runId}?store=${r.storeLabel}`)}>
            <div class="workspace-row-main">
              <div class="workspace-row-title mono">${r.runId}</div>
              <div class="workspace-row-meta">${r.eventCount} 个事件 · ${fmtTime(r.updatedAt)}</div>
            </div>
            <${StatusBadge} status=${r.status} />
          </button>`)}
      </div>` : null}
    <//>
    <${Section} title="最近会话">
      ${sessions.status === "loading" ? html`<${Spinner} label="正在加载会话" />` : null}
      ${sessions.status === "error" ? html`<${ErrorView} error=${sessions.error} onRetry=${sessions.retry} />` : null}
      ${sessions.status === "empty" ? html`<${EmptyView} title="暂无会话" hint="可从侧边栏新建会话。" />` : null}
      ${sessions.status === "ready" ? html`<div class="workspace-list">
        ${sessions.data.sessions.slice(0, 5).map((s) => html`
          <button key=${s.sessionId} class="workspace-row" onClick=${() => nav(`/chat/${s.sessionId}`)}>
            <div class="workspace-row-main">
              <div class="workspace-row-title">${s.lastUserText || "未命名会话"}</div>
              <div class="workspace-row-meta">${s.messageCount} 条消息</div>
            </div>
            <span class="muted">${fmtTime(s.startedAt)}</span>
          </button>`)}
      </div>` : null}
    <//>
    </div>
  </div>`;
}

export function ToolsPage() {
  const st = useAsync(() => api("/api/tools"), [], (d) => d.tools.length === 0);
  return html`<${Section} title="工具" sub="图运行可用的能力。">
    ${st.status === "loading" ? html`<${Spinner} label="正在加载能力" />` : null}
    ${st.status === "error" ? html`<${ErrorView} error=${st.error} onRetry=${st.retry} />` : null}
    ${st.status === "empty" ? html`<${EmptyView} title="暂无已注册能力" />` : null}
    ${st.status === "ready" ? html`
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>能力</th><th>类型</th><th>副作用</th><th>详情</th>
          </tr></thead>
          <tbody>
            ${st.data.tools.map((t) => html`<tr key=${t.capabilityId}>
              <td class="mono">${t.capabilityId}</td>
              <td class="mono">${t.nodeKind}</td>
              <td>${t.sideEffect}</td>
              <td><details class="inline-details"><summary>查看</summary>
                <div><span>功能</span><code>${t.featureId}</code></div>
                <div><span>成本</span><code>${t.costClass}</code></div>
                <div><span>超时</span><code>${t.timeoutMs}ms</code></div>
                <div><span>尝试次数</span><code>${t.maxAttempts}</code></div>
                <div><span>支持并行</span><code>${t.supportsParallel ? "是" : "否"}</code></div>
              </details></td>
            </tr>`)}
          </tbody>
        </table>
      </div>` : null}
  <//>`;
}

export function SettingsPage() {
  const features = useAsync(() => api("/api/features"), []);
  const health = useAsync(() => api("/api/health"), []);
  const sessions = useAsync(() => api("/api/sessions"), []);

  return html`<${Section} title="设置" sub="只读的运行时与治理配置。">
    <div class="notice">
      此适配器严格只读。功能开关、门禁和策略由
      <span class="mono">config/features/</span> 与图引擎治理；相关修改必须经过正常评审流程。
    </div>
    ${health.status === "error" ? html`<${ErrorView} error=${health.error} onRetry=${health.retry} />` : null}
    <details class="disclosure-card">
      <summary>适配器详情</summary>
      <div class="disclosure-body">
        <${KV} k="存储根目录" v=${health.data?.storeRoots?.join(", ") ?? (health.status === "error" ? "不可用" : "…")} mono />
        <${KV} k="会话工作区" v=${sessions.data?.workspaceCwd ?? "…"} mono />
      </div>
    </details>
    <h3 class="subhead">运行时功能</h3>
    ${features.status === "loading" ? html`<${Spinner} label="正在加载功能快照" />` : null}
    ${features.status === "error" ? html`<${ErrorView} error=${features.error} onRetry=${features.retry} />` : null}
    ${features.status === "ready" ? html`
      <details class="disclosure-card">
        <summary>功能注册表</summary>
        <div class="disclosure-body"><pre class="json">${JSON.stringify(features.data.registry, null, 2)}</pre></div>
      </details>
      ${features.data.runtimeProfileDefault ? html`
        <details class="disclosure-card">
          <summary>运行时配置（默认）</summary>
          <div class="disclosure-body"><pre class="json">${JSON.stringify(features.data.runtimeProfileDefault, null, 2)}</pre></div>
        </details>` : null}
    ` : null}
  <//>`;
}
