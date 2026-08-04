/* Analytica Web UI — Project Graph renderer.
 * Collision-safe layered DAG: real GraphSpec nodes/edges + replayed NodeRunState.
 * Supports pan, wheel zoom, fit-to-canvas, recenter, keyboard focus, and
 * click-through for nodes (detail drawer) and edges (type + refs).
 */
import { useEffect, useMemo, useRef, useState } from "/vendor/hooks.module.js";
import { html, nodeKindLabel, nodeLabel, statusLabel } from "/ui.mjs";

const NODE_W = 190;
const NODE_H = 68;
const LAYER_GAP_X = 250;
const NODE_GAP_Y = 100;
const MAX_LABEL_UNITS = 22;
const MAX_BYPASS_LANES = 6;
const BYPASS_LANE_GAP = 18;

const KIND_GLYPH = {
  DETERMINISTIC: "◆",
  TOOL: "⚙",
  AGENT: "▲",
  SKILL: "✦",
  REDUCER: "≣",
  HUMAN_GATE: "⏸",
};

const STATUS_STYLE = {
  PENDING: "st-idle",
  READY: "st-ready",
  RUNNING: "st-run",
  SUCCEEDED: "st-ok",
  FAILED: "st-fail",
  BLOCKED: "st-fail",
  WAITING_FOR_HUMAN: "st-wait",
  SKIPPED: "st-idle",
  CANCELLED: "st-idle",
};

function textUnits(value) {
  return [...value].reduce((total, char) => total + (/[^\u0000-\u00ff]/.test(char) ? 2 : char === " " ? 0.7 : 1), 0);
}

function labelLines(value) {
  const lines = [];
  let line = "";
  let units = 0;

  for (const char of [...value]) {
    const charUnits = textUnits(char);
    if (line && units + charUnits > MAX_LABEL_UNITS) {
      const breakAt = line.lastIndexOf(" ");
      if (breakAt > 4) {
        lines.push(line.slice(0, breakAt));
        line = `${line.slice(breakAt + 1)}${char}`;
        units = textUnits(line);
      } else {
        lines.push(line);
        line = char === " " ? "" : char;
        units = char === " " ? 0 : charUnits;
      }
    } else {
      line += char;
      units += charUnits;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= 2) return lines;

  let second = lines[1];
  while (second && textUnits(`${second}…`) > MAX_LABEL_UNITS) second = second.slice(0, -1);
  return [lines[0], `${second.trimEnd()}…`];
}

function clippedText(value, maxUnits) {
  if (textUnits(value) <= maxUnits) return value;
  let clipped = value;
  while (clipped && textUnits(`${clipped}…`) > maxUnits) clipped = clipped.slice(0, -1);
  return `${clipped.trimEnd()}…`;
}

function layout(spec) {
  // Sugiyama-style longest-path ranking over declared dependencies and real
  // forward edges. FEEDBACK edges are excluded so revision cycles stay routable.
  const layerOf = new Map();
  const byId = new Map(spec.nodes.map((n) => [n.nodeId, n]));
  const orderInSpec = new Map(spec.nodes.map((node, index) => [node.nodeId, index]));
  const predecessors = new Map(spec.nodes.map((node) => [node.nodeId, new Set()]));
  for (const node of spec.nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (byId.has(dependency)) predecessors.get(node.nodeId).add(dependency);
    }
  }
  for (const edge of spec.edges) {
    if (edge.edgeType !== "FEEDBACK" && byId.has(edge.fromNodeId) && byId.has(edge.toNodeId)) {
      predecessors.get(edge.toNodeId).add(edge.fromNodeId);
    }
  }

  const depth = (nodeId, visiting = new Set()) => {
    if (layerOf.has(nodeId)) return layerOf.get(nodeId);
    if (visiting.has(nodeId)) return 0;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(nodeId);
    const deps = [...predecessors.get(nodeId)];
    const rank = deps.length === 0 ? 0 : Math.max(...deps.map((dependency) => depth(dependency, nextVisiting))) + 1;
    layerOf.set(nodeId, rank);
    return rank;
  };
  for (const n of spec.nodes) depth(n.nodeId);

  const layers = new Map();
  for (const [nodeId, l] of layerOf) {
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l).push(nodeId);
  }

  const orderInLayer = new Map();
  const maxLayer = Math.max(0, ...layers.keys());
  for (let layer = 0; layer <= maxLayer; layer++) {
    const ids = layers.get(layer) ?? [];
    ids.sort((a, b) => {
      const barycenter = (nodeId) => {
        const prior = [...predecessors.get(nodeId)].filter((dependency) => orderInLayer.has(dependency));
        if (prior.length === 0) return orderInSpec.get(nodeId);
        return prior.reduce((total, dependency) => total + orderInLayer.get(dependency), 0) / prior.length;
      };
      return barycenter(a) - barycenter(b) || orderInSpec.get(a) - orderInSpec.get(b);
    });
    ids.forEach((id, index) => orderInLayer.set(id, index));
  }

  const longForwardEdges = spec.edges.filter((edge) => {
    const delta = (layerOf.get(edge.toNodeId) ?? 0) - (layerOf.get(edge.fromNodeId) ?? 0);
    return edge.edgeType !== "FEEDBACK" && delta > 1;
  });
  const lowerBypassEdges = spec.edges.filter((edge) => {
    const delta = (layerOf.get(edge.toNodeId) ?? 0) - (layerOf.get(edge.fromNodeId) ?? 0);
    return edge.edgeType === "FEEDBACK" || delta <= 0;
  });
  const topLaneCount = Math.min(MAX_BYPASS_LANES, longForwardEdges.length);
  const bottomLaneCount = Math.min(MAX_BYPASS_LANES, lowerBypassEdges.length);
  const topMargin = 56 + topLaneCount * BYPASS_LANE_GAP;
  const maxLayerSize = Math.max(1, ...[...layers.values()].map((ids) => ids.length));
  const nodeBandHeight = (maxLayerSize - 1) * NODE_GAP_Y + NODE_H;
  const pos = new Map();
  for (const [l, ids] of layers) {
    const layerHeight = (ids.length - 1) * NODE_GAP_Y + NODE_H;
    const layerOffset = (nodeBandHeight - layerHeight) / 2;
    ids.forEach((id, i) => {
      pos.set(id, {
        x: l * LAYER_GAP_X + 48,
        y: topMargin + layerOffset + i * NODE_GAP_Y,
      });
    });
  }
  const graphBottom = topMargin + nodeBandHeight;
  return {
    pos,
    layerOf,
    graphBottom,
    topLaneCount,
    bottomLaneCount,
    bounds: {
      w: maxLayer * LAYER_GAP_X + NODE_W + 96,
      h: graphBottom + 60 + bottomLaneCount * BYPASS_LANE_GAP,
    },
  };
}

