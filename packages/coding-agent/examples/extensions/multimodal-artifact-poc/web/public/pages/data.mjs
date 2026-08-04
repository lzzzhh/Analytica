/* Analytica Web UI — Datasets / Reports / Artifacts pages.
 * All data comes from the read-only adapter over the real ArtifactStore
 * and GraphEventStore; raw data bytes are never served. */
import { useState } from "/vendor/hooks.module.js";
import { api } from "/api.mjs";
import {
  EmptyView, ErrorView, HashText, KV, Section, Spinner, StatusBadge,
  fmtTime, html, useAsync,
} from "/ui.mjs";

/* ---------- Datasets ---------- */

export function DatasetsPage({ nav }) {
  const st = useAsync(() => api("/api/datasets"), [], (d) => d.registeredArtifacts.length === 0 && d.analysisRunsUsingInputs.length === 0);

  return html`<${Section} title="数据集" sub="可用于分析的已注册输入。">
    ${st.status === "loading" ? html`<${Spinner} label="正在加载数据集" />` : null}
    ${st.status === "error" ? html`<${ErrorView} error=${st.error} onRetry=${st.retry} />` : null}
    ${st.status === "empty" ? html`<${EmptyView} title="暂无已注册数据集" hint="制品存储中尚未注册任何输入。" />` : null}
    ${st.status === "ready" ? html`
      <details class="disclosure-card compact-disclosure">
        <summary>存储详情</summary>
        <div class="disclosure-body"><${KV} k="存储位置" v=${st.data.storeDir} mono /></div>
      </details>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>数据集</th><th>类型</th><th>状态</th><th>创建时间</th><th></th>
          </tr></thead>
          <tbody>
            ${st.data.registeredArtifacts.map((a) => html`<tr key=${a.artifactId}>
              <td class="mono">${a.artifactId}</td>
              <td class="mono">${a.meta?.contentType ?? "dataset"}</td>
              <td><${StatusBadge} status=${a.committed ? "COMMITTED" : "UNCOMMITTED"} kind=${a.committed ? "ok" : "wait"} /></td>
              <td class="muted">${fmtTime(a.meta?.createdAt)}</td>
              <td><a class="btn btn-small" href=${`/artifacts/${a.artifactId}`}
                onClick=${(ev) => { ev.preventDefault(); nav(`/artifacts/${a.artifactId}`); }}>查看血缘</a></td>
            </tr>`)}
          </tbody>
        </table>
      </div>
      ${st.data.registeredArtifacts.length === 0 ? html`<${EmptyView} title="暂无已注册输入" />` : null}
      ${st.data.analysisRunsUsingInputs.length > 0 ? html`
        <details class="disclosure-card">
          <summary>分析使用情况（${st.data.analysisRunsUsingInputs.length}）</summary>
          <div class="disclosure-body workspace-list">
            ${st.data.analysisRunsUsingInputs.map((r) => html`
              <div key=${r.runDirName} class="workspace-row static-row">
                <div class="workspace-row-main"><div class="workspace-row-title mono">${r.runDirName}</div><div class="workspace-row-meta">${r.inputs.length} 个输入</div></div>
                ${r.inputs.slice(0, 1).map((id) => html`<button key=${id} class="hash mono" onClick=${() => nav(`/artifacts/${id}`)}>打开输入</button>`)}
              </div>`)}
          </div>
        </details>` : null}
    ` : null}
  <//>`;
}

/* ---------- Reports / analysis results ---------- */

const SEVERITY_KIND = { LOW: "idle", MEDIUM: "wait", HIGH: "fail", CRITICAL: "fail" };

