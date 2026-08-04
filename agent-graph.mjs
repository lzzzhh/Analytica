/**
 * Graph Runtime reconstruction.
 *
 * Rebuilds a project-level Graph Run view from real pi session data:
 * sessions are clustered into runs, each session is mapped onto business
 * graph nodes, and node status / artifacts / review / rework / concurrency /
 * error classification are all derived from real JSONL evidence.
 */

// ----------------------------------------------------------------------------
// Graph topology: the 13-node business graph
// ----------------------------------------------------------------------------

export const GRAPH_NODES = [
	{ id: "req", title: "Requirement Planning", zh: "需求规划", wave: 1 },
	{ id: "input", title: "Input Resolver", zh: "输入解析", wave: 2 },
	{ id: "preflight", title: "Preflight Governance", zh: "数据治理", wave: 3 },
	{ id: "analysis", title: "Data Analysis", zh: "数据分析", wave: 4 },
	{ id: "quality", title: "Data Quality", zh: "质量检查", wave: 5 },
	{ id: "lineage", title: "Lineage", zh: "血缘追踪", wave: 5 },
	{ id: "snapshot", title: "Snapshot", zh: "数据快照", wave: 5 },
	{ id: "fanin", title: "Fan-in", zh: "汇合点", wave: 6 },
	{ id: "review_gate", title: "Review Gate", zh: "审核闸门", wave: 7 },
	{ id: "reviewer", title: "Reviewer", zh: "审核员", wave: 8 },
	{ id: "promotion", title: "Promotion Authorization", zh: "发布授权", wave: 9 },
	{ id: "report", title: "Analysis Report", zh: "报告生成", wave: 10 },
	{ id: "verify", title: "Deliverable Verification", zh: "交付验证", wave: 11 },
];

// kind: control | artifact | decision | feedback
export const GRAPH_EDGES = [
	{ from: "req", to: "input", kind: "control" },
	{ from: "input", to: "preflight", kind: "control" },
	{ from: "preflight", to: "analysis", kind: "control" },
	{ from: "analysis", to: "quality", kind: "control" },
	{ from: "analysis", to: "lineage", kind: "control" },
	{ from: "analysis", to: "snapshot", kind: "control" },
	{ from: "quality", to: "fanin", kind: "control" },
	{ from: "lineage", to: "fanin", kind: "control" },
	{ from: "snapshot", to: "fanin", kind: "control" },
	{ from: "fanin", to: "review_gate", kind: "control" },
	{ from: "review_gate", to: "reviewer", kind: "control" },
	{ from: "reviewer", to: "promotion", kind: "decision", label: "PASS" },
	{ from: "reviewer", to: "analysis", kind: "feedback", label: "CHANGES_REQUIRED" },
	{ from: "snapshot", to: "analysis", kind: "artifact", label: "数据快照" },
	{ from: "analysis", to: "report", kind: "artifact", label: "分析结果" },
	{ from: "promotion", to: "report", kind: "control" },
	{ from: "report", to: "verify", kind: "control" },
];

const NODE_TOPO_ORDER = GRAPH_NODES.map((n) => n.id);

// ----------------------------------------------------------------------------
// Session -> node mapping (real tool signatures)
// ----------------------------------------------------------------------------

const TOOL_NODE_MAP = [
	["prepare_business_task", "req"],
	["pipeline_ingest", "input"],
	["write_gate_check", "preflight"],
	["governance_dashboard", "preflight"],
	["execute_query", "analysis"],
	["validate_query", "analysis"],
	["run_data_analysis", "analysis"],
	["inspect_dataset", "analysis"],
	["search_catalog", "analysis"],
	["parse_visual", "analysis"],
	["parse_image", "analysis"],
	["get_data_quality", "quality"],
	["explain_lineage", "lineage"],
	["get_snapshot", "snapshot"],
];

export function mapSessionToNodesPublic(parsed) {
	return mapSessionToNodes(parsed);
}

export function primaryNodeOf(nodes) {
	return (
		[...nodes.keys()].sort((a, b) => NODE_TOPO_ORDER.indexOf(a) - NODE_TOPO_ORDER.indexOf(b))[0] ??
		"analysis"
	);
}