const EDGE_STYLE = {
  CONTROL: { cls: "edge-control", dash: null },
  ARTIFACT: { cls: "edge-artifact", dash: null },
  FEEDBACK: { cls: "edge-feedback", dash: "7 5" },
  DECISION: { cls: "edge-decision", dash: "2 4" },
};

function routedEdges(spec, graphLayout) {
  const pairGroups = new Map();
  for (const edge of spec.edges) {
    const pair = `${edge.fromNodeId}->${edge.toNodeId}`;
    if (!pairGroups.has(pair)) pairGroups.set(pair, []);
    pairGroups.get(pair).push(edge.edgeId);
  }

  let upperLane = 0;
  let lowerLane = 0;
  return spec.edges.map((edge) => {
    const from = graphLayout.pos.get(edge.fromNodeId);
    const to = graphLayout.pos.get(edge.toNodeId);
    if (!from || !to) return null;
    const fromLayer = graphLayout.layerOf.get(edge.fromNodeId) ?? 0;
    const toLayer = graphLayout.layerOf.get(edge.toNodeId) ?? 0;
    const layerDelta = toLayer - fromLayer;
    const siblings = pairGroups.get(`${edge.fromNodeId}->${edge.toNodeId}`);
    const parallelOffset = (siblings.indexOf(edge.edgeId) - (siblings.length - 1) / 2) * 9;
    let d;

    if (edge.edgeType === "FEEDBACK" || layerDelta <= 0) {
      const lane = lowerLane++ % Math.max(1, graphLayout.bottomLaneCount);
      const laneY = graphLayout.graphBottom + 32 + lane * BYPASS_LANE_GAP;
      const x1 = from.x + NODE_W / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + NODE_W / 2;
      const y2 = to.y + NODE_H;
      d = `M ${x1} ${y1} C ${x1} ${y1 + 24}, ${x1} ${laneY}, ${x1} ${laneY} L ${x2} ${laneY} C ${x2} ${laneY}, ${x2} ${y2 + 24}, ${x2} ${y2}`;
    } else if (layerDelta > 1) {
      const lane = upperLane++ % Math.max(1, graphLayout.topLaneCount);
      const laneY = 30 + lane * BYPASS_LANE_GAP;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      d = `M ${x1} ${y1} C ${x1 + 28} ${y1}, ${x1 + 28} ${laneY}, ${x1 + 56} ${laneY} L ${x2 - 56} ${laneY} C ${x2 - 28} ${laneY}, ${x2 - 28} ${y2}, ${x2} ${y2}`;
    } else {
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const bend = Math.max(32, (x2 - x1) / 2);
      d = `M ${x1} ${y1} C ${x1 + bend} ${y1 + parallelOffset}, ${x2 - bend} ${y2 + parallelOffset}, ${x2} ${y2}`;
    }
    return { e: edge, d };
  }).filter(Boolean);
}