export function ReportsPage() {
  const st = useAsync(() => api("/api/reports"), [], (d) => d.analysisReports.length === 0 && d.graphReports.length === 0);
  const [showAll, setShowAll] = useState(false);
  const analysisReports = st.data?.analysisReports ?? [];
  const visibleAnalysisReports = showAll ? analysisReports : analysisReports.slice(0, 12);

  return html`<${Section} title="报告" sub="分析结果与已完成交付。">
    ${st.status === "loading" ? html`<${Spinner} label="正在加载报告" />` : null}
    ${st.status === "error" ? html`<${ErrorView} error=${st.error} onRetry=${st.retry} />` : null}
    ${st.status === "empty" ? html`<${EmptyView} title="暂无报告" hint="完成的分析和图运行将显示在这里。" />` : null}
    ${st.status === "ready" ? html`
      <h3 class="subhead">分析结果（${st.data.analysisReports.length}）</h3>
      <div class="report-list">
        ${visibleAnalysisReports.map((r) => html`<${AnalysisRunCard} key=${r.runDirName} run=${r} />`)}
      </div>
      ${analysisReports.length > 12 ? html`<button class="btn list-more" onClick=${() => setShowAll(!showAll)}>
        ${showAll ? "收起" : `显示全部 ${analysisReports.length} 项`}
      </button>` : null}
      <h3 class="subhead">图交付（${st.data.graphReports.length}）</h3>
      <div class="workspace-list">
        ${st.data.graphReports.map((r) => html`
          <a key=${`${r.storeLabel}:${r.runId}`} class="workspace-row" href=${`/graph-runs/${r.runId}?store=${r.storeLabel}`}>
            <div class="workspace-row-main">
              <div class="workspace-row-title mono">${r.runId}</div>
              <div class="workspace-row-meta">更新于 ${fmtTime(r.updatedAt)}</div>
            </div>
            <${StatusBadge} status=${r.status} />
          </a>`)}
      </div>
      ${st.data.graphReports.length === 0 ? html`<${EmptyView} title="暂无已完成图运行" />` : null}
    ` : null}
  <//>`;
}

function AnalysisRunCard({ run }) {
  const [open, setOpen] = useState(false);
  // lazy: only fetch when the card is expanded
  const st = useAsync(
    () => (open ? api(`/api/analysis/runs/${run.runDirName}`) : Promise.resolve(null)),
    [open],
    () => !open,
  );
  const toggle = () => setOpen(!open);

  return html`<div class="report-row">
    <div class="card-top">
      <button class="report-toggle" onClick=${toggle} aria-expanded=${open}>${open ? "▾" : "▸"} <span class="mono">${run.runDirName}</span></button>
      <div class="card-meta-inline">
        ${run.hasPlan ? html`<span class="badge badge-run">计划</span>` : null}
        ${run.hasCode ? html`<span class="badge badge-run">代码</span>` : null}
        ${run.hasResult ? html`<span class="badge badge-ok">结果</span>` : null}
        ${run.hasFindings ? html`<span class="badge badge-wait">发现</span>` : null}
        <span class="muted">${fmtTime(run.createdAt)}</span>
      </div>
    </div>
    ${open ? html`<div class="report-body">
      ${st.status === "loading" ? html`<${Spinner} label="正在加载分析详情" />` : null}
      ${st.status === "error" ? html`<${ErrorView} error=${st.error} onRetry=${st.retry} />` : null}
      ${st.status === "ready" ? html`<${AnalysisResultView} detail=${st.data} />` : null}
    </div>` : null}
  </div>`;
}

