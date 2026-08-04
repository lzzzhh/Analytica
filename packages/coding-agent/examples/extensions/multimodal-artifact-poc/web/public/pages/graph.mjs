/* Analytica Web UI — Graph Runs pages.
 * GraphRunsPage: real run list replayed from GraphEventStore roots.
 * GraphRunPage: full Project Graph view (spec + replayed state + events),
 * Agent Loop projection strip, node/edge detail, phase filtering.
 * No hardcoded graphs: everything is derived from real events. */
import { useState, useEffect } from "/vendor/hooks.module.js";
import { api, appStore } from "/api.mjs";
import {
  EmptyView, ErrorView, HashText, KV, Section, Spinner, StatusBadge,
  fmtDuration, fmtTime, html, nodeKindLabel, nodeLabel, phaseLabel, statusLabel, useAsync, useLive,
} from "/ui.mjs";
import { GraphView } from "/graph-view.mjs";

export function GraphRunsPage({ nav }) {
  const st = useAsync(() => api("/api/graph/runs"), [], (d) => d.runs.length === 0);
  const [storeFilter, setStoreFilter] = useState("all");
  useLive(st.retry);

  const runs = st.data
    ? st.data.runs.filter((r) => storeFilter === "all" || r.storeLabel === storeFilter)
    : [];

  return html`<${Section} title="图运行" sub="根据图事件重建的执行历史。">
    <div class="row-actions">
      ${(st.data?.roots ?? []).map((label) => html`
        <button key=${label} class=${`chip ${storeFilter === label ? "chip-active" : ""}`}
          onClick=${() => setStoreFilter(label)}>${label}</button>`)}
      <button class=${`chip ${storeFilter === "all" ? "chip-active" : ""}`}
        onClick=${() => setStoreFilter("all")}>全部</button>
    </div>
    ${st.status === "loading" ? html`<${Spinner} label="正在加载图运行" />` : null}
    ${st.status === "error" ? html`<${ErrorView} error=${st.error} onRetry=${st.retry} />` : null}
    ${st.status === "empty" ? html`<${EmptyView} title="暂无图运行"
      hint="图事件存储中尚无运行目录。" />` : null}
    ${st.status === "ready" && runs.length === 0 ? html`<${EmptyView} title="当前存储中暂无运行" />` : null}
    ${runs.length > 0 ? html`
      <div class="workspace-list">
        ${runs.map((r) => html`
          <button key=${`${r.storeLabel}:${r.runId}`} class="workspace-row"
            onClick=${() => nav(`/graph-runs/${r.runId}?store=${r.storeLabel}`)}>
            <div class="workspace-row-main">
              <div class="workspace-row-title mono">${r.runId}</div>
              <div class="workspace-row-meta">
                ${r.nodeCount} 个节点 · ${r.eventCount} 个事件${r.revisionCycles > 0 ? ` · ${r.revisionCycles} 次修订` : ""} · ${fmtTime(r.updatedAt)}
              </div>
            </div>
            <${StatusBadge} status=${r.status} />
          </button>`)}
      </div>` : null}
  <//>`;
}

/* ---------- Agent Loop panel (pure projection, reusable in right panel) ---------- */

const PHASE_ICON = { plan: "1", retrieve: "2", analyze: "3", execute: "4", review: "5", iterate: "6" };

