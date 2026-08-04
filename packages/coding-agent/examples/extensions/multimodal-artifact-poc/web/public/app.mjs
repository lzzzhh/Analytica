/* Analytica Web UI — app shell: History-API router + two-pane workbench.
 * Left: global nav + New Session + Recent Sessions (real pi transcripts).
 * Center: routed page content.
 * Chat context: Project Graph / Agent Loop / Artifacts open on demand from
 * the chat top bar. No href="#" or dead buttons. */
import { render } from "/vendor/preact.module.js";
import { useEffect, useMemo, useState } from "/vendor/hooks.module.js";
import { api, appStore, refreshSessions, startLiveChannel } from "/api.mjs";
import {
  IconBtn, Spinner, StatusBadge, fmtTime, html, nodeKindLabel, nodeLabel, statusLabel, useAsync, useLive,
} from "/ui.mjs";
import { GraphView } from "/graph-view.mjs";
import { AgentLoopPanel } from "/pages/graph.mjs";
import { SessionsPage, ChatPage } from "/pages/chat.mjs";
import { GraphRunsPage, GraphRunPage } from "/pages/graph.mjs";
import { DatasetsPage, ReportsPage, ArtifactsPage, ArtifactDetailPage } from "/pages/data.mjs";
import { HomePage, ToolsPage, SettingsPage } from "/pages/misc.mjs";

/* ---------- router ---------- */

const ROUTES = [
  { pattern: /^\/$/, page: HomePage },
  { pattern: /^\/chat$/, page: SessionsPage },
  { pattern: /^\/chat\/([^/]+)$/, page: ChatPage },
  { pattern: /^\/datasets$/, page: DatasetsPage },
  { pattern: /^\/reports$/, page: ReportsPage },
  { pattern: /^\/graph-runs$/, page: GraphRunsPage },
  { pattern: /^\/graph-runs\/([^/]+)$/, page: GraphRunPage },
  { pattern: /^\/artifacts$/, page: ArtifactsPage },
  { pattern: /^\/artifacts\/([^/]+)$/, page: ArtifactDetailPage },
  { pattern: /^\/tools$/, page: ToolsPage },
  { pattern: /^\/settings$/, page: SettingsPage },
];

function parseRoute(path) {
  const [pathname, search = ""] = path.split("?");
  const query = Object.fromEntries(new URLSearchParams(search));
  for (const r of ROUTES) {
    const m = pathname.match(r.pattern);
    if (m) return { page: r.page, params: m.slice(1), query, pathname };
  }
  return { page: NotFound, params: [], query, pathname };
}

