/**
 * Agent Dashboard Server
 *
 * Reads REAL pi session data from ~/.pi/agent/sessions/ (JSONL files),
 * exposes a JSON API + SSE stream, and serves the visualization HTML.
 *
 * Zero dependencies: node agent-dashboard-server.mjs [--port 7788]
 *
 * Endpoints:
 *   GET /                    -> dashboard HTML
 *   GET /api/sessions        -> list of all sessions (each agent usage)
 *   GET /api/session?file=   -> full parsed session (turns, tool calls, usage)
 *   GET /api/graphs          -> reconstructed project Graph Runs (list)
 *   GET /api/graph?run=ID    -> full Graph Run detail (nodes, artifacts, review, events)
 *   GET /api/events          -> SSE stream (file change notifications)
 */

import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { buildAdhocRun, buildGraphRun, buildGraphRuns, clusterSessions, mapSessionToNodesPublic, primaryNodeOf } from "./agent-graph.mjs";

const PORT = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 7788);
const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const HTML_FILE = new URL("./agent-dashboard.html", import.meta.url).pathname;

// ============================================================================
// JSONL parsing
// ============================================================================

function readEntries(file) {
	const raw = readFileSync(file, "utf8");
	const entries = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// skip malformed line
		}
	}
	return entries;
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Parse a session file into summary + detailed turn structure. */
function parseSession(file) {
	const entries = readEntries(file);
	const header = entries.find((e) => e.type === "session") ?? {};

	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, calls: 0 };
	const toolStats = new Map(); // toolName -> { calls, errors }
	const models = new Set();
	const turns = [];
	const events = [];
	let currentTurn = null;
	let preview = "";
	let lastTs = header.timestamp;

	for (const entry of entries) {
		if (entry.timestamp) lastTs = entry.timestamp;

		if (entry.type === "model_change") {
			models.add(`${entry.provider}/${entry.modelId}`);
			events.push({ kind: "model_change", ts: entry.timestamp, model: `${entry.provider}/${entry.modelId}` });
		} else if (entry.type === "compaction") {
			events.push({ kind: "compaction", ts: entry.timestamp, tokensBefore: entry.tokensBefore });
		} else if (entry.type === "branch_summary") {
			events.push({ kind: "branch_summary", ts: entry.timestamp });
		} else if (entry.type === "message") {
			const msg = entry.message;
			const ts = entry.timestamp;

			if (msg.role === "user") {
				const text = contentText(msg.content);
				if (!preview && text) preview = text.slice(0, 80);
				currentTurn = {
					index: turns.length,
					userText: text.slice(0, 500),
					ts,
					steps: [{ kind: "user", text: text.slice(0, 500), ts }],
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					cost: 0,
					toolCalls: [],
					stopReasons: [],
					elapsedMs: 0,
				};
				turns.push(currentTurn);
			} else if (msg.role === "assistant") {
				const usage = msg.usage;
				const step = {
					kind: "assistant",
					ts,
					text: contentText(msg.content).slice(0, 800),
					toolCalls: [],
					stopReason: msg.stopReason,
					model: msg.provider ? `${msg.provider}/${msg.model ?? msg.responseModel}` : undefined,
					usage: usage
						? {
								input: usage.input,
								output: usage.output,
								cacheRead: usage.cacheRead,
								cacheWrite: usage.cacheWrite,
								cost: usage.cost?.total ?? 0,
							}
						: undefined,
				};
				if (usage) {
					totals.input += usage.input ?? 0;
					totals.output += usage.output ?? 0;
					totals.cacheRead += usage.cacheRead ?? 0;
					totals.cacheWrite += usage.cacheWrite ?? 0;
					totals.reasoning += usage.reasoning ?? 0;
					totals.cost += usage.cost?.total ?? 0;
					totals.calls++;
					if (currentTurn) {
						currentTurn.tokens.input += usage.input ?? 0;
						currentTurn.tokens.output += usage.output ?? 0;
						currentTurn.tokens.cacheRead += usage.cacheRead ?? 0;
						currentTurn.tokens.cacheWrite += usage.cacheWrite ?? 0;
						currentTurn.cost += usage.cost?.total ?? 0;
						currentTurn.elapsedMs = new Date(ts).getTime() - new Date(currentTurn.ts).getTime();
					}
				}
				if (msg.stopReason) {
					currentTurn?.stopReasons.push(msg.stopReason);
				}
				// Extract tool calls from content
				if (Array.isArray(msg.content)) {
					for (const c of msg.content) {
						if (c.type === "toolCall") {
							const tc = {
								id: c.id,
								name: c.name,
								args: JSON.stringify(c.arguments ?? {}).slice(0, 300),
								ts,
								isError: false,
							};
							step.toolCalls.push(tc);
							currentTurn?.toolCalls.push(tc);
							const stat = toolStats.get(c.name) ?? { calls: 0, errors: 0 };
							stat.calls++;
							toolStats.set(c.name, stat);
						}
					}
				}
				if (!currentTurn) {
					currentTurn = {
						index: turns.length,
						userText: "(continued)",
						ts,
						steps: [],
						tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						cost: 0,
						toolCalls: [],
						stopReasons: [],
						elapsedMs: 0,
					};
					turns.push(currentTurn);
				}
				currentTurn.steps.push(step);
			} else if (msg.role === "toolResult") {
				const isError = msg.isError === true || /failed|error/i.test(contentText(msg.content).slice(0, 120));
				const step = {
					kind: "toolResult",
					ts,
					toolName: msg.toolName,
					isError,
					text: contentText(msg.content).slice(0, 300),
				};
				const stat = toolStats.get(msg.toolName);
				if (stat && isError) stat.errors++;
				// Mark matching tool call as errored
				if (currentTurn) {
					const tc = currentTurn.toolCalls.find((t) => t.id === msg.toolCallId);
					if (tc) tc.isError = isError;
				}
				currentTurn?.steps.push(step);
			}
		}
	}

	return {
		header: { id: header.id, cwd: header.cwd, timestamp: header.timestamp },
		start: header.timestamp,
		end: lastTs,
		preview,
		models: [...models],
		totals,
		tools: [...toolStats.entries()].map(([name, s]) => ({ name, ...s })),
		events,
		turns,
		messageCount: entries.filter((e) => e.type === "message").length,
	};
}