export function AgentLoopPanel({ runId, storeLabel, onPhaseClick, compact = false }) {
  const st = useAsync(() => api(`/api/graph/runs/${runId}/loop?store=${storeLabel}`), [runId, storeLabel]);
  useLive(st.retry);

  if (st.status === "loading") return html`<${Spinner} label="正在生成智能体循环" />`;
  if (st.status === "error") return html`<${ErrorView} error=${st.error} onRetry=${st.retry} />`;
  const loop = st.data;
  const currentPhaseLabel = loop.currentPhase ? phaseLabel(loop.currentPhase, loop.currentPhase) : null;

  return html`<div class="loop-panel">
    <div class="loop-meta muted">
      ${currentPhaseLabel ? html`当前阶段：<strong>${currentPhaseLabel}</strong>` : "运行已完成"}
      ${loop.revisionCycles > 0 ? ` · ${loop.revisionCycles} 次修订` : ""}
    </div>
    <div class=${compact ? "loop-steps loop-steps-compact" : "loop-steps"}>
      ${loop.phases.map((p) => html`
        <button key=${p.phaseId}
          class=${`loop-step loop-${p.status.toLowerCase()}`}
          onClick=${() => onPhaseClick?.(p)}
          aria-label=${`${phaseLabel(p.phaseId, p.label)}阶段，状态${statusLabel(p.status)}`}
          title=${`${phaseLabel(p.phaseId, p.label)}：${statusLabel(p.status)}${p.durationMs != null ? `，${fmtDuration(p.durationMs)}` : ""}`}
        >
          <span class="loop-icon" aria-hidden="true">${PHASE_ICON[p.phaseId] ?? "•"}</span>
          <span class="loop-label">${phaseLabel(p.phaseId, p.label)}</span>
          <span class="loop-status" title=${p.status}>${statusLabel(p.status)}</span>
          ${!compact ? html`<span class="loop-dur muted">${fmtDuration(p.durationMs)}</span>` : null}
        </button>`)}
    </div>
    ${!compact ? loop.phases.filter((p) => p.details.length > 0).map((p) => html`
      <details key=${p.phaseId} class="loop-details" open=${p.phaseId === "review" || p.phaseId === "iterate"}>
        <summary>${phaseLabel(p.phaseId, p.label)}详情</summary>
        <ul>${p.details.map((d, i) => html`<li key=${i} class="mono">${d}</li>`)}</ul>
      </details>`) : null}
  </div>`;
}

/* ---------- single run detail ---------- */

