/* Analytica Web UI — shared components + hooks (Preact + htm, no build). */
import { h } from "/vendor/preact.module.js";
import { useEffect, useState, useCallback } from "/vendor/hooks.module.js";
import htm from "/vendor/htm.module.js";
import { onStoreChange } from "/api.mjs";

export const html = htm.bind(h);
export { h };

/* ---------- formatting ---------- */

export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  if (now - d < 7 * 86400e3) {
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

export function shortId(id, n = 14) {
  if (!id) return "—";
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

/* ---------- status system (never color-only: text label always shown) ---------- */

const STATUS_KIND = {
  COMPLETED: "ok", SUCCEEDED: "ok", PASS: "ok", READY: "ok", ARGS_VALIDATED: "ok",
  RUNNING: "run", CREATED: "run", IN_PROGRESS: "run",
  FAILED: "fail", BLOCKED: "fail", REJECT: "fail", ERROR: "fail",
  WAITING_FOR_HUMAN: "wait", WAITING: "wait", CHANGES_REQUIRED: "wait", ABSTAIN: "wait",
  PENDING: "idle", NOT_STARTED: "idle", SKIPPED: "idle", CANCELLED: "idle",
  UNREVIEWED_LOW_RISK: "wait",
};

const STATUS_LABEL = {
  COMPLETED: "已完成", SUCCEEDED: "成功", PASS: "通过", READY: "就绪", ARGS_VALIDATED: "参数已验证",
  RUNNING: "运行中", CREATED: "已创建", IN_PROGRESS: "进行中", called: "已调用",
  FAILED: "失败", BLOCKED: "已阻塞", REJECT: "已拒绝", ERROR: "错误",
  WAITING_FOR_HUMAN: "等待人工处理", WAITING: "等待中", CHANGES_REQUIRED: "需要修改", ABSTAIN: "暂不判断",
  PENDING: "待执行", NOT_STARTED: "未开始", SKIPPED: "已跳过", CANCELLED: "已取消",
  UNREVIEWED_LOW_RISK: "低风险未评审", COMMITTED: "已提交", UNCOMMITTED: "未提交",
  NOT_REVIEWED: "未评审", APPROVED: "已批准",
};

const PHASE_LABEL = {
  plan: "规划", retrieve: "检索", analyze: "分析", execute: "执行", review: "评审", iterate: "迭代",
};

const NODE_LABEL = {
  "Initial Artifacts": "初始制品",
  "Preflight Governance": "预检治理",
  "Fan-in Reducer": "汇聚器",
  "Review Gate": "评审门禁",
  Reviewer: "评审员",
  "Promotion Authorization": "发布授权",
  "analysis-report Skill": "分析报告技能",
  "Deliverable Verifier": "交付验证器",
  "Fetch sales dataset": "获取销售数据集",
};

const NODE_KIND_LABEL = {
  DETERMINISTIC: "确定性节点", TOOL: "工具", AGENT: "智能体", SKILL: "技能", REDUCER: "汇聚器", HUMAN_GATE: "人工门禁",
};

export function statusLabel(status) {
  return STATUS_LABEL[status] ?? status;
}

export function phaseLabel(phaseId, fallback = phaseId) {
  return PHASE_LABEL[phaseId] ?? fallback;
}

export function nodeLabel(label) {
  return NODE_LABEL[label] ?? label;
}

export function nodeKindLabel(kind) {
  return NODE_KIND_LABEL[kind] ?? kind;
}

export function StatusBadge({ status, kind }) {
  const k = kind || STATUS_KIND[status] || "idle";
  return html`<span class="badge badge-${k}" role="status" title=${status}>${statusLabel(status)}</span>`;
}

/* ---------- async states ---------- */

export function Spinner({ label = "加载中" }) {
  return html`<div class="state-box" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span><span>${label}…</span>
  </div>`;
}

export function ErrorView({ error, onRetry }) {
  return html`<div class="state-box state-error" role="alert">
    <span class="state-icon" aria-hidden="true">⚠</span>
    <div>
      <div class="state-title">加载失败</div>
      <div class="state-detail">${error?.code ? `[${error.code}] ` : ""}${error?.message || String(error)}</div>
      ${onRetry ? html`<button class="btn btn-small" onClick=${onRetry}>重试</button>` : null}
    </div>
  </div>`;
}

export function EmptyView({ title, hint }) {
  return html`<div class="state-box state-empty">
    <div class="state-title">${title}</div>
    ${hint ? html`<div class="state-detail">${hint}</div>` : null}
  </div>`;
}

/* ---------- data fetching hook with loading/empty/error/ready ---------- */

export function useAsync(loader, deps = [], isEmpty = null) {
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, status: "loading", error: null }));
    loader().then((data) => {
      if (!alive) return;
      const empty = isEmpty ? isEmpty(data) : false;
      setState({ status: empty ? "empty" : "ready", data, error: null });
    }).catch((error) => {
      if (!alive) return;
      setState({ status: "error", data: null, error });
    });
    return () => { alive = false; };
  }, [...deps, tick]);
  return { ...state, retry };
}

/* Re-fetch when the graph store reports a change (SSE-driven). */
export function useLive(refetch) {
  useEffect(() => onStoreChange(refetch), []);
}

/* ---------- generic building blocks ---------- */

export function Section({ title, actions, children, sub }) {
  return html`<section class="section">
    <div class="section-head">
      <div>
        <h2 class="section-title">${title}</h2>
        ${sub ? html`<div class="section-sub">${sub}</div>` : null}
      </div>
      <div class="section-actions">${actions}</div>
    </div>
    ${children}
  </section>`;
}

export function KV({ k, v, mono = false }) {
  return html`<div class="kv"><div class="kv-k">${k}</div><div class=${mono ? "kv-v mono" : "kv-v"}>${v ?? "—"}</div></div>`;
}

export function IconBtn({ label, onClick, children, active = false, disabled = false }) {
  return html`<button
    class=${`icon-btn ${active ? "icon-btn-active" : ""}`}
    onClick=${onClick}
    aria-label=${label}
    title=${label}
    disabled=${disabled}
  >${children}</button>`;
}

export function HashText({ value }) {
  const [full, setFull] = useState(false);
  if (!value) return html`<span>—</span>`;
  return html`<button class="hash mono" onClick=${() => setFull(!full)} title="点击展开">
    ${full ? value : `${value.slice(0, 12)}…`}
  </button>`;
}

export function TabBar({ tabs, active, onSelect }) {
  return html`<div class="tabbar" role="tablist">
    ${tabs.map((t) => html`<button
      key=${t.id}
      role="tab"
      aria-selected=${active === t.id}
      class=${`tab ${active === t.id ? "tab-active" : ""}`}
      onClick=${() => onSelect(t.id)}
    >${t.label}</button>`)}
  </div>`;
}