/** Lightweight summary for the session list. */
function summarizeSession(file) {
	try {
		const parsed = parseSession(file);
		return {
			file,
			id: parsed.header.id,
			cwd: parsed.header.cwd,
			project: basename(join(file, "..")),
			start: parsed.start,
			end: parsed.end,
			preview: parsed.preview || "(empty session)",
			turns: parsed.turns.length,
			messageCount: parsed.messageCount,
			toolCalls: parsed.tools.reduce((s, t) => s + t.calls, 0),
			cost: parsed.totals.cost,
			tokens: parsed.totals.input + parsed.totals.output + parsed.totals.cacheRead + parsed.totals.cacheWrite,
			models: parsed.models,
		};
	} catch (err) {
		return { file, id: basename(file), error: String(err) };
	}
}

// Parse cache keyed by file:mtime so repeated graph queries stay fast.
const parseCache = new Map();
function parseSessionCached(file) {
	let mtime = 0;
	try {
		mtime = statSync(file).mtimeMs;
	} catch {
		return parseSession(file);
	}
	const key = `${file}@${mtime}`;
	const hit = parseCache.get(key);
	if (hit) return hit;
	const parsed = parseSession(file);
	if (parseCache.size > 60) parseCache.clear();
	parseCache.set(key, parsed);
	return parsed;
}

function listAllSessions() {
	if (!existsSync(SESSIONS_ROOT)) return [];
	const results = [];
	for (const proj of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
		if (!proj.isDirectory()) continue;
		const dir = join(SESSIONS_ROOT, proj.name);
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".jsonl")) continue;
			results.push(join(dir, f));
		}
	}
	const summaries = results.map(summarizeSession);
	summaries.sort((a, b) => new Date(b.end ?? 0).getTime() - new Date(a.end ?? 0).getTime());
	return summaries.slice(0, 200);
}