export function GraphRunPage({ params, query, nav }) {
  const runId = params[0];
  const store = query.store ?? "dev-seed";
  const st = useAsync(() => api(`/api/graph/runs/${runId}?store=${store}`), [runId, store]);
  const [selNodeId, setSelNodeId] = useState(query.node ?? null);
  const [selEdge, setSelEdge] = useState(null);
  const [phaseFilter, setPhaseFilter] = useState(null); // {phaseId, label, nodeIds}
  useLive(st.retry);

  // bind the right inspection panel to the run being viewed
  useEffect(() => {
    appStore.set({ rightPanelRun: { runId, storeLabel: store } });
  }, [runId, store]);

  if (st.status === "loading") return html`<${Spinner} label="正在从事件回放图运行" />`;
  if (st.status === "error") return html`<${ErrorView} error=${st.error} onRetry=${st.retry} />`;
  const run = st.data;

  const visibleSpec = (() => {
    if (!phaseFilter) return run.spec;
    const keep = new Set(phaseFilter.nodeIds);
    return {
      ...run.spec,
      nodes: run.spec.nodes.filter((n) => keep.has(n.nodeId)),
      edges: run.spec.edges.filter((e) => keep.has(e.fromNodeId) && keep.has(e.toNodeId)),
    };
  })();

  const selSpecNode = run.spec?.nodes.find((n) => n.nodeId === selNodeId) ?? null;
  const selRun = run.state.nodeRuns[selNodeId] ?? null;
  const nodeEvents = selNodeId ? run.events.filter((e) => e.nodeId === selNodeId) : [];

  const onPhaseClick = (p) => {
    if (p.nodeIds.length === 0 && p.phaseId !== "iterate") {
      setPhaseFilter(null);
      return;
    }
    setPhaseFilter(phaseFilter?.phaseId === p.phaseId ? null : { phaseId: p.phaseId, label: p.label, nodeIds: p.nodeIds });
  };

  return html`<div class="run-page">
    <div class="page-intro run-intro">
      <div class="run-heading">
        <button class="icon-btn" onClick=${() => nav("/graph-runs")} aria-label="返回图运行列表">←</button>
        <div>
          <h1 class="page-title">${run.spec?.objective ?? "图运行"}</h1>
          <div class="workspace-row-meta mono">${runId}</div>
        </div>
      </div>
      <${StatusBadge} status=${run.status} />
    </div>
    ${run.integrityIssues.length > 0 ? html`<div class="notice notice-error" role="alert">
      事件存储完整性问题：${run.integrityIssues.join("; ")}
    </div>` : null}
    ${phaseFilter ? html`<div class="notice">
      已筛选至<strong>${phaseLabel(phaseFilter.phaseId, phaseFilter.label)}</strong>阶段（${phaseFilter.nodeIds.length} 个节点）
      <button class="btn btn-small" onClick=${() => setPhaseFilter(null)}>清除筛选</button>
    </div>` : null}

    <${Section} title="项目图">
      ${visibleSpec ? html`<${GraphView}
        spec=${visibleSpec}
        state=${run.state}
        selectedNodeId=${selNodeId}
        focusNodeId=${query.node}
        onNodeClick=${(n) => setSelNodeId(selNodeId === n.nodeId ? null : n.nodeId)}
        onEdgeClick=${(e) => setSelEdge(selEdge?.edgeId === e.edgeId ? null : e)}
      />` : html`<${EmptyView} title="暂无图规范" />`}
      ${selEdge ? html`<div class="drawer drawer-inline">
        <div class="drawer-head">
          <strong>边 ${selEdge.edgeId}</strong>
          <button class="btn btn-small" onClick=${() => setSelEdge(null)} aria-label="关闭边详情">✕</button>
        </div>
        <${KV} k="类型" v=${selEdge.edgeType} mono />
        <${KV} k="来源" v=${html`<button class="hash mono" onClick=${() => setSelNodeId(selEdge.fromNodeId)}>${selEdge.fromNodeId}</button>`} />
        <${KV} k="目标" v=${html`<button class="hash mono" onClick=${() => setSelNodeId(selEdge.toNodeId)}>${selEdge.toNodeId}</button>`} />
        ${selEdge.artifactType ? html`<${KV} k="制品类型" v=${selEdge.artifactType} mono />` : null}
        ${selEdge.condition ? html`<${KV} k="条件" v=${JSON.stringify(selEdge.condition)} mono />` : null}
        ${selEdge.feedbackReasonCodes?.length ? html`<${KV} k="反馈原因" v=${selEdge.feedbackReasonCodes.join(", ")} mono />` : null}
      </div>` : null}
    <//>

    <${Section} title="智能体循环" sub="选择阶段以筛选项目图。">
      <${AgentLoopPanel} runId=${runId} storeLabel=${store} onPhaseClick=${onPhaseClick} />
    <//>

    <details class="disclosure-card">
      <summary>技术详情</summary>
      <div class="disclosure-body grid-kv">
        <${KV} k="运行 ID" v=${runId} mono />
        <${KV} k="存储" v=${store} mono />
        <${KV} k="图 ID" v=${run.graphId} mono />
        <${KV} k="图版本" v=${`v${run.graphVersion} (${run.specVersions.map((v) => `v${v}`).join(", ")})`} />
        <${KV} k="图内容哈希" v=${html`<${HashText} value=${run.graphContentHash} />`} />
        <${KV} k="功能快照" v=${html`<${HashText} value=${run.featureSnapshotHash} />`} />
        <${KV} k="事件" v=${String(run.events.length)} />
        <${KV} k="修订轮次" v=${String(run.revisionCycles)} />
        <${KV} k="创建时间" v=${fmtTime(run.state.createdAt)} />
        <${KV} k="更新时间" v=${fmtTime(run.state.updatedAt)} />
      </div>
    </details>

    ${selSpecNode ? html`<div class="drawer">
      <div class="drawer-head">
        <strong>节点 ${selSpecNode.nodeId}</strong>
        <${StatusBadge} status=${selRun?.status ?? "PENDING"} />
        <button class="btn btn-small" onClick=${() => setSelNodeId(null)} aria-label="关闭节点详情">✕</button>
      </div>
      <div class="grid-kv">
        <${KV} k="名称" v=${nodeLabel(selSpecNode.label)} />
        <${KV} k="类型" v=${nodeKindLabel(selSpecNode.kind)} />
        <${KV} k="能力" v=${selSpecNode.capabilityId} mono />
        <${KV} k="尝试次数" v=${`${selRun?.attempt ?? 0} / ${selSpecNode.maxAttempts}`} />
        ${selRun?.errorCode ? html`<${KV} k="错误码" v=${selRun.errorCode} mono />` : null}
        ${selRun?.retryable != null ? html`<${KV} k="可重试" v=${selRun.retryable ? "是" : "否"} />` : null}
        <${KV} k="开始时间" v=${fmtTime(selRun?.startedAt)} />
        <${KV} k="完成时间" v=${fmtTime(selRun?.completedAt)} />
        <${KV} k="输入契约" v=${selSpecNode.inputContract} mono />
        <${KV} k="输出契约" v=${selSpecNode.outputContract} mono />
        <${KV} k="副作用" v=${selSpecNode.sideEffect} mono />
        <${KV} k="超时" v=${`${selSpecNode.timeoutMs}ms`} />
      </div>
      ${selSpecNode.dependsOn.length > 0 ? html`<div class="kv"><div class="kv-k">依赖节点</div>
        <div class="kv-v">${selSpecNode.dependsOn.map((d) => html`
          <button key=${d} class="hash mono" onClick=${() => setSelNodeId(d)}>${d}</button> `)}</div></div>` : null}
      ${(selRun?.inputRefs ?? []).length > 0 ? html`<div class="kv"><div class="kv-k">输入制品</div>
        <div class="kv-v">${selRun.inputRefs.map((r) => html`
          <a key=${r.artifactId} class="hash mono" href=${`/artifacts/${r.artifactId}`}
            onClick=${(ev) => { ev.preventDefault(); nav(`/artifacts/${r.artifactId}`); }}>${r.artifactType}:${r.artifactId.slice(0, 12)}…</a> `)}</div></div>` : null}
      ${(selRun?.outputRefs ?? []).length > 0 ? html`<div class="kv"><div class="kv-k">输出制品</div>
        <div class="kv-v">${selRun.outputRefs.map((r) => html`
          <a key=${r.artifactId} class="hash mono" href=${`/artifacts/${r.artifactId}`}
            onClick=${(ev) => { ev.preventDefault(); nav(`/artifacts/${r.artifactId}`); }}>${r.artifactType}:${r.artifactId.slice(0, 12)}…</a> `)}</div></div>` : null}
      ${selRun?.summary ? html`<${KV} k="摘要" v=${selRun.summary} />` : null}
      ${nodeEvents.length > 0 ? html`<details class="loop-details" open>
        <summary>此节点的事件（${nodeEvents.length}）</summary>
        <${EventRows} events=${nodeEvents} />
      </details>` : null}
    </div>` : null}

    <details class="disclosure-card">
      <summary>事件流（${run.events.length}）</summary>
      <div class="disclosure-body"><${EventRows} events=${run.events} /></div>
    </details>
  </div>`;
}

function EventRows({ events }) {
  return html`<div class="event-list">
    ${events.map((ev) => html`
      <div key=${ev.eventId} class="event-row">
        <span class="mono muted">#${ev.sequence}</span>
        <span class="badge badge-${ev.eventType.includes("FAILED") || ev.eventType.includes("BLOCKED") ? "fail" : ev.eventType.includes("SUCCEEDED") || ev.eventType.includes("COMPLETED") ? "ok" : "run"}">${ev.eventType}</span>
        ${ev.nodeId ? html`<span class="mono">${ev.nodeId}</span>` : null}
        ${ev.errorCode ? html`<span class="mono event-err">${ev.errorCode}</span>` : null}
        ${ev.refs.length > 0 ? html`<span class="muted">${ev.refs.length} 个引用</span>` : null}
        <span class="muted">${fmtTime(ev.timestamp)}</span>
        <span class="mono muted event-hash" title=${ev.contentHash}>sha ${ev.contentHash.slice(0, 10)}…</span>
      </div>`)}
  </div>`;
}