function mapSessionToNodes(parsed) {
	const nodes = new Map(); // nodeId -> { calls, errors, firstTs, lastTs }
	const bump = (id, ts, isError) => {
		const e = nodes.get(id) ?? { calls: 0, errors: 0, firstTs: ts, lastTs: ts };
		e.calls++;
		if (isError) e.errors++;
		if (ts < e.firstTs) e.firstTs = ts;
		if (ts > e.lastTs) e.lastTs = ts;
		nodes.set(id, e);
	};

	for (const turn of parsed.turns) {
		for (const tc of turn.toolCalls) {
			const mapped = TOOL_NODE_MAP.find(([t]) => t === tc.name)?.[1];
			if (mapped) bump(mapped, tc.ts ?? turn.ts, tc.isError);
		}
	}
	// reviewer sessions identified by prompt content
	if (/you are (a |an )?reviewer|reviewer agent/i.test(parsed.preview ?? "")) {
		bump("review_gate", parsed.start, false);
		bump("reviewer", parsed.start, false);
	}
	// report: analysis-report skill or markdown report writes
	const hasReportSkill = /analysis-report|分析报告/.test(parsed.preview ?? "");
	const wroteReport = parsed.turns.some((t) =>
		t.toolCalls.some((tc) => tc.name === "write" && /报告|report.*\.md|\.md/i.test(tc.args)),
	);
	if (hasReportSkill || wroteReport) bump("report", parsed.start, false);
	return nodes;
}

// ----------------------------------------------------------------------------
// Error classification
// ----------------------------------------------------------------------------

export function classifyError(text) {
	const t = (text ?? "").toLowerCase();
	if (/timed? ?out|etimedout|超时/.test(t)) return "timeout";
	if (/permission|eacces|eperm|denied|权限/.test(t)) return "permission";
	if (/validation failed|must be|invalid (argument|input)|missing required|schema/.test(t))
		return "input_error";
	if (/exited with code|exit code|non-zero|no such file|not found|command failed/.test(t))
		return "command_failed";
	if (/review|gate|blocked|finding/.test(t)) return "review_blocked";
	if (/cancel|abort|interrupt|取消/.test(t)) return "human_cancel";
	if (/traceback|exception|error:|stack trace|typeerror|referenceerror/.test(t)) return "system_error";
	return "system_error";
}

export const ERROR_CATEGORIES = {
	retryable: ["command_failed", "timeout"],
	fatal: ["system_error", "permission", "input_error", "review_blocked", "human_cancel"],
};

const ERROR_LABELS = {
	command_failed: "命令失败(可重试)",
	timeout: "超时(可重试)",
	system_error: "系统错误",
	permission: "权限错误",
	input_error: "输入/校验错误",
	review_blocked: "审核阻断",
	human_cancel: "人工取消",
};

// ----------------------------------------------------------------------------
// Reviewer verdict extraction
// ----------------------------------------------------------------------------

function extractReviewVerdict(parsed) {
	let text = "";
	for (const turn of parsed.turns) {
		for (const step of turn.steps) {
			if (step.kind === "assistant") text += `\n${step.text ?? ""}`;
		}
	}
	const findings = [];
	const fm = text.match(/"findings"\s*:\s*\[(.*?)\]/s);
	if (fm && fm[1].trim()) {
		for (const m of fm[1].matchAll(/"(summary|title|description)"\s*:\s*"([^"]+)"/g)) {
			findings.push(m[2]);
		}
	}
	if (/changes_required|changes required|需要修改|返工/.test(text)) {
		return { verdict: "CHANGES_REQUIRED", findings, text: text.slice(0, 500) };
	}
	if (/abstain|弃权/.test(text)) return { verdict: "ABSTAIN", findings, text: text.slice(0, 500) };
	if (/pass|通过|\{\s*"findings"\s*:\s*\[\s*\]/.test(text)) {
		return { verdict: "PASS", findings, text: text.slice(0, 500) };
	}
	return { verdict: findings.length ? "CHANGES_REQUIRED" : "ABSTAIN", findings, text: text.slice(0, 500) };
}

// ----------------------------------------------------------------------------
// Artifact extraction (write/edit calls -> versioned artifacts)
// ----------------------------------------------------------------------------

