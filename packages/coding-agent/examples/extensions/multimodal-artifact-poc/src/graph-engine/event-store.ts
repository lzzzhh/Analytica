/**
 * Graph Engine — append-only event store with hash chain (fail closed).
 *
 * Layout (isolated per run):
 *   <root>/runs/<runId>/events/<sequence>.json   (one file per event)
 *   <root>/runs/<runId>/state.json               (latest reducer projection)
 *   <root>/runs/<runId>/.append.lock             (per-run write lock)
 *
 * Integrity: every event links previousEventHash; a mismatch or a missing
 * predecessor fails closed (never silently skips).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "./canonical.ts";
import type { GraphEvent } from "./contracts.ts";
import { GraphError } from "./errors.ts";

export class GraphEventStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  private runDir(runId: string): string {
    const d = join(this.root, "runs", runId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  private eventsDir(runId: string): string {
    const d = join(this.runDir(runId), "events");
    mkdirSync(d, { recursive: true });
    return d;
  }

  private lockPath(runId: string): string {
    return join(this.runDir(runId), ".append.lock");
  }

  /** Persist an immutable GraphSpec for a graph version (no-clobber):
   *  recovery rebuilds the LATEST spec from the event stream instead of
   *  re-using the genesis one after a revision. */
  writeSpec(runId: string, graphVersion: number, spec: unknown): void {
    const dir = join(this.runDir(runId), "specs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `v${graphVersion}.json`);
    if (existsSync(path)) {
      // identical re-write is a no-op; different content is an integrity
      // violation (a version's spec is immutable)
      const existing = JSON.parse(readFileSync(path, "utf8"));
      if (canonicalize(existing) !== canonicalize(spec)) {
        throw new GraphError("SCHEMA_INVALID", `spec v${graphVersion} for ${runId} already persisted with different content`, { retryable: false });
      }
      return;
    }
    writeFileSync(path, JSON.stringify(spec), "utf8");
  }

  readSpec(runId: string, graphVersion: number): unknown | null {
    const path = join(this.runDir(runId), "specs", `v${graphVersion}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new GraphError("INVALID_GRAPH", `corrupt persisted spec ${runId}/v${graphVersion}`, { retryable: false });
    }
  }

  lastEvent(runId: string): GraphEvent | null {
    const dir = this.eventsDir(runId);
    let maxSeq = -1;
    for (const f of readdirSafe(dir)) {
      const m = /^(\d+)\.json$/.exec(f);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    }
    if (maxSeq < 0) return null;
    return this.readEvent(runId, maxSeq);
  }

  readEvent(runId: string, sequence: number): GraphEvent | null {
    const path = join(this.eventsDir(runId), `${sequence}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as GraphEvent;
    } catch {
      throw new GraphError("INVALID_GRAPH", `corrupt graph event ${runId}/${sequence}`, { retryable: false });
    }
  }

  /** Append one event with an atomic no-clobber write + fsync. */
  append(runId: string, event: Omit<GraphEvent, "runId" | "eventId" | "sequence" | "previousEventHash" | "contentHash" | "timestamp" | "meta"> & { meta?: Record<string, string> }): GraphEvent {
    if (!/^[a-z0-9_-]{1,64}$/.test(runId)) {
      throw new GraphError("SCHEMA_INVALID", `invalid runId '${runId}' for event append`, { retryable: false });
    }
    const lock = this.lockPath(runId);
    if (existsSync(lock)) {
      // fail closed on a concurrent append (no interleaving)
      throw new GraphError("TRANSIENT_IO", `concurrent append for ${runId}`, { retryable: true });
    }
    writeFileSync(lock, "locked", { flag: "wx" });
    try {
      const last = this.lastEvent(runId);
      const sequence = last ? last.sequence + 1 : 0;
      // genesis is MANDATORY: sequence 0 must be GRAPH_CREATED
      if (sequence === 0 && event.eventType !== "GRAPH_CREATED") {
        throw new GraphError("GENESIS_MISSING", `run ${runId} must start with GRAPH_CREATED`, { retryable: false });
      }
      if (sequence > 0 && event.eventType === "GRAPH_CREATED") {
        throw new GraphError("SCHEMA_INVALID", `run ${runId} already has a genesis event`, { retryable: false });
      }
      // terminal runs refuse state events (fail closed)
      if (last && (last.eventType === "GRAPH_COMPLETED" || last.eventType === "GRAPH_FAILED" || last.eventType === "GRAPH_CANCELLED")) {
        throw new GraphError("TERMINAL_RUN_IMMUTABLE", `run ${runId} is terminal; only audit events may follow`, { retryable: false });
      }
      void runId;
      const previousEventHash = last?.contentHash ?? "genesis";
      const base: Omit<GraphEvent, "contentHash"> = {
        eventId: `evt_${runId}_${sequence}`,
        runId,
        graphId: event.graphId,
        graphVersion: event.graphVersion,
        sequence,
        eventType: event.eventType,
        nodeId: event.nodeId,
        refs: event.refs ?? [],
        errorCode: event.errorCode,
        meta: event.meta ?? {},
        timestamp: new Date().toISOString(),
        previousEventHash,
      };
      const contentHash = createHash("sha256").update(canonicalize(base)).digest("hex");
      const full: GraphEvent = { ...base, contentHash };
      // fail closed: events must never carry business data/credentials
      const raw = canonicalize(full);
      for (const field of ["rawData", "rows", "credentials", "modelOutput"]) {
        if (raw.includes(`"${field}"`)) {
          throw new GraphError("SCHEMA_INVALID", `graph event carries forbidden field '${field}'`, { retryable: false });
        }
      }
      const target = join(this.eventsDir(runId), `${sequence}.json`);
      if (existsSync(target)) {
        throw new GraphError("TRANSIENT_IO", `no-clobber: event ${sequence} already exists`, { retryable: true });
      }
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(full));
      // fsync the event file + directory before the atomic rename
      const fd = openSync(tmp, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, target);
      const dirFd = openSync(this.eventsDir(runId), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      return full;
    } finally {
      try { renameSync(lock, `${lock}.done`); } catch { /* best effort */ }
    }
  }

  /** Full integrity scan: genesis, chain, sequence, identity, terminal rule. */
  scan(runId: string): string[] {
    const issues: string[] = [];
    const dir = this.eventsDir(runId);
    const seqs = readdirSafe(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => Number(f.replace(".json", "")))
      .sort((a, b) => a - b);
    if (seqs.length === 0) return issues;
    let prevHash = "genesis";
    let prevSeq = -1;
    let terminal = false;
    for (const seq of seqs) {
      if (seq !== prevSeq + 1) issues.push(`sequence gap: ${prevSeq} -> ${seq}`);
      const ev = this.readEvent(runId, seq);
      if (!ev) {
        issues.push(`event ${seq} unreadable`);
        continue;
      }
      if (ev.runId !== runId) issues.push(`event ${seq}: runId ${ev.runId} != ${runId}`);
      if (ev.sequence !== seq) issues.push(`event ${seq}: sequence field ${ev.sequence} mismatch`);
      if (ev.previousEventHash !== prevHash) issues.push(`event ${seq}: hash chain broken`);
      const { contentHash: _c, ...body } = ev;
      const computed = createHash("sha256").update(canonicalize(body)).digest("hex");
      if (computed !== ev.contentHash) issues.push(`event ${seq}: contentHash mismatch`);
      // genesis rules
      if (seq === 0 && ev.eventType !== "GRAPH_CREATED") issues.push("event 0 must be GRAPH_CREATED");
      if (seq > 0 && ev.eventType === "GRAPH_CREATED") issues.push(`event ${seq}: duplicate genesis`);
      // terminal rule
      if (terminal) issues.push(`event ${seq}: after a terminal event`);
      if (ev.eventType === "GRAPH_COMPLETED" || ev.eventType === "GRAPH_FAILED" || ev.eventType === "GRAPH_CANCELLED") {
        terminal = true;
      }
      prevHash = ev.contentHash;
      prevSeq = seq;
    }
    return issues;
  }

  allEvents(runId: string): GraphEvent[] {
    const dir = this.eventsDir(runId);
    const seqs = readdirSafe(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => Number(f.replace(".json", "")))
      .sort((a, b) => a - b);
    return seqs.map((s) => this.readEvent(runId, s)!).filter(Boolean);
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
