/**
 * Reviewer store — durable, immutable persistence for proposals, review
 * packages and decisions. Same durability protocol as the governance
 * repository (tmp + fsync + no-clobber link + dir fsync + ledger), but a
 * separate, reviewer-owned store.
 *
 * Layout (§20):
 *   <root>/proposals/<id>/v<n>/proposal.json (+ content.sha256)
 *   <root>/packages/<id>/review-package.json
 *   <root>/reviews/<id>/decision.json, checks.json, findings.json
 *   <root>/ledger.jsonl
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const ID_RE = /^[A-Za-z0-9_-]+$/;

export class ReviewerStoreError extends Error {}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Replay-tolerant normalization for idempotency checks: drops wall-clock
 *  fields and 64-hex content hashes (which may embed a wall clock the replay
 *  cannot reproduce). Structural ids, statuses and references survive. */
function replayCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(replayCanonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "createdAt") continue;
      if (typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) continue;
      out[k] = replayCanonical(v);
    }
    return out;
  }
  return value;
}

function assertSafeId(id: string, what: string): void {
  if (!ID_RE.test(id)) {
    throw new ReviewerStoreError(`${what} '${id}' is not a safe id ([A-Za-z0-9_-])`);
  }
}

export class ReviewerStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  private _path(...parts: string[]): string {
    const p = resolve(this.root, ...parts);
    if (!p.startsWith(this.root + sep) && p !== this.root) {
      throw new ReviewerStoreError(`path escapes reviewer root: ${p}`);
    }
    return p;
  }

  async writeImmutable(key: string, obj: unknown): Promise<string> {
    assertSafeId(key.split("/")[0] ?? key, "store key");
    const target = this._path(...key.split("/"));
    await mkdir(dirname(target), { recursive: true });
    const payload = JSON.stringify(obj, null, 2) + "\n";
    const hash = canonicalHash(obj);

    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tmp, payload);
      const fh = openSync(tmp, "r");
      try {
        fsyncSync(fh);
      } finally {
        closeSync(fh);
      }
      try {
        await link(tmp, target); // EEXIST when target exists -> no-clobber
      } catch {
        // Idempotent replay: an identical-content object already committed is
        // not a conflict (content-addressed dedup); only DIFFERENT semantic
        // content under the same key breaks immutability. Wall-clock fields
        // (createdAt) AND the content hashes derived from them are exempt —
        // a replay can never reproduce the original wall clock.
        let identical = false;
        try {
          const existing = JSON.parse(await readFile(target, "utf8"));
          identical = canonicalHash(replayCanonical(existing)) === canonicalHash(replayCanonical(obj));
        } catch {
          identical = false;
        }
        if (!identical) {
          throw new ReviewerStoreError(`object already exists (no-clobber): ${key}`);
        }
      }
      const dirFd = openSync(dirname(target), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      try {
        await writeFile(`${target}.sha256`, hash + "\n");
      } catch {
        /* sidecar optional */
      }
    } finally {
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
    }
    return hash;
  }

  /** Overwrite-capable write (non-terminal pointers, e.g. the ABSTAIN
   *  latest-attempt marker). Content is still hash-sidecared. */
  async write(key: string, obj: unknown): Promise<string> {
    assertSafeId(key.split("/")[0] ?? key, "store key");
    const target = this._path(...key.split("/"));
    await mkdir(dirname(target), { recursive: true });
    const payload = JSON.stringify(obj, null, 2) + "\n";
    const hash = canonicalHash(obj);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tmp, payload);
      const fh = openSync(tmp, "r");
      try { fsyncSync(fh); } finally { closeSync(fh); }
      await rename(tmp, target);
      await writeFile(`${target}.sha256`, hash + "\n");
    } catch (error) {
      try { await unlink(tmp); } catch { /* ignore */ }
      throw error;
    }
    return hash;
  }

  /** No-clobber binary write (frozen input bytes; sha256 sidecar).
   *
   *  Transactional: an atomic wx claim precedes both files; data and
   *  sidecar are written as temp files, fsynced, renamed, and the
   *  directory is fsynced — a crash can never leave a data file without
   *  its sidecar (the claim either completes both or blocks the retry
   *  until the object is verifiable). */
  async writeBytes(key: string, bytes: Buffer): Promise<string> {
    assertSafeId(key.split("/")[0] ?? key, "store key");
    const target = this._path(...key.split("/"));
    await mkdir(dirname(target), { recursive: true });
    const hash = createHash("sha256").update(bytes).digest("hex");
    const claim = `${target}.claim`;
    let claimFd: number | null = null;
    try {
      claimFd = openSync(claim, "wx");
    } catch {
      throw new ReviewerStoreError(`concurrent write for ${key}`);
    }
    try {
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      const tmpSide = `${target}.tmp-${process.pid}-${Date.now()}.sha256`;
      try {
        await writeFile(tmp, bytes);
        const fh = openSync(tmp, "r");
        try { fsyncSync(fh); } finally { closeSync(fh); }
        await writeFile(tmpSide, hash + "\n");
        const fh2 = openSync(tmpSide, "r");
        try { fsyncSync(fh2); } finally { closeSync(fh2); }
        if (existsSync(target)) {
          // Idempotent replay: identical bytes already committed -> dedup.
          let identical = false;
          try {
            identical = createHash("sha256").update(await readFile(target)).digest("hex") === hash;
          } catch {
            identical = false;
          }
          if (!identical) {
            throw new ReviewerStoreError(`object already exists (no-clobber): ${key}`);
          }
          return hash;
        }
        await rename(tmp, target);
        await rename(tmpSide, `${target}.sha256`);
        const dirFd = openSync(dirname(target), "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      } finally {
        try { await unlink(tmp); } catch { /* ignore */ }
        try { await unlink(tmpSide); } catch { /* ignore */ }
      }
    } finally {
      if (claimFd !== null) {
        closeSync(claimFd);
        await unlink(claim).catch(() => { /* already gone */ });
      }
    }
    return hash;
  }

  /** Read frozen binary bytes + their sha256 sidecar. */
  async readBytes(key: string): Promise<{ bytes: Buffer; hash: string } | null> {
    const target = this._path(...key.split("/"));
    if (!existsSync(target)) return null;
    const bytes = await readFile(target);
    const sidecar = `${target}.sha256`;
    if (!existsSync(sidecar)) return null;
    const expected = (await readFile(sidecar, "utf8")).trim();
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) return null;
    return { bytes, hash: actual };
  }

  async read<T>(key: string): Promise<{ content: T; hash: string } | null> {
    const target = this._path(...key.split("/"));
    if (!existsSync(target)) return null;
    const text = readFileSync(target, "utf8");
    const content = JSON.parse(text) as T;
    return { content, hash: canonicalHash(content) };
  }

  async appendLedger(line: Record<string, unknown>): Promise<void> {
    const path = this._path("ledger.jsonl");
    const text = JSON.stringify(line) + "\n";
    const fh = openSync(path, "a");
    try {
      const { writeSync } = await import("node:fs");
      writeSync(fh, text);
      fsyncSync(fh);
    } finally {
      closeSync(fh);
    }
  }

  async ledger(): Promise<Array<Record<string, unknown>>> {
    const path = this._path("ledger.jsonl");
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    const out: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
    return out;
  }
}