function extractArtifacts(runSessions) {
	const byPath = new Map();
	for (const rs of runSessions) {
		for (const turn of rs.parsed.turns) {
			for (const tc of turn.toolCalls) {
				if (tc.name !== "write" && tc.name !== "edit") continue;
				let path;
				try {
					const args = JSON.parse(tc.args.endsWith("}") ? tc.args : `${tc.args}}`.slice(0, 300));
					path = args.path ?? args.file_path;
				} catch {
					const m = tc.args.match(/"(?:path|file_path)"\s*:\s*"([^"]+)"/);
					path = m?.[1];
				}
				if (!path) continue;
				const list = byPath.get(path) ?? [];
				list.push({ ts: tc.ts ?? turn.ts, producerNode: rs.primaryNode, tool: tc.name, isError: tc.isError });
				byPath.set(path, list);
			}
		}
	}
	const artifacts = [];
	for (const [path, versions] of byPath) {
		versions.sort((a, b) => new Date(a.ts) - new Date(b.ts));
		const name = path.split("/").pop();
		versions.forEach((v, i) => {
			artifacts.push({
				id: `${path}#v${i + 1}`,
				path,
				name,
				version: i + 1,
				versionsTotal: versions.length,
				ts: v.ts,
				producerNode: v.producerNode,
				current: i === versions.length - 1,
				superseded: i < versions.length - 1,
				consumedBy: consumerHeuristic(path),
			});
		});
	}
	artifacts.sort((a, b) => new Date(a.ts) - new Date(b.ts));
	return artifacts;
}

function consumerHeuristic(path) {
	if (/report|报告.*\.md|\.md$/.test(path)) return ["verify", "user"];
	if (/snapshot|快照/.test(path)) return ["analysis"];
	if (/schema|spec|pipeline/.test(path)) return ["preflight", "input"];
	if (/\.(py|sh|sql|ts|js)$/.test(path)) return ["analysis"];
	return ["analysis"];
}

// ----------------------------------------------------------------------------
// Run clustering
// ----------------------------------------------------------------------------

const CLUSTER_GAP_MS = 3 * 3600 * 1000; // 3h between session starts

export function clusterSessions(summaries) {
	const sorted = [...summaries].sort(
		(a, b) => new Date(a.start ?? 0).getTime() - new Date(b.start ?? 0).getTime(),
	);
	const clusters = [];
	let current = null;
	for (const s of sorted) {
		const startMs = new Date(s.start ?? 0).getTime();
		if (!current || startMs - current.lastStartMs > CLUSTER_GAP_MS) {
			current = { sessions: [], firstMs: startMs, lastMs: startMs, lastStartMs: startMs };
			clusters.push(current);
		}
		current.sessions.push(s);
		current.lastStartMs = startMs;
		current.lastMs = Math.max(current.lastMs, new Date(s.end ?? s.start ?? 0).getTime());
	}
	return clusters;
}

// ----------------------------------------------------------------------------
// Build full graph run detail
// ----------------------------------------------------------------------------

