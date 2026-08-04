/**
 * Analytica Web Adapter — pi session source.
 *
 * Reads REAL pi coding-agent session transcripts:
 *   ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl  (v3)
 * Read-only; absolute paths are masked. The only write operation exposed
 * by the API is creating a NEW empty session file (no-clobber append of a
 * standard v3 header) — existing transcripts are never modified here.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const HOME = homedir();
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR ?? join(HOME, ".pi", "agent", "sessions");
const FILE_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]{36}\.jsonl$/;

export function maskSessionPath(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

function decodeCwdDir(dirName: string): string {
  // pi encodes cwd by replacing path separators with "-" plus outer padding
  // dashes ("--Users-zhanhuilin-Documents-pi--"); ambiguous for dir names
  // containing dashes, the session header cwd takes precedence when present
  let s = dirName;
  if (s.startsWith("--")) s = s.slice(1);
  if (s.endsWith("--")) s = s.slice(0, -1);
  return s.replace(/-/g, "/").replace(/\/$/, "");
}

export interface SessionSummary {
  sessionId: string;
  fileName: string;
  cwd: string;
  startedAt: string;
  entryCount: number;
  messageCount: number;
  lastUserText?: string;
}

export function listSessions(): SessionSummary[] {
  const out: SessionSummary[] = [];
  if (!existsSync(SESSIONS_DIR)) return out;
  for (const cwdDir of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!cwdDir.isDirectory()) continue;
    const dir = join(SESSIONS_DIR, cwdDir.name);
    for (const f of readdirSync(dir)) {
      if (!FILE_RE.test(f)) continue;
      const summary = summarizeSession(dir, f, decodeCwdDir(cwdDir.name));
      if (summary) out.push(summary);
    }
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

function summarizeSession(dir: string, fileName: string, cwd: string): SessionSummary | null {
  const path = join(dir, fileName);
  let sessionId = fileName.replace(".jsonl", "").split("_").slice(1).join("_");
  let startedAt = "";
  let messageCount = 0;
  let entryCount = 0;
  let lastUserText: string | undefined;
  let headerCwd: string | undefined;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    // cap parsing effort for huge transcripts
    for (const line of lines.slice(0, 20000)) {
      entryCount++;
      try {
        const row = JSON.parse(line);
        if (row.type === "session") {
          sessionId = row.id ?? sessionId;
          startedAt = row.timestamp ?? startedAt;
          headerCwd = row.cwd ?? headerCwd;
        } else if (row.type === "message" && row.message?.role) {
          messageCount++;
          if (row.message.role === "user") {
            const text = (row.message.content ?? [])
              .filter((c: { type: string }) => c.type === "text")
              .map((c: { text?: string }) => c.text ?? "")
              .join(" ");
            if (text) lastUserText = text.slice(0, 120);
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch {
    return null;
  }
  return { sessionId, fileName, cwd: maskSessionPath(headerCwd ?? cwd), startedAt, entryCount, messageCount, lastUserText };
}

export interface SessionTimelineEntry {
  type: string;
  timestamp?: string;
  role?: string;
  text?: string;
  toolName?: string;
  toolState?: string;
  model?: string;
}

export function getSessionTimeline(sessionId: string, limit = 400): { cwd: string; startedAt: string; entries: SessionTimelineEntry[] } | null {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  if (!existsSync(SESSIONS_DIR)) return null;
  for (const cwdDir of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!cwdDir.isDirectory()) continue;
    const dir = join(SESSIONS_DIR, cwdDir.name);
    for (const f of readdirSync(dir)) {
      if (!FILE_RE.test(f) || !f.includes(sessionId)) continue;
      const entries: SessionTimelineEntry[] = [];
      let cwd = decodeCwdDir(cwdDir.name);
      let startedAt = "";
      const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (row.type === "session") {
            cwd = row.cwd ?? cwd;
            startedAt = row.timestamp ?? "";
            continue;
          }
          if (row.type === "message" && row.message) {
            const msg = row.message;
            const text = Array.isArray(msg.content)
              ? msg.content.filter((c: { type: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("\n")
              : "";
            entries.push({ type: "message", timestamp: row.timestamp, role: msg.role, text });
            if (Array.isArray(msg.content)) {
              for (const c of msg.content) {
                if (c.type === "toolCall" || c.type === "tool_use") {
                  entries.push({ type: "toolCall", timestamp: row.timestamp, role: msg.role, toolName: c.name ?? c.toolName, toolState: "called" });
                }
                if (c.type === "toolResult" || c.type === "tool_result") {
                  entries.push({ type: "toolResult", timestamp: row.timestamp, toolName: c.name ?? c.toolName, toolState: c.isError ? "error" : "done" });
                }
              }
            }
          } else if (row.type === "model_change") {
            entries.push({ type: "model_change", timestamp: row.timestamp, model: `${row.provider ?? ""}/${row.modelId ?? ""}` });
          }
        } catch { /* skip malformed line */ }
        if (entries.length >= limit * 2) break;
      }
      return { cwd: maskSessionPath(cwd), startedAt, entries: entries.slice(0, limit) };
    }
  }
  return null;
}

/** Create a NEW empty session in the Analytica workspace cwd (no-clobber).
 *  Creates the encoded-cwd directory on first use. */
export function createSession(cwd: string): { sessionId: string; fileName: string } {
  const encoded = cwd.replace(/\//g, "-");
  const dir = join(SESSIONS_DIR, encoded);
  mkdirSync(dir, { recursive: true });
  const sessionId = randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}_${sessionId}.jsonl`;
  const path = join(dir, fileName);
  if (existsSync(path)) throw new Error("session file collision");
  const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd };
  writeFileSync(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
  return { sessionId, fileName };
}

/** Append ONE user message line to a session transcript (small O_APPEND
 *  write; only used for sessions opened through this UI). */
export function appendUserMessage(sessionId: string, text: string): boolean {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return false;
  if (!existsSync(SESSIONS_DIR)) return false;
  const clean = text.slice(0, 4000);
  for (const cwdDir of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!cwdDir.isDirectory()) continue;
    const dir = join(SESSIONS_DIR, cwdDir.name);
    for (const f of readdirSync(dir)) {
      if (!FILE_RE.test(f) || !f.includes(sessionId)) continue;
      const row = {
        type: "message",
        id: randomUUID().slice(0, 8),
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: clean }] },
      };
      appendFileSync(join(dir, f), `${JSON.stringify(row)}\n`);
      return true;
    }
  }
  return false;
}