export function nav(path) {
  if (path === location.pathname + location.search) return;
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function NotFound({ pathname, nav }) {
  return html`<div class="state-box state-empty" role="alert">
    <div class="state-title">页面不存在</div>
    <div class="state-detail mono">${pathname}</div>
    <button class="btn btn-primary" onClick=${() => nav("/")}>返回首页</button>
  </div>`;
}

/* ---------- left sidebar ---------- */

const NAV_ITEMS = [
  { to: "/", icon: "⌂", label: "首页" },
  { to: "/chat", icon: "✉", label: "会话" },
  { to: "/datasets", icon: "▤", label: "数据集" },
  { to: "/reports", icon: "▦", label: "报告" },
  { to: "/graph-runs", icon: "◈", label: "图运行" },
  { to: "/artifacts", icon: "❖", label: "制品" },
  { to: "/tools", icon: "⚙", label: "工具" },
  { to: "/settings", icon: "☰", label: "设置" },
];

function Sidebar({ pathname, nav }) {
  const [store, setStore] = useState(appStore.get());
  useEffect(() => appStore.subscribe(setStore), []);

  const newSession = async () => {
    try {
      const created = await api("/api/sessions", { method: "POST" });
      await refreshSessions();
      nav(`/chat/${created.sessionId}`);
    } catch (err) {
      alert(`新建会话失败：${err.message}`);
    }
  };

  return html`<nav class="sidebar" aria-label="全局导航">
    <div class="brand">
      <img class="brand-mark" src="/analytica-mark.png" alt="" width="28" height="28" />
      <span class="brand-name">Analytica</span>
    </div>
    <button class="btn btn-new" onClick=${newSession} aria-label="新建会话">
      <span aria-hidden="true">＋</span> 新建会话
    </button>
    <ul class="nav-list">
      ${NAV_ITEMS.map((item) => {
        const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
        return html`<li key=${item.to}>
          <a class=${`nav-item ${active ? "nav-active" : ""}`} href=${item.to}
            aria-current=${active ? "page" : null}
            onClick=${(ev) => { ev.preventDefault(); nav(item.to); }}>
            <span class="nav-icon" aria-hidden="true">${item.icon}</span>${item.label}
          </a>
        </li>`;
      })}
    </ul>
    <div class="sidebar-section-title">最近会话</div>
    <div class="recent-list">
      ${store.sessionsError ? html`<div class="muted recent-err">会话不可用：${store.sessionsError.code}</div>` : null}
      ${!store.sessionsLoaded && !store.sessionsError ? html`<${Spinner} label="正在加载会话" />` : null}
      ${store.sessionsLoaded && store.sessions.length === 0 && !store.sessionsError
        ? html`<div class="muted">暂无会话。</div>` : null}
      ${store.sessions.slice(0, 12).map((s) => {
        const active = pathname === `/chat/${s.sessionId}`;
        return html`<a key=${s.sessionId}
          class=${`recent-item ${active ? "nav-active" : ""}`}
          href=${`/chat/${s.sessionId}`}
          aria-current=${active ? "page" : null}
          onClick=${(ev) => { ev.preventDefault(); nav(`/chat/${s.sessionId}`); }}
          title=${s.lastUserText || s.sessionId}
        >
          <span class="recent-text">${s.lastUserText || "未命名会话"}</span>
          <span class="recent-time muted">${fmtTime(s.startedAt)}</span>
        </a>`;
      })}
    </div>
  </nav>`;
}

/* ---------- chat context ---------- */

function ChatContextNav({ nav }) {
  const [store, setStore] = useState(appStore.get());
  useEffect(() => appStore.subscribe(setStore), []);
  const run = store.rightPanelRun;
  const [view, setView] = useState(null);

  const runSt = useAsync(
    () => (run ? api(`/api/graph/runs/${run.runId}?store=${run.storeLabel}`) : Promise.resolve(null)),
    [run?.runId, run?.storeLabel],
    () => !run,
  );
  useLive(runSt.retry);

  const ready = Boolean(run && runSt.status === "ready");
  const unavailableReason = !run
    ? "当前工作区尚未关联图运行。"
    : runSt.status === "error"
      ? `运行上下文不可用：${runSt.error.message}`
      : "正在加载运行上下文…";

  const contextItems = [
    { id: "graph", label: "项目图" },
    { id: "loop", label: "智能体循环" },
    { id: "artifacts", label: "制品" },
  ];

  return html`<div class="chat-context-nav" aria-label="当前会话上下文">
    ${contextItems.map((item) => html`
      <button key=${item.id} class="chat-context-tab" disabled=${!ready}
        title=${ready ? `打开${item.label}` : unavailableReason}
        onClick=${() => setView(item.id)}>
        ${item.label}
      </button>`)}
    ${view === "graph" && ready ? html`<${GraphDialog}
      run=${run}
      detail=${runSt.data}
      close=${() => setView(null)}
      nav=${nav}
    />` : null}
    ${(view === "loop" || view === "artifacts") && ready ? html`<${RunContextDialog}
      view=${view}
      run=${run}
      detail=${runSt.data}
      close=${() => setView(null)}
      nav=${nav}
    />` : null}
  </div>`;
}

function useDialogLifecycle(close) {
  useEffect(() => {
    const onKeyDown = (ev) => { if (ev.key === "Escape") close(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [close]);
}

function GraphDialog({ run, detail, close, nav }) {
  useDialogLifecycle(close);
  const [selectedNodeId, setSelectedNodeId] = useState(null);

  return html`<div class="graph-dialog-backdrop" onClick=${close}>
    <section class="graph-dialog" role="dialog" aria-modal="true" aria-label="项目图" onClick=${(ev) => ev.stopPropagation()}>
      <header class="graph-dialog-head">
        <div>
          <div class="eyebrow">项目图</div>
          <div class="graph-dialog-title mono">${run.runId}</div>
        </div>
        <div class="graph-dialog-actions">
          <${StatusBadge} status=${detail.status} />
          <button class="icon-btn" onClick=${close} aria-label="关闭项目图" autoFocus>✕</button>
        </div>
      </header>
      <div class="graph-dialog-workspace">
        <div class="graph-dialog-canvas">
          <${GraphView}
            spec=${detail.spec}
            state=${detail.state}
            selectedNodeId=${selectedNodeId}
            onNodeClick=${(node) => setSelectedNodeId(selectedNodeId === node.nodeId ? null : node.nodeId)}
          />
        </div>
        <${GraphInspector}
          run=${run}
          detail=${detail}
          selectedNodeId=${selectedNodeId}
          setSelectedNodeId=${setSelectedNodeId}
          close=${close}
          nav=${nav}
        />
      </div>
    </section>
  </div>`;
}

function GraphInspector({ run, detail, selectedNodeId, setSelectedNodeId, close, nav }) {
  const node = detail.spec.nodes.find((item) => item.nodeId === selectedNodeId) ?? null;
  const nodeRun = node ? detail.state.nodeRuns[node.nodeId] : null;
  const nodeEvents = node ? detail.events.filter((event) => event.nodeId === node.nodeId) : [];
  const nodeRuns = Object.values(detail.state.nodeRuns);
  const progressedNodes = nodeRuns.filter((item) => item.status !== "PENDING").length;

  if (!node) {
    return html`<aside class="graph-inspector" aria-label="图运行检查器">
      <div class="graph-inspector-head">
        <div>
          <div class="eyebrow">检查器</div>
          <div class="graph-inspector-title">运行概览</div>
        </div>
        <${StatusBadge} status=${detail.status} />
      </div>
      <div class="graph-inspector-section">
        <div class="graph-inspector-label">执行情况</div>
        <${InspectorRow} label="进度" value=${`${progressedNodes} / ${detail.spec.nodes.length} 个节点`} />
        <${InspectorRow} label="事件" value=${String(detail.events.length)} mono />
        <${InspectorRow} label="制品" value=${String(detail.state.artifactRefs.length)} mono />
        <${InspectorRow} label="修订" value=${String(detail.revisionCycles)} mono />
      </div>
      <div class="graph-inspector-section">
        <div class="graph-inspector-label">证据</div>
        <${InspectorRow} label="存储" value=${run.storeLabel} mono />
        <${InspectorRow} label="图版本" value=${`v${detail.graphVersion}`} mono />
        <${InspectorRow}
          label="完整性"
          value=${detail.integrityIssues.length === 0 ? "已验证 · 无回放问题" : `${detail.integrityIssues.length} 个问题`}
        />
      </div>
      <div class="graph-inspector-empty">选择节点以查看其状态、证据和制品。</div>
    </aside>`;
  }

  const status = nodeRun?.status ?? "PENDING";
  const inputRefs = nodeRun?.inputRefs ?? [];
  const outputRefs = nodeRun?.outputRefs ?? [];

  return html`<aside class="graph-inspector" aria-label="所选节点检查器" aria-live="polite">
    <div class="graph-inspector-head">
      <div class="graph-inspector-heading">
        <div class="eyebrow">检查器 · ${nodeKindLabel(node.kind)}</div>
        <div class="graph-inspector-title">${nodeLabel(node.label)}</div>
        <div class="mono muted">${node.nodeId}</div>
      </div>
      <${StatusBadge} status=${status} />
    </div>
    <div class="graph-inspector-section">
      <div class="graph-inspector-label">节点状态</div>
      <${InspectorRow} label="状态" value=${statusLabel(status)} />
      <${InspectorRow} label="证据" value=${nodeEvents.length > 0 ? `${nodeEvents.length} 个回放事件` : "无节点事件"} />
      <${InspectorRow} label="尝试次数" value=${`${nodeRun?.attempt ?? 0} / ${node.maxAttempts ?? "—"}`} mono />
      ${nodeRun?.errorCode ? html`<${InspectorRow} label="错误" value=${nodeRun.errorCode} mono danger />` : null}
      ${nodeRun?.startedAt ? html`<${InspectorRow} label="开始时间" value=${fmtTime(nodeRun.startedAt)} />` : null}
      ${nodeRun?.completedAt ? html`<${InspectorRow} label="完成时间" value=${fmtTime(nodeRun.completedAt)} />` : null}
      ${nodeRun?.summary ? html`<${InspectorRow} label="摘要" value=${nodeRun.summary} />` : null}
    </div>
    ${node.dependsOn.length > 0 ? html`<div class="graph-inspector-section">
      <div class="graph-inspector-label">依赖节点</div>
      <div class="graph-inspector-links">
        ${node.dependsOn.map((nodeId) => html`
          <button key=${nodeId} class="graph-inspector-link mono" onClick=${() => setSelectedNodeId(nodeId)}>${nodeId}</button>`)}
      </div>
    </div>` : null}
    ${inputRefs.length > 0 || outputRefs.length > 0 ? html`<div class="graph-inspector-section">
      <div class="graph-inspector-label">制品</div>
      ${inputRefs.map((artifactRef) => html`<${ArtifactInspectorLink} key=${`in:${artifactRef.artifactId}`} direction="输入" artifactRef=${artifactRef} close=${close} nav=${nav} />`)}
      ${outputRefs.map((artifactRef) => html`<${ArtifactInspectorLink} key=${`out:${artifactRef.artifactId}`} direction="输出" artifactRef=${artifactRef} close=${close} nav=${nav} />`)}
    </div>` : null}
    ${nodeEvents.length > 0 ? html`<div class="graph-inspector-section">
      <div class="graph-inspector-label">最近事件</div>
      ${nodeEvents.slice(-5).map((event) => html`<div key=${event.eventId} class="graph-inspector-event">
        <span class="mono">${event.eventType}</span><span class="muted">${fmtTime(event.timestamp)}</span>
      </div>`)}
    </div>` : null}
    <button class="btn graph-inspector-open" onClick=${() => {
      close();
      nav(`/graph-runs/${run.runId}?store=${run.storeLabel}&node=${node.nodeId}`);
    }}>打开节点详情</button>
  </aside>`;
}

function InspectorRow({ label, value, mono = false, danger = false }) {
  return html`<div class="graph-inspector-row">
    <span>${label}</span>
    <strong class=${`${mono ? "mono" : ""} ${danger ? "graph-inspector-danger" : ""}`}>${value}</strong>
  </div>`;
}

function ArtifactInspectorLink({ direction, artifactRef, close, nav }) {
  return html`<button class="graph-artifact-link" onClick=${() => {
    close();
    nav(`/artifacts/${artifactRef.artifactId}`);
  }}>
    <span>${direction}</span>
    <strong class="mono">${artifactRef.artifactId}</strong>
    <small>${artifactRef.artifactType}</small>
  </button>`;
}

function RunContextDialog({ view, run, detail, close, nav }) {
  useDialogLifecycle(close);
  const artifacts = detail.state?.artifactRefs ?? [];
  const title = view === "loop" ? "智能体循环" : "制品";

  return html`<div class="graph-dialog-backdrop" onClick=${close}>
    <section class="graph-dialog run-context-dialog" role="dialog" aria-modal="true" aria-label=${title}
      onClick=${(ev) => ev.stopPropagation()}>
      <header class="graph-dialog-head">
        <div>
          <div class="eyebrow">当前会话</div>
          <div class="graph-dialog-title">${title} <span class="mono muted">${run.runId}</span></div>
        </div>
        <div class="graph-dialog-actions">
          <${StatusBadge} status=${detail.status} />
          <button class="icon-btn" onClick=${close} aria-label=${`关闭${title}`} autoFocus>✕</button>
        </div>
      </header>
      <div class="run-context-body">
        ${view === "loop" ? html`<${AgentLoopPanel}
          runId=${run.runId}
          storeLabel=${run.storeLabel}
          onPhaseClick=${() => { close(); nav(`/graph-runs/${run.runId}?store=${run.storeLabel}`); }}
        />` : null}
        ${view === "artifacts" ? html`
          ${artifacts.length === 0 ? html`<div class="state-box state-empty">
            <div class="state-title">暂无制品</div>
            <div class="state-detail">本次运行尚未生成任何制品。</div>
          </div>` : null}
          <div class="workspace-list">
            ${artifacts.map((artifact) => html`
              <button key=${artifact.artifactId} class="workspace-row"
                onClick=${() => { close(); nav(`/artifacts/${artifact.artifactId}`); }}>
                <div class="workspace-row-main">
                  <div class="workspace-row-title mono">${artifact.artifactId}</div>
                  <div class="workspace-row-meta">由 ${artifact.createdByNodeId} 创建</div>
                </div>
                <span class="badge badge-run">${artifact.artifactType}</span>
              </button>`)}
          </div>` : null}
      </div>
    </section>
  </div>`;
}

/* ---------- shell ---------- */

function App() {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const onPop = () => setPath(location.pathname + location.search);
    window.addEventListener("popstate", onPop);
    refreshSessions();
    startLiveChannel();
    // keep the sidebar session list fresh
    const t = setInterval(refreshSessions, 30000);
    return () => { window.removeEventListener("popstate", onPop); clearInterval(t); };
  }, []);

  const route = useMemo(() => parseRoute(path), [path]);
  const Page = route.page;
  const currentNav = NAV_ITEMS.find((item) => item.to === "/" ? route.pathname === "/" : route.pathname.startsWith(item.to));
  const isChatDetail = route.page === ChatPage;

  return html`<div class="shell">
    <${Sidebar} pathname=${route.pathname} nav=${nav} />
    <main class="main" id="main">
      <div class="topbar">
        <span class="topbar-title">${currentNav?.label ?? "Analytica"}</span>
        ${isChatDetail ? html`<${ChatContextNav} nav=${nav} />` : null}
      </div>
      <div class="content">
        <${Page} params=${route.params} query=${route.query} pathname=${route.pathname} nav=${nav} />
      </div>
    </main>
  </div>`;
}

render(html`<${App} />`, document.getElementById("root"));