function AnalysisResultView({ detail }) {
  const result = detail.result;
  const findings = detail.findings?.findings ?? [];
  return html`<div>
    ${result ? html`
      <${KV} k="标题" v=${result.title ?? detail.runDirName} />
      <${KV} k="状态" v=${html`<${StatusBadge} status=${result.status ?? "READY"} />`} />
      <${KV} k="评审状态" v=${html`<${StatusBadge} status=${result.reviewStatus ?? "NOT_REVIEWED"} kind=${result.reviewStatus === "APPROVED" ? "ok" : "wait"} />`} />
      ${(result.sections ?? []).map((s, i) => {
        if (s.type === "METRIC_CARDS") {
          return html`<div key=${i} class="metric-grid">
            ${(s.metrics ?? []).map((m) => html`
              <div key=${m.metricId} class="metric-card">
                <div class="metric-label">${m.label ?? m.metricId}</div>
                <div class="metric-value">${typeof m.value === "number" ? m.value.toLocaleString(undefined, { maximumFractionDigits: m.precision ?? 2 }) : String(m.value)}</div>
              </div>`)}
          </div>`;
        }
        return html`<pre key=${i} class="json">${JSON.stringify(s, null, 2)}</pre>`;
      })}
    ` : html`<div class="muted">本次运行没有 analysis-result.json。</div>`}
    ${findings.length > 0 ? html`
      <h3 class="subhead">发现（${findings.length}）</h3>
      ${findings.map((f) => html`
        <div key=${f.findingId} class="finding">
          <span class="badge badge-${SEVERITY_KIND[f.severity] ?? "idle"}">${f.severity}</span>
          <span class="badge badge-run">${f.category ?? f.code}</span>
          <span>${f.claim}</span>
          ${f.limitations?.length ? html`<span class="muted">限制：${f.limitations.join(", ")}</span>` : null}
        </div>`)}
    ` : null}
    ${detail.codeFiles?.length ? html`<${KV} k="代码文件" v=${detail.codeFiles.join(", ")} mono />` : null}
  </div>`;
}

/* ---------- Artifact linkage ---------- */