export function buildGraphRun(runId, runSessions) {
	// runSessions: [{ summary, parsed, primaryNode, nodes: Map }]
	const nodeEvidence = new Map(); // nodeId -> aggregated
	for (const rs of runSessions) {
		for (const [nodeId, ev] of rs.nodes) {
			const agg = nodeEvidence.get(nodeId) ?? {
				calls: 0,
				errors: 0,
				firstTs: ev.firstTs,
				lastTs: ev.lastTs,
				sessions: [],
			};
			agg.calls += ev.calls;
			agg.errors += ev.errors;
			if (ev.firstTs < agg.firstTs) agg.firstTs = ev.firstTs;
			if (ev.lastTs > agg.lastTs) agg.lastTs = ev.lastTs;
			if (!agg.sessions.includes(rs.summary.file)) agg.sessions.push(rs.summary.file);
			nodeEvidence.set(nodeId, agg);
		}
	}

	// reviewer verdict
	let review = null;
	for (const rs of runSessions) {
		if (rs.nodes.has("reviewer")) {
			const v = extractReviewVerdict(rs.parsed);
			review = { ...v, sessionFile: rs.summary.file, ts: rs.summary.end ?? rs.summary.start };
			break;
		}
	}

	// rework: sessions hitting analysis after reviewer completed
	let reworkCount = 0;
	if (review) {
		const reviewMs = new Date(review.ts).getTime();
		for (const rs of runSessions) {
			if (rs.nodes.has("analysis") && new Date(rs.summary.start).getTime() > reviewMs) reworkCount++;
		}
	}
	const reworkMax = 1;
	const verdict = review?.verdict ?? null;

	// node status derivation
	const upstreamOf = (id) =>
		GRAPH_EDGES.filter((e) => e.to === id && e.kind === "control").map((e) => e.from);
	const status = new Map();
	const evidenceOrder = [...nodeEvidence.entries()].sort(
		(a, b) => new Date(a[1].firstTs) - new Date(b[1].firstTs),
	);
	const lastEvidenceNode = evidenceOrder.length ? evidenceOrder[evidenceOrder.length - 1][0] : null;

	for (const node of GRAPH_NODES) {
		const ev = nodeEvidence.get(node.id);
		if (ev) {
			const errRatio = ev.calls ? ev.errors / ev.calls : 0;
			if (errRatio > 0.6 && ev.errors >= 2) status.set(node.id, "failed");
			else if (node.id === "reviewer" && verdict === "CHANGES_REQUIRED") status.set(node.id, "changes_required");
			else status.set(node.id, "succeeded");
			continue;
		}
		// no evidence
		const upstream = upstreamOf(node.id);
		const upFailed = upstream.some((u) => status.get(u) === "failed" || status.get(u) === "changes_required");
		const upDone = upstream.length > 0 && upstream.every((u) => status.get(u) === "succeeded");
		if (node.id === "promotion" && verdict === "PASS") {
			status.set(node.id, "succeeded");
		} else if (node.id === "promotion" && verdict && verdict !== "PASS") {
			status.set(node.id, "blocked");
		} else if (upFailed) {
			status.set(node.id, "blocked");
		} else if (upDone) {
			status.set(node.id, node.id === lastEvidenceNode ? "running" : "ready");
		} else {
			status.set(node.id, "pending");
		}
	}
	// fan-in waits for all three parallel nodes
	const parallel = ["quality", "lineage", "snapshot"];
	const parallelDone = parallel.every((p) => status.get(p) === "succeeded");
	if (!nodeEvidence.get("fanin")) {
		if (parallelDone && status.get("analysis") === "succeeded") status.set("fanin", "ready");
		else if (parallel.some((p) => status.get(p) !== "succeeded" && nodeEvidence.get(p))) status.set("fanin", "waiting");
	}
	// live: latest session ended less than 2 min ago -> mark ready node as running
	const liveMs = Date.now() - new Date(runSessions[runSessions.length - 1]?.summary.end ?? 0).getTime();
	const live = liveMs < 120_000;
	if (live) {
		for (const [id, st] of status) {
			if (st === "ready") {
				status.set(id, "running");
				break;
			}
		}
	}

	// graph events
	const events = [];
	const runStart = runSessions[0]?.summary.start;
	const runEnd = runSessions[runSessions.length - 1]?.summary.end;
	events.push({ kind: "graph_created", ts: runStart });
	for (const [nodeId, ev] of evidenceOrder) {
		events.push({ kind: "node_started", node: nodeId, ts: ev.firstTs });
		const st = status.get(nodeId);
		if (st === "succeeded") events.push({ kind: "node_succeeded", node: nodeId, ts: ev.lastTs });
		else if (st === "failed") events.push({ kind: "node_failed", node: nodeId, ts: ev.lastTs });
	}
	if (review) {
		events.push({ kind: "review_completed", ts: review.ts, verdict: review.verdict });
		if (review.verdict === "CHANGES_REQUIRED") events.push({ kind: "revision_requested", ts: review.ts });
		if (review.findings.length)
			events.push({ kind: "human_action_required", ts: review.ts, detail: review.findings[0] });
	}
	if (verdict === "PASS") events.push({ kind: "promotion_granted", ts: review?.ts });
	if (status.get("verify") === "succeeded") events.push({ kind: "graph_completed", ts: runEnd });
	events.sort((a, b) => new Date(a.ts ?? 0) - new Date(b.ts ?? 0));

	// error classification across all sessions
	const errorClasses = {};
	let totalErrors = 0;
	for (const rs of runSessions) {
		for (const turn of rs.parsed.turns) {
			for (const step of turn.steps) {
				if (step.kind !== "toolResult" || !step.isError) continue;
				totalErrors++;
				const cls = classifyError(step.text);
				errorClasses[cls] = (errorClasses[cls] ?? 0) + 1;
			}
		}
	}

	// concurrency: sweep line over session intervals
	const intervals = runSessions.map((rs) => [
		new Date(rs.summary.start).getTime(),
		new Date(rs.summary.end ?? rs.summary.start).getTime(),
	]);
	let maxConcurrent = 1;
	for (const [s] of intervals) {
		const n = intervals.filter(([a, b]) => a <= s && s <= b).length;
		if (n > maxConcurrent) maxConcurrent = n;
	}
	const waves = new Map();
	for (const rs of runSessions) {
		const w = GRAPH_NODES.find((n) => n.id === rs.primaryNode)?.wave ?? 0;
		waves.set(w, (waves.get(w) ?? 0) + 1);
	}

	// context bundles per session
	const contextBundles = runSessions.map((rs) => ({
		sessionFile: rs.summary.file,
		node: rs.primaryNode,
		role: GRAPH_NODES.find((n) => n.id === rs.primaryNode)?.title ?? "Ad-hoc",
		goal: rs.summary.preview,
		tools: rs.parsed.tools.map((t) => t.name),
		tokenBudget: rs.parsed.totals.input + rs.parsed.totals.output,
		compactions: rs.parsed.events.filter((e) => e.kind === "compaction").length,
		models: rs.parsed.models,
		cost: rs.parsed.totals.cost,
		reworkFeedback: review && rs.nodes.has("analysis") ? review.findings : [],
	}));

	const artifacts = extractArtifacts(runSessions);
	const succeededCount = [...status.values()].filter((s) => s === "succeeded").length;
	const firstNotDone = GRAPH_NODES.find((n) => {
		const st = status.get(n.id);
		return st !== "succeeded" && st !== "skipped";
	});

	return {
		id: runId,
		title: runSessions[0]?.summary.preview ?? runId,
		start: runStart,
		end: runEnd,
		live,
		sessionCount: runSessions.length,
		sessions: runSessions.map((rs) => ({
			file: rs.summary.file,
			preview: rs.summary.preview,
			start: rs.summary.start,
			end: rs.summary.end,
			primaryNode: rs.primaryNode,
			toolCalls: rs.summary.toolCalls,
			cost: rs.summary.cost,
		})),
		nodes: GRAPH_NODES.map((n) => ({
			...n,
			status: status.get(n.id),
			evidence: nodeEvidence.get(n.id) ?? null,
		})),
		edges: GRAPH_EDGES.map((e) => {
			let state = "idle";
			const fromSt = status.get(e.from);
			const toSt = status.get(e.to);
			if (e.kind === "feedback") state = verdict === "CHANGES_REQUIRED" ? "active" : "idle";
			else if (e.kind === "decision") state = verdict === "PASS" ? "passed" : verdict ? "rejected" : "idle";
			else if (fromSt === "failed" || toSt === "blocked") state = "blocked";
			else if (fromSt === "succeeded" && (toSt === "succeeded" || toSt === "changes_required")) state = "done";
			else if (fromSt === "succeeded") state = "active";
			return { ...e, state };
		}),
		review,
		rework: { count: reworkCount, max: reworkMax, verdict },
		artifacts,
		events,
		errorClasses: Object.entries(errorClasses)
			.map(([cls, count]) => ({ cls, label: ERROR_LABELS[cls], count, fatal: ERROR_CATEGORIES.fatal.includes(cls) }))
			.sort((a, b) => b.count - a.count),
		totalErrors,
		concurrency: {
			max: maxConcurrent,
			current: live ? [...status.values()].filter((s) => s === "running").length : 0,
			waves: [...waves.entries()].map(([wave, sessions]) => ({ wave, sessions })),
		},
		contextBundles,
		progress: { done: succeededCount, total: GRAPH_NODES.length },
		currentPhase: firstNotDone ? firstNotDone.title : "Completed",
		graphVersion: 1 + reworkCount,
		runState:
			verdict === "CHANGES_REQUIRED" && reworkCount === 0
				? "返工中"
				: live
					? "运行中"
					: status.get("verify") === "succeeded"
						? "已完成"
						: [...status.values()].some((s) => s === "failed")
							? "失败"
							: "进行中",
		audit: {
			chainComplete: true,
			checkpoint: lastEvidenceNode ? GRAPH_NODES.find((n) => n.id === lastEvidenceNode)?.title : null,
			recoverCount: reworkCount,
		},
		totals: runSessions.reduce(
			(acc, rs) => {
				acc.cost += rs.parsed.totals.cost;
				acc.calls += rs.parsed.totals.calls;
				acc.toolCalls += rs.summary.toolCalls;
				return acc;
			},
			{ cost: 0, calls: 0, toolCalls: 0 },
		),
	};
}

