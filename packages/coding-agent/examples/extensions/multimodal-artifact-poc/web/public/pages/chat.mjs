/* Analytica Web UI — Chat / Sessions pages. */
import { useState, useRef, useEffect } from "/vendor/hooks.module.js";
import { api, appStore, refreshSessions } from "/api.mjs";
import { EmptyView, ErrorView, Section, Spinner, StatusBadge, fmtTime, html, useAsync } from "/ui.mjs";

export function SessionsPage({ nav }) {
  const st = useAsync(() => api("/api/sessions"), [], (d) => d.sessions.length === 0);
  const [creating, setCreating] = useState(false);

  const newSession = async () => {
    setCreating(true);
    try {
      const created = await api("/api/sessions", { method: "POST" });
      await refreshSessions();
      nav(`/chat/${created.sessionId}`);
    } catch (err) {
      alert(`新建会话失败：${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  return html`<${Section} title="会话" sub="继续最近的工作，或开始新的对话。">
    <div class="row-actions">
      <button class="btn btn-primary" onClick=${newSession} disabled=${creating}>
        ${creating ? "正在创建…" : "+ 新建会话"}
      </button>
    </div>
    ${st.status === "loading" ? html`<${Spinner} label="正在加载会话" />` : null}
    ${st.status === "error" ? html`<${ErrorView} error=${st.error} onRetry=${st.retry} />` : null}
    ${st.status === "empty" ? html`<${EmptyView} title="暂无会话" hint="新建会话即可开始。" />` : null}
    ${st.status === "ready" ? html`
      <div class="workspace-list">
        ${st.data.sessions.map((s) => html`
          <button key=${s.sessionId} class="workspace-row" onClick=${() => nav(`/chat/${s.sessionId}`)}>
            <div class="workspace-row-main">
              <div class="workspace-row-title">${s.lastUserText || "未命名会话"}</div>
              <div class="workspace-row-meta">${s.messageCount} 条消息</div>
            </div>
            <span class="muted">${fmtTime(s.startedAt)}</span>
          </button>`)}
      </div>` : null}
  <//>`;
}

export function ChatPage({ params, nav }) {
  const sessionId = params[0];
  const st = useAsync(() => api(`/api/sessions/${sessionId}`), [sessionId]);
  const [text, setText] = useState("");
  const [sendState, setSendState] = useState(null); // null | sending | unwired | error
  const [boundRun, setBoundRun] = useState(null);
  const endRef = useRef(null);

  // Bind the chat context controls to the newest graph run of this workspace.
  useEffect(() => {
    api("/api/graph/runs").then((d) => {
      if (d.runs.length > 0) {
        const run = d.runs[0];
        setBoundRun(run);
        appStore.set({ rightPanelRun: { runId: run.runId, storeLabel: run.storeLabel } });
      } else {
        appStore.set({ rightPanelRun: null });
      }
    }).catch(() => appStore.set({ rightPanelRun: null }));
  }, [sessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [st.data, sendState]);

  const send = async () => {
    const clean = text.trim();
    if (!clean) return;
    setSendState("sending");
    try {
      const res = await api(`/api/sessions/${sessionId}/messages`, { method: "POST", body: { text: clean } });
      setText("");
      if (res.agentRuntimeAttached === false) {
        setSendState("unwired");
      } else {
        setSendState(null);
      }
      st.retry();
      refreshSessions();
    } catch (err) {
      setSendState(`发送失败：${err.message}`);
    }
  };

  const onKeyDown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send();
    }
  };

  return html`<div class="chat-page">
    <div class="chat-header">
      <span class="chat-title">对话</span>
      <details class="context-details">
        <summary>详情</summary>
        <div class="context-popover">
          <div><span>会话</span><code>${sessionId}</code></div>
          ${st.data ? html`<div><span>工作区</span><code>${st.data.cwd}</code></div>` : null}
          ${boundRun ? html`<div><span>运行上下文</span><code>${boundRun.runId}</code><${StatusBadge} status=${boundRun.status} /></div>` : null}
        </div>
      </details>
    </div>
    <div class="chat-scroll">
      ${st.status === "loading" ? html`<${Spinner} label="正在加载对话记录" />` : null}
      ${st.status === "error" ? html`<${ErrorView} error=${st.error} onRetry=${st.retry} />` : null}
      ${st.status === "ready" && st.data.entries.length === 0 ? html`<${EmptyView} title="空会话" hint="在下方发送第一条消息。" />` : null}
      ${st.status === "ready" ? st.data.entries.map((e, i) => {
        if (e.type === "message") {
          const isUser = e.role === "user";
          return html`<div key=${i} class=${`msg ${isUser ? "msg-user" : "msg-agent"}`}>
            <div class="msg-role">${isUser ? "你" : "Analytica"}</div>
            <div class="msg-text">${e.text || ""}</div>
            <div class="msg-time">${fmtTime(e.timestamp)}</div>
          </div>`;
        }
        if (e.type === "toolCall") {
          return html`<div key=${i} class="msg msg-tool">
            <span class="badge badge-run">工具</span>
            <span class="mono">${e.toolName ?? "tool"}</span>
            <${StatusBadge} status="called" kind="run" />
          </div>`;
        }
        if (e.type === "toolResult") {
          return html`<div key=${i} class="msg msg-tool">
            <span class="badge badge-${e.toolState === "error" ? "fail" : "ok"}">结果</span>
            <span class="mono">${e.toolName ?? "tool"}</span>
            <${StatusBadge} status=${e.toolState === "error" ? "ERROR" : "SUCCEEDED"} />
          </div>`;
        }
        if (e.type === "model_change") {
          return html`<div key=${i} class="msg msg-meta mono">模型：${e.model}</div>`;
        }
        return null;
      }) : null}
      <div ref=${endRef}></div>
    </div>
    <div class="composer-shell">
      <textarea
        class="composer-input"
        rows="3"
        placeholder="向 Analytica 提问…"
        value=${text}
        onInput=${(ev) => setText(ev.target.value)}
        onKeyDown=${onKeyDown}
        aria-label="消息输入框"
      ></textarea>
      <button class="composer-send" onClick=${send} disabled=${!text.trim() || sendState === "sending"} aria-label="发送消息">
        ${sendState === "sending" ? "…" : "↑"}
      </button>
    </div>
    ${sendState === "unwired" ? html`<div class="notice notice-warn" role="status">
      消息已保存。当前适配器尚未连接智能体运行时。
    </div>` : null}
    ${typeof sendState === "string" && sendState.startsWith("发送失败") ? html`<div class="notice notice-error" role="alert">${sendState}</div>` : null}
  </div>`;
}