export function ArtifactsPage({ nav }) {
  const st = useAsync(() => api("/api/artifacts"), [], (d) => d.graphArtifacts.length === 0 && d.registeredArtifacts.length === 0);
  const [typeFilter, setTypeFilter] = useState("all");

  const all = st.data ? [
    ...st.data.graphArtifacts.map((a) => ({ ...a, origin: "graph" })),
    ...st.data.registeredArtifacts.map((a) => ({
      artifactId: a.artifactId,
      artifactType: a.artifactType,
      contentHash: a.contentHash,
      createdByNodeId: a.committed ? "artifact-store" : "uncommitted",
      runIds: [],
      origin: "store",
    })),
  ] : [];
  const types = [...new Set(all.map((a) => a.artifactType))].sort();
  const rows = all.filter((a) => typeFilter === "all" || a.artifactType === typeFilter);

  return html`<${Section} title="制品" sub="跨图运行和已注册输入的血缘关系。">
    ${st.status === "loading" ? html`<${Spinner} label="正在加载制品" />` : null}
    ${st.status === "error" ? html`<${ErrorView} error=${st.error} onRetry=${st.retry} />` : null}
    ${st.status === "empty" ? html`<${EmptyView} title="暂无制品" hint="图运行产生引用或注册输入后，制品会显示在这里。" />` : null}
    ${st.status === "ready" ? html`
      <div class="row-actions">
        <button class=${`chip ${typeFilter === "all" ? "chip-active" : ""}`} onClick=${() => setTypeFilter("all")}>全部（${all.length}）</button>
        ${types.map((t) => html`<button key=${t} class=${`chip ${typeFilter === t ? "chip-active" : ""}`} onClick=${() => setTypeFilter(t)}>${t}</button>`)}
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>制品</th><th>类型</th><th>运行</th></tr></thead>
          <tbody>
            ${rows.map((a) => html`<tr key=${`${a.origin}:${a.artifactId}`}>
              <td><a class="mono link" href=${`/artifacts/${a.artifactId}`}
                onClick=${(ev) => { ev.preventDefault(); nav(`/artifacts/${a.artifactId}`); }}>${a.artifactId.slice(0, 22)}…</a></td>
              <td class="mono">${a.artifactType}</td>
              <td>${a.runIds.length > 0 ? a.runIds.map((rid) => html`<span key=${rid} class="badge badge-idle">${rid.slice(0, 16)}</span> `) : html`<span class="muted">—</span>`}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    ` : null}
  <//>`;
}

export function ArtifactDetailPage({ params, nav }) {
  const artifactId = params[0];
  const st = useAsync(() => api(`/api/artifacts/${artifactId}/lineage`), [artifactId]);

  if (st.status === "loading") return html`<${Spinner} label="正在加载制品血缘" />`;
  if (st.status === "error") return html`<${ErrorView} error=${st.error} onRetry=${st.retry} />`;
  const lin = st.data;

  return html`<div>
    <div class="page-head">
      <button class="btn btn-small" onClick=${() => nav("/artifacts")} aria-label="返回制品列表">← 制品</button>
      <h1 class="page-title mono">${artifactId.length > 28 ? `${artifactId.slice(0, 28)}…` : artifactId}</h1>
      <span class="badge badge-run">${lin.artifactType}</span>
    </div>
    <${Section} title="制品" sub="快照元数据与血缘关系。">
      <details class="disclosure-card">
        <summary>技术详情</summary>
        <div class="disclosure-body grid-kv">
        <${KV} k="制品 ID" v=${artifactId} mono />
        <${KV} k="制品类型" v=${lin.artifactType} mono />
        <${KV} k="内容哈希" v=${html`<${HashText} value=${lin.contentHash} />`} />
        ${lin.metaHash ? html`<${KV} k="元数据哈希" v=${html`<${HashText} value=${lin.metaHash} />`} />` : null}
        ${lin.registeredMeta ? html`
          <${KV} k="注册位置" v=${"制品存储（输入）"} />
          ${lin.registeredMeta.createdAt ? html`<${KV} k="创建时间" v=${fmtTime(lin.registeredMeta.createdAt)} />` : null}
          ${lin.registeredMeta.schema ? html`<${KV} k="模式" v=${JSON.stringify(lin.registeredMeta.schema)} mono />` : null}
        ` : html`<${KV} k="注册位置" v=${"仅存在图引用（不是已存储输入）"} />`}
        </div>
      </details>
      ${lin.registeredMeta ? html`<details class="loop-details">
        <summary>完整注册元数据（查询快照）</summary>
        <pre class="json">${JSON.stringify(lin.registeredMeta, null, 2)}</pre>
      </details>` : null}
    <//>
    <${Section} title="血缘" sub="来自节点输入/输出引用的生产者和消费者。">
      ${lin.producers.length === 0 && lin.consumers.length === 0
        ? html`<${EmptyView} title="图运行中没有血缘信息" hint="没有节点运行引用此制品。" />`
        : html`
          <h3 class="subhead">生产者（${lin.producers.length}）</h3>
          ${lin.producers.map((p, i) => html`
            <div key=${i} class="lineage-row">
              <span class="badge badge-ok">生产者</span>
              <span class="mono">${p.nodeId}</span>
              <span class="muted">运行</span>
              <a class="mono link" href=${`/graph-runs/${p.runId}?store=${p.storeLabel}&node=${p.nodeId}`}
                onClick=${(ev) => { ev.preventDefault(); nav(`/graph-runs/${p.runId}?store=${p.storeLabel}&node=${p.nodeId}`); }}>${p.runId}</a>
              <button class="btn btn-small" onClick=${() => nav(`/graph-runs/${p.runId}?store=${p.storeLabel}&node=${p.nodeId}`)}>在图中定位</button>
            </div>`)}
          <h3 class="subhead">消费者（${lin.consumers.length}）</h3>
          ${lin.consumers.map((c, i) => html`
            <div key=${i} class="lineage-row">
              <span class="badge badge-run">消费者</span>
              <span class="mono">${c.nodeId}</span>
              <span class="muted">运行</span>
              <a class="mono link" href=${`/graph-runs/${c.runId}?store=${c.storeLabel}&node=${c.nodeId}`}
                onClick=${(ev) => { ev.preventDefault(); nav(`/graph-runs/${c.runId}?store=${c.storeLabel}&node=${c.nodeId}`); }}>${c.runId}</a>
              <button class="btn btn-small" onClick=${() => nav(`/graph-runs/${c.runId}?store=${c.storeLabel}&node=${c.nodeId}`)}>在图中定位</button>
            </div>`)}
          ${lin.consumers.length === 0 ? html`<div class="muted">未发现下游消费者。</div>` : null}
        `}
    <//>
  </div>`;
}