export function GraphView({ spec, state, selectedNodeId, onNodeClick, onEdgeClick, focusNodeId }) {
  const wrapRef = useRef(null);
  const [tf, setTf] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);

  const graphLayout = useMemo(() => layout(spec), [spec]);
  const pos = graphLayout.pos;
  const bounds = graphLayout.bounds;

  const fit = (minimumScale = 0.25, alignStart = false) => {
    const el = wrapRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const k = Math.min(1.2, Math.max(minimumScale, Math.min(width / bounds.w, height / bounds.h)));
    const fittedWidth = bounds.w * k;
    setTf({
      k,
      x: alignStart && fittedWidth > width ? 24 : (width - fittedWidth) / 2,
      y: (height - bounds.h * k) / 2,
    });
  };

  useEffect(() => { fit(0.55, true); }, [bounds.w, bounds.h]);

  useEffect(() => {
    // recenter on focused node (e.g. from Artifact Linkage "locate in graph")
    if (!focusNodeId || !pos.has(focusNodeId) || !wrapRef.current) return;
    const p = pos.get(focusNodeId);
    const { width, height } = wrapRef.current.getBoundingClientRect();
    setTf((t) => ({ ...t, x: width / 2 - (p.x + NODE_W / 2) * t.k, y: height / 2 - (p.y + NODE_H / 2) * t.k }));
  }, [focusNodeId]);

  const onWheel = (ev) => {
    ev.preventDefault();
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    setTf((t) => {
      const k = Math.min(2.5, Math.max(0.2, t.k * (ev.deltaY < 0 ? 1.12 : 0.89)));
      return { k, x: mx - ((mx - t.x) / t.k) * k, y: my - ((my - t.y) / t.k) * k };
    });
  };

  const onMouseDown = (ev) => {
    if (ev.button !== 0) return;
    setDragging({ sx: ev.clientX, sy: ev.clientY, ox: tf.x, oy: tf.y });
  };
  const onMouseMove = (ev) => {
    if (!dragging) return;
    setTf((t) => ({ ...t, x: dragging.ox + ev.clientX - dragging.sx, y: dragging.oy + ev.clientY - dragging.sy }));
  };
  const stopDrag = () => setDragging(null);

  const edges = routedEdges(spec, graphLayout);

  return html`<div class="graph-wrap" ref=${wrapRef}>
    <div class="graph-toolbar" role="toolbar" aria-label="图控制">
      <button class="btn btn-small" onClick=${() => fit()} aria-label="适应画布" title="显示完整图">适应</button>
      <button class="btn btn-small" onClick=${() => setTf({ x: 20, y: 20, k: 1 })} aria-label="重置视图" title="重置为原始比例">1:1</button>
      <button class="btn btn-small" onClick=${() => setTf((t) => ({ ...t, k: Math.min(2.5, t.k * 1.2) }))} aria-label="放大" title="放大">+</button>
      <button class="btn btn-small" onClick=${() => setTf((t) => ({ ...t, k: Math.max(0.2, t.k / 1.2) }))} aria-label="缩小" title="缩小">−</button>
    </div>
    <svg
      class="graph-svg"
      role="img"
      aria-label="项目图"
      onWheel=${onWheel}
      onMouseDown=${onMouseDown}
      onMouseMove=${onMouseMove}
      onMouseUp=${stopDrag}
      onMouseLeave=${stopDrag}
    >
      <g transform=${`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" class="arrow-head" />
          </marker>
        </defs>
        ${edges.map(({ e, d }, i) => {
          const style = EDGE_STYLE[e.edgeType] ?? EDGE_STYLE.CONTROL;
          const isSel = selectedEdge === e.edgeId;
          return html`<g key=${e.edgeId}>
            <path class=${`edge-hit ${isSel ? "edge-selected" : ""}`} d=${d}
              tabindex="0"
              role="button"
              aria-label=${`${e.edgeType} 边：从 ${e.fromNodeId} 到 ${e.toNodeId}`}
              onClick=${(ev) => { ev.stopPropagation(); setSelectedEdge(isSel ? null : e.edgeId); onEdgeClick?.(e); }}
              onKeyDown=${(ev) => { if (ev.key === "Enter") { ev.stopPropagation(); setSelectedEdge(isSel ? null : e.edgeId); onEdgeClick?.(e); } }}
            />
            <path class=${`${style.cls} ${isSel ? "edge-selected" : ""}`} d=${d}
              stroke-dasharray=${style.dash} marker-end="url(#arrow)" pointer-events="none" />
          </g>`;
        })}
        ${spec.nodes.map((n) => {
          const run = state?.nodeRuns?.[n.nodeId];
          const status = run?.status ?? "PENDING";
          const stCls = STATUS_STYLE[status] ?? "st-idle";
          const p = pos.get(n.nodeId);
          const isSel = selectedNodeId === n.nodeId;
          const displayLabel = nodeLabel(n.label);
          const lines = labelLines(displayLabel);
          const statusText = clippedText(`${statusLabel(status)}${run?.attempt > 1 ? ` · 第 ${run.attempt} 次` : ""}${run?.errorCode ? ` · ${run.errorCode}` : ""}`, 30);
          return html`<g
            key=${n.nodeId}
            class=${`gnode ${stCls} ${isSel ? "gnode-selected" : ""}`}
            transform=${`translate(${p.x},${p.y})`}
            tabindex="0"
            role="button"
            aria-label=${`节点 ${displayLabel}，类型 ${nodeKindLabel(n.kind)}，状态 ${statusLabel(status)}`}
            onClick=${(ev) => { ev.stopPropagation(); onNodeClick?.(n, run); }}
            onKeyDown=${(ev) => { if (ev.key === "Enter") { ev.stopPropagation(); onNodeClick?.(n, run); } }}
          >
            <rect class="gnode-box" width=${NODE_W} height=${NODE_H} rx="9" />
            <text class="gnode-glyph" x="12" y=${lines.length === 1 ? "28" : "22"}>${KIND_GLYPH[n.kind] ?? "●"}</text>
            <text class="gnode-label" x="32" y=${lines.length === 1 ? "28" : "21"}>
              ${lines.map((line, index) => html`<tspan key=${index} x="32" dy=${index === 0 ? "0" : "15"}>${line}</tspan>`)}
            </text>
            <text class="gnode-status" x="12" y="57">${statusText}</text>
          </g>`;
        })}
      </g>
    </svg>
    <details class="graph-legend">
      <summary>图例</summary>
      <div class="legend-grid">
        <span><i class="sw st-ok"></i>成功</span>
        <span><i class="sw st-run"></i>运行中</span>
        <span><i class="sw st-fail"></i>失败或阻塞</span>
        <span><i class="sw st-wait"></i>等待人工处理</span>
        <span><i class="sw st-idle"></i>待执行或已跳过</span>
        <span><i class="ln edge-control-ln"></i>控制边</span>
        <span><i class="ln edge-artifact-ln"></i>制品传递边</span>
        <span><i class="ln edge-feedback-ln"></i>反馈边（虚线）</span>
        <span><i class="ln edge-decision-ln"></i>决策边（点线）</span>
        <span>◆ 确定性节点　⚙ 工具　▲ 智能体　✦ 技能　≣ 汇聚器　⏸ 人工门禁</span>
      </div>
    </details>
  </div>`;
}