// ----------------------------------------------------------------------------
// Ad-hoc run detail (sessions with no business graph evidence)
// ----------------------------------------------------------------------------

export function buildAdhocRun(runId, summaries) {
	const totals = { cost: 0, calls: 0, toolCalls: 0 };
	for (const s of summaries) {
		totals.cost += s.cost ?? 0;
		totals.toolCalls += s.toolCalls ?? 0;
	}
	return {
		id: runId,
		title: summaries[0]?.preview ?? runId,
		start: summaries[0]?.start,
		end: summaries[summaries.length - 1]?.end,
		live: false,
		adhoc: true,
		sessionCount: summaries.length,
		sessions: summaries.map((s) => ({
			file: s.file,
			preview: s.preview,
			start: s.start,
			end: s.end,
			primaryNode: null,
			toolCalls: s.toolCalls,
			cost: s.cost,
		})),
		nodes: GRAPH_NODES.map((n) => ({ ...n, status: "pending", evidence: null })),
		edges: GRAPH_EDGES.map((e) => ({ ...e, state: "idle" })),
		review: null,
		rework: { count: 0, max: 1, verdict: null },
		artifacts: [],
		events: [{ kind: "graph_created", ts: summaries[0]?.start }],
		errorClasses: [],
		totalErrors: 0,
		concurrency: { max: 1, current: 0, waves: [] },
		contextBundles: [],
		progress: { done: 0, total: GRAPH_NODES.length },
		currentPhase: "—",
		graphVersion: 1,
		runState: "Ad-hoc 会话（未命中业务节点）",
		audit: { chainComplete: true, checkpoint: null, recoverCount: 0 },
		totals,
	};
}

