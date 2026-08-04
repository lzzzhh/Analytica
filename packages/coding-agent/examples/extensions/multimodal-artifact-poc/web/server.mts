/**
 * Analytica Web Adapter Server — zero-dependency read-only API + static SPA.
 *
 * Run: node --experimental-strip-types server.mts [--port 4775]
 *
 * Governance boundaries preserved: this server NEVER writes artifacts,
 * never bypasses WriteGate/ReviewGate/Reviewer, never serves raw dataset
 * bytes or credentials, and masks absolute user paths. The only write
 * endpoints create/append pi session transcript lines (chat surface).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_CAPABILITIES } from "../src/graph-engine/capability-registry.ts";
import { getRunDetail, listRuns, storeFingerprint, storeRoots } from "./lib/graph-source.mts";
import { projectAgentLoop } from "./lib/loop.mts";
import { getAnalysisRunDetail, listAnalysisRuns, listRegisteredArtifacts, maskPath, DATA_ANALYSIS_DIR } from "./lib/analysis-source.mts";
import { appendUserMessage, createSession, getSessionTimeline, listSessions } from "./lib/sessions-source.mts";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "public");
const POC_ROOT = join(here, "..");
const ANALYTICA_WORKSPACE_CWD = process.env.ANALYTICA_WEB_CWD ?? POC_ROOT;

const argIdx = process.argv.indexOf("--port");
const PORT = argIdx > 0 ? Number(process.argv[argIdx + 1]) : Number(process.env.ANALYTICA_WEB_PORT ?? 4775);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(res: ServerResponse, filePath: string, cache = false): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    const mime = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime,
      "cache-control": cache ? "public, max-age=86400" : "no-store",
    });
    res.end(readFileSync(filePath));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

function handleGraphRuns(res: ServerResponse): void {
  sendJson(res, 200, { runs: listRuns(), roots: storeRoots().map((r) => r.label) });
}

function handleGraphRun(res: ServerResponse, url: URL, parts: string[]): void {
  const storeLabel = url.searchParams.get("store") ?? "dev-seed";
  const detail = getRunDetail(storeLabel, parts[3]);
  if (!detail) {
    sendError(res, 404, "RUN_NOT_FOUND", `graph run ${parts[3]} not found in store '${storeLabel}'`);
    return;
  }
  sendJson(res, 200, {
    runId: detail.runId,
    storeLabel: detail.storeLabel,
    graphId: detail.state.graphId,
    graphVersion: detail.state.graphVersion,
    graphContentHash: detail.state.graphContentHash,
    featureSnapshotHash: detail.state.featureSnapshotHash,
    status: detail.state.status,
    revisionCycles: detail.state.revisionCycles,
    specVersions: detail.specVersions,
    integrityIssues: detail.integrityIssues,
    state: detail.state,
    events: detail.events,
    spec: detail.spec,
  });
}

function handleLoop(res: ServerResponse, url: URL, parts: string[]): void {
  const storeLabel = url.searchParams.get("store") ?? "dev-seed";
  const detail = getRunDetail(storeLabel, parts[3]);
  if (!detail || !detail.spec) {
    sendError(res, 404, "RUN_NOT_FOUND", `graph run ${parts[3]} not found`);
    return;
  }
  sendJson(res, 200, projectAgentLoop(detail.spec, detail.state, detail.events));
}

function handleArtifacts(res: ServerResponse): void {
  // graph refs (all runs) + registered data-analysis inputs
  const graphArtifacts = new Map<string, { artifactId: string; artifactType: string; contentHash: string; createdByNodeId: string; runIds: string[]; storeLabel: string }>();
  for (const run of listRuns()) {
    const detail = getRunDetail(run.storeLabel, run.runId);
    if (!detail) continue;
    for (const ref of detail.state.artifactRefs) {
      const existing = graphArtifacts.get(ref.artifactId);
      if (existing) {
        if (!existing.runIds.includes(run.runId)) existing.runIds.push(run.runId);
        continue;
      }
      graphArtifacts.set(ref.artifactId, {
        artifactId: ref.artifactId,
        artifactType: ref.artifactType,
        contentHash: ref.contentHash,
        createdByNodeId: ref.createdByNodeId,
        runIds: [run.runId],
        storeLabel: run.storeLabel,
      });
    }
  }
  const registered = listRegisteredArtifacts().map((a) => ({
    artifactId: a.artifactId,
    artifactType: (a.meta?.contentType as string) ?? "dataset",
    contentHash: (a.meta?.contentHash as string) ?? "",
    metaHash: (a.meta?.metaHash as string) ?? "",
    committed: a.committed,
    masked: (a.meta?.masked as boolean) ?? false,
    createdAt: (a.meta?.createdAt as string) ?? "",
    source: "artifact-store",
  }));
  sendJson(res, 200, {
    graphArtifacts: [...graphArtifacts.values()],
    registeredArtifacts: registered,
    analysisOutputs: listAnalysisRuns().filter((r) => r.hasResult).map((r) => r.runDirName),
  });
}

function handleArtifactLineage(res: ServerResponse, artifactId: string): void {
  // producers/consumers from REAL graph ARTIFACT edges + event refs
  const producers: Array<{ runId: string; storeLabel: string; nodeId: string; artifactType: string }> = [];
  const consumers: Array<{ runId: string; storeLabel: string; nodeId: string }> = [];
  let found: { artifactType: string; contentHash: string } | null = null;
  for (const run of listRuns()) {
    const detail = getRunDetail(run.storeLabel, run.runId);
    if (!detail || !detail.spec) continue;
    for (const [nodeId, nr] of Object.entries(detail.state.nodeRuns)) {
      if (nr.outputRefs.some((r) => r.artifactId === artifactId)) {
        const ref = nr.outputRefs.find((r) => r.artifactId === artifactId)!;
        found = { artifactType: ref.artifactType, contentHash: ref.contentHash };
        producers.push({ runId: run.runId, storeLabel: run.storeLabel, nodeId, artifactType: ref.artifactType });
      }
      if (nr.inputRefs.some((r) => r.artifactId === artifactId)) {
        consumers.push({ runId: run.runId, storeLabel: run.storeLabel, nodeId });
      }
    }
  }
  const registered = listRegisteredArtifacts().find((a) => a.artifactId === artifactId);
  if (!found && !registered && producers.length === 0) {
    sendError(res, 404, "ARTIFACT_NOT_FOUND", `artifact ${artifactId} not found in any graph run or artifact store`);
    return;
  }
  sendJson(res, 200, {
    artifactId,
    artifactType: found?.artifactType ?? (registered?.meta?.contentType as string) ?? "unknown",
    contentHash: found?.contentHash ?? (registered?.meta?.contentHash as string) ?? "",
    metaHash: (registered?.meta?.metaHash as string) ?? undefined,
    registeredMeta: registered?.meta ?? null,
    producers,
    consumers,
  });
}

function handleDatasets(res: ServerResponse): void {
  const registered = listRegisteredArtifacts();
  const pocManifest = (() => {
    try {
      return JSON.parse(readFileSync(join(POC_ROOT, "input", "input-manifest.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  sendJson(res, 200, {
    storeDir: maskPath(DATA_ANALYSIS_DIR),
    registeredArtifacts: registered,
    pocInputManifest: pocManifest,
    analysisRunsUsingInputs: listAnalysisRuns().map((r) => ({ runDirName: r.runDirName, inputs: r.inputs })),
  });
}

function handleReports(res: ServerResponse): void {
  const analysisReports = listAnalysisRuns().filter((r) => r.hasResult);
  const graphReports = listRuns().filter((r) => r.status === "COMPLETED");
  sendJson(res, 200, { analysisReports, graphReports });
}

function handleTools(res: ServerResponse): void {
  const tools = Object.values(GRAPH_CAPABILITIES).map((c) => ({
    capabilityId: c.capabilityId,
    nodeKind: c.nodeKind,
    featureId: c.featureId,
    sideEffect: c.sideEffect,
    costClass: c.costClass,
    adapterId: c.adapterId,
    timeoutMs: c.timeoutPolicyMs,
    maxAttempts: c.retryPolicy.maxAttempts,
    supportsParallel: c.supportsParallel,
  }));
  sendJson(res, 200, { tools, source: "graph-engine capability registry (read-only)" });
}

function handleFeatures(res: ServerResponse): void {
  const registry = (() => {
    try {
      return JSON.parse(readFileSync(join(POC_ROOT, "config", "features", "registry.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const runtimeDefault = (() => {
    try {
      return JSON.parse(readFileSync(join(POC_ROOT, "config", "features", "runtime-profiles", "default.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  if (!registry) {
    sendError(res, 503, "FEATURE_REGISTRY_UNAVAILABLE", "feature registry.json unreadable");
    return;
  }
  sendJson(res, 200, { registry, runtimeProfileDefault: runtimeDefault });
}

function handleSessions(res: ServerResponse): void {
  sendJson(res, 200, { sessions: listSessions(), workspaceCwd: maskPath(ANALYTICA_WORKSPACE_CWD) });
}

async function handleCreateSession(res: ServerResponse): Promise<void> {
  try {
    const created = createSession(ANALYTICA_WORKSPACE_CWD);
    sendJson(res, 201, { sessionId: created.sessionId, status: "created", runtimeAttached: false });
  } catch (err) {
    sendError(res, 500, "SESSION_CREATE_FAILED", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const method = req.method ?? "GET";
  try {
    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, storeRoots: storeRoots().map((r) => r.label), sessionsDirReadable: listSessions().length >= 0 });
      return;
    }
    if (url.pathname === "/api/graph/runs" && method === "GET") return handleGraphRuns(res);
    if (parts[1] === "graph" && parts[2] === "runs" && parts[3] && parts[4] === "loop") return handleLoop(res, url, parts);
    if (parts[1] === "graph" && parts[2] === "runs" && parts[3] && method === "GET") return handleGraphRun(res, url, parts);
    if (url.pathname === "/api/artifacts" && method === "GET") return handleArtifacts(res);
    if (parts[1] === "artifacts" && parts[2] && parts[3] === "lineage") return handleArtifactLineage(res, parts[2]);
    if (url.pathname === "/api/datasets") return handleDatasets(res);
    if (url.pathname === "/api/reports") return handleReports(res);
    if (url.pathname === "/api/tools") return handleTools(res);
    if (url.pathname === "/api/features") return handleFeatures(res);
    if (url.pathname === "/api/analysis/runs") return sendJson(res, 200, { runs: listAnalysisRuns() });
    if (parts[1] === "analysis" && parts[2] === "runs" && parts[3]) {
      const detail = getAnalysisRunDetail(parts[3]);
      if (!detail) return sendError(res, 404, "ANALYSIS_RUN_NOT_FOUND", parts[3]);
      return sendJson(res, 200, detail);
    }
    if (url.pathname === "/api/sessions" && method === "GET") return handleSessions(res);
    if (url.pathname === "/api/sessions" && method === "POST") return handleCreateSession(res);
    if (parts[1] === "sessions" && parts[2] && method === "GET") {
      const timeline = getSessionTimeline(parts[2]);
      if (!timeline) return sendError(res, 404, "SESSION_NOT_FOUND", parts[2]);
      return sendJson(res, 200, timeline);
    }
    if (parts[1] === "sessions" && parts[2] && parts[3] === "messages" && method === "POST") {
      const body = await readBody(req);
      let text = "";
      try {
        text = String(JSON.parse(body).text ?? "");
      } catch {
        return sendError(res, 400, "INVALID_BODY", "expected JSON {text}");
      }
      if (!text.trim()) return sendError(res, 400, "EMPTY_MESSAGE", "message text required");
      const ok = appendUserMessage(parts[2], text.trim());
      if (!ok) return sendError(res, 404, "SESSION_NOT_FOUND", parts[2]);
      // No agent runtime is attached to this read-only adapter: the UI must
      // surface this honestly instead of fabricating a reply.
      return sendJson(res, 201, { appended: true, agentRuntimeAttached: false, runStatus: "AGENT_RUNTIME_NOT_ATTACHED" });
    }
    sendError(res, 404, "API_NOT_FOUND", `${method} ${url.pathname}`);
  } catch (err) {
    sendError(res, 500, "API_ERROR", err instanceof Error ? err.message : String(err));
  }
}

const sseClients = new Set<ServerResponse>();
let lastFingerprint = "";

setInterval(() => {
  let fp = "";
  try {
    fp = storeFingerprint();
  } catch {
    return;
  }
  if (fp === lastFingerprint) return;
  const changed = lastFingerprint !== "";
  lastFingerprint = fp;
  const payload = `data: ${JSON.stringify({ type: changed ? "graph-store-changed" : "graph-store-hello", at: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch { /* drop dead client */ }
  }
}, 1000);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    void handleApi(req, res, url);
    return;
  }
  if (url.pathname.startsWith("/vendor/")) {
    const map: Record<string, string> = {
      "/vendor/preact.module.js": join(here, "node_modules", "preact", "dist", "preact.module.js"),
      "/vendor/hooks.module.js": join(here, "node_modules", "preact", "hooks", "dist", "hooks.module.js"),
      "/vendor/htm.module.js": join(here, "node_modules", "htm", "dist", "htm.module.js"),
    };
    const target = map[url.pathname];
    if (target && serveStatic(res, target, true)) return;
    sendError(res, 404, "VENDOR_NOT_FOUND", url.pathname);
    return;
  }
  // static files with path traversal protection
  const safePath = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);
  if (filePath.startsWith(PUBLIC_DIR) && serveStatic(res, filePath)) return;
  // SPA fallback: any unknown GET path serves the app shell (History API routing)
  if (req.method === "GET" && !url.pathname.includes(".")) {
    if (serveStatic(res, join(PUBLIC_DIR, "index.html"))) return;
  }
  sendError(res, 404, "NOT_FOUND", url.pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Analytica web adapter: http://127.0.0.1:${PORT}`);
  console.log(`store roots: ${storeRoots().map((r) => `${r.label}=${maskPath(r.root)}`).join(" | ")}`);
  console.log(`sessions workspace cwd: ${maskPath(ANALYTICA_WORKSPACE_CWD)}`);
});