// ============================================================================
// Graph Run detail reconstruction
// ============================================================================

function getGraphRunDetail(runId) {
	const summaries = listAllSessions();
	const clusters = clusterSessions(summaries);
	for (const cluster of clusters) {
		const runSessions = [];
		for (const summary of cluster.sessions) {
			let parsed;
			try {
				parsed = parseSessionCached(summary.file);
			} catch {
				continue;
			}
			const nodes = mapSessionToNodesPublic(parsed);
			if (nodes.size === 0) continue;
			const primaryNode = primaryNodeOf(nodes);
			runSessions.push({ summary, parsed, nodes, primaryNode });
		}
		if (runSessions.length === 0) {
			const clusterRunId = `run-${new Date(cluster.firstMs).getTime().toString(36)}`;
			if (clusterRunId === runId) return buildAdhocRun(runId, cluster.sessions);
			continue;
		}
		const clusterRunId = `run-${new Date(cluster.firstMs).getTime().toString(36)}`;
		if (clusterRunId === runId) {
			return buildGraphRun(runId, runSessions);
		}
	}
	return null;
}

// ============================================================================
// SSE: watch session files for changes
// ============================================================================

const sseClients = new Set();
let debounceTimer = null;

function broadcast(data) {
	const payload = `data: ${JSON.stringify(data)}\n\n`;
	for (const res of sseClients) {
		try {
			res.write(payload);
		} catch {
			sseClients.delete(res);
		}
	}
}

function notifyChange(changedFile) {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		broadcast({ type: "sessions-updated", file: changedFile, ts: Date.now() });
	}, 400);
}

if (existsSync(SESSIONS_ROOT)) {
	try {
		watch(SESSIONS_ROOT, { recursive: true }, (_event, filename) => {
			if (filename && String(filename).endsWith(".jsonl")) {
				notifyChange(join(SESSIONS_ROOT, String(filename)));
			}
		});
	} catch {
		// fallback: poll every 3s
		const seen = new Map();
		setInterval(() => {
			for (const s of listAllSessions().slice(0, 20)) {
				try {
					const mt = statSync(s.file).mtimeMs;
					const prev = seen.get(s.file);
					if (prev !== undefined && prev !== mt) notifyChange(s.file);
					seen.set(s.file, mt);
				} catch {
					// ignore
				}
			}
		}, 3000);
	}
}

// ============================================================================
// HTTP server
// ============================================================================

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);

	// CORS for local development
	res.setHeader("Access-Control-Allow-Origin", "*");

	if (url.pathname === "/api/sessions") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listAllSessions()));
		return;
	}

	if (url.pathname === "/api/session") {
		const file = url.searchParams.get("file");
		if (!file || !existsSync(file)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "session not found" }));
			return;
		}
		try {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(parseSession(file)));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		}
		return;
	}

	if (url.pathname === "/api/graphs") {
		try {
			const summaries = listAllSessions();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(buildGraphRuns(summaries, parseSessionCached, (s) => s.file)));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		}
		return;
	}

	if (url.pathname === "/api/graph") {
		const runId = url.searchParams.get("run");
		try {
			const detail = getGraphRunDetail(runId);
			if (!detail) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "run not found" }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(detail));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		}
		return;
	}

	if (url.pathname === "/api/events") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write("retry: 2000\n\n");
		sseClients.add(res);
		const ping = setInterval(() => {
			try {
				res.write(": ping\n\n");
			} catch {
				clearInterval(ping);
			}
		}, 15000);
		req.on("close", () => {
			clearInterval(ping);
			sseClients.delete(res);
		});
		return;
	}

	// Serve HTML
	if (url.pathname === "/" || url.pathname === "/index.html") {
		try {
			const html = readFileSync(HTML_FILE, "utf8");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(html);
		} catch (err) {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end(`HTML not found: ${err}`);
		}
		return;
	}

	res.writeHead(404);
	res.end("not found");
});

server.listen(PORT, () => {
	console.log(`Agent Dashboard: http://localhost:${PORT}`);
	console.log(`Watching sessions: ${SESSIONS_ROOT}`);
});