// ----------------------------------------------------------------------------
// Build all graph runs from session summaries
// ----------------------------------------------------------------------------

export function buildGraphRuns(summaries, parseSessionFn, filePathOf) {
	const clusters = clusterSessions(summaries);
	const runs = [];
	for (const cluster of clusters) {
		const runSessions = [];
		for (const summary of cluster.sessions) {
			let parsed;
			try {
				parsed = parseSessionFn(filePathOf(summary));
			} catch {
				continue;
			}
			const nodes = mapSessionToNodes(parsed);
			if (nodes.size === 0) continue; // ad-hoc session, not part of business graph
			const primaryNode = primaryNodeOf(nodes);
			runSessions.push({ summary, parsed, nodes, primaryNode });
		}
		if (runSessions.length === 0) {
			// ad-hoc cluster: keep visible as a lightweight run so every new query shows up
			const first = cluster.sessions[0];
			if (!first) continue;
			runs.push({
				id: `run-${new Date(cluster.firstMs).getTime().toString(36)}`,
				title: first.preview.slice(0, 60),
				start: first.start,
				end: cluster.sessions[cluster.sessions.length - 1].end,
				sessionCount: cluster.sessions.length,
				nodes: [],
				adhoc: true,
				cost: cluster.sessions.reduce((s, x) => s + x.cost, 0),
				toolCalls: cluster.sessions.reduce((s, x) => s + x.toolCalls, 0),
			});
			continue;
		}
		const runId = `run-${new Date(cluster.firstMs).getTime().toString(36)}`;
		runs.push({
			id: runId,
			title: runSessions[0].summary.preview.slice(0, 60),
			start: runSessions[0].summary.start,
			end: runSessions[runSessions.length - 1].summary.end,
			sessionCount: runSessions.length,
			nodes: [...new Set(runSessions.flatMap((rs) => [...rs.nodes.keys()]))],
			cost: runSessions.reduce((s, rs) => s + rs.summary.cost, 0),
			toolCalls: runSessions.reduce((s, rs) => s + rs.summary.toolCalls, 0),
		});
	}
	runs.sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
	return runs;
}
