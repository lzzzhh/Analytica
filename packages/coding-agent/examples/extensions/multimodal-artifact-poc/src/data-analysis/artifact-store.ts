/**
 * Artifact store — trusted registry for analysis artifacts.
 *
 * Artifact ids are deterministic (`art_<sha256 prefix>`) and every id must
 * resolve through this store; arbitrary filesystem paths are never accepted.
 * Result artifacts are immutable: once written they are never overwritten.
 */
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ArtifactResolver } from "./input-resolver.ts";

const DATA_ANALYSIS_DIR = join(homedir(), ".pi", "artifacts", "data-analysis");
const ARTIFACT_ID_RE = /^art_[a-z0-9]{16}$/;

export interface StoredArtifactMeta {
  artifactId: string;
  contentType: string;
  rowCount?: number;
  columns?: string[];
  contentHash: string;
  queryId?: string;
  snapshotId?: string;
  masked: boolean;
  createdAt: string;
  /** SHA-256 over the governance meta document (masked/sensitive/columns/
   *  provenance) — binds the meta to itself so tampering it without the
   *  data bytes is detected. */
  metaHash?: string;
}

export class ArtifactStore implements ArtifactResolver {
  private readonly registry: Map<string, StoredArtifactMeta> = new Map();
  private readonly baseDir: string;

  constructor(baseDir: string = DATA_ANALYSIS_DIR) {
    this.baseDir = baseDir;
    mkdirSync(baseDir, { recursive: true });
  }

  /** Register an input artifact (e.g. from materialization) as trusted.
   *
   *  Governance-meta integrity (P1-7): the meta document (masked, sensitive,
   *  columns, provenance) is bound by its OWN content hash (metaHash) —
   *  tampering masked/sensitive/queryId WITHOUT touching the data bytes
   *  changes metaHash and fails closed at resolve time. Registration is
   *  no-clobber: the same artifact id can never be re-registered with
   *  different data or meta (TOCTOU guard). */
  register(meta: StoredArtifactMeta, data: Uint8Array | string): void {
    if (!ARTIFACT_ID_RE.test(meta.artifactId)) {
      throw new Error(`invalid artifact id: ${meta.artifactId}`);
    }
    const contentHash = createHash("sha256").update(data as Buffer).digest("hex");
    if (meta.contentHash !== contentHash) {
      throw new Error(`artifact ${meta.artifactId}: contentHash mismatch`);
    }
    // transactional content-addressed layout: inputs/<id>/{data,meta,COMMITTED}
    // — temp files fsynced and renamed; COMMITTED is the atomic commit point
    // (binds BOTH the data hash and the meta hash). A crash mid-register
    // leaves only .tmp files: re-registering the same id either completes or
    // fails on the no-clobber COMMITTED — never a half artifact.
    const dir = join(this.baseDir, "inputs");
    mkdirSync(dir, { recursive: true });
    const artifactDir = join(dir, meta.artifactId);
    const committed = join(artifactDir, "COMMITTED");
    if (existsSync(committed)) {
      throw new Error(`artifact ${meta.artifactId} already registered (no-clobber)`);
    }
    const { metaHash: _mh, ...metaBody } = meta;
    const stored: StoredArtifactMeta = { ...metaBody, contentHash };
    // metaHash binds the governance meta document AND the data hash: a
    // tampered meta without touching the bytes still breaks the binding
    stored.metaHash = createHash("sha256").update(JSON.stringify(stored) + ":" + contentHash).digest("hex");
    const tmpDir = join(dir, `.${meta.artifactId}.tmp-${process.pid}`);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const dataTmp = join(tmpDir, "data");
    const metaTmp = join(tmpDir, "meta");
    writeFileSync(dataTmp, data as Buffer);
    writeFileSync(metaTmp, JSON.stringify(stored), "utf8");
    const fd = openSync(dataTmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    const fd2 = openSync(metaTmp, "r");
    fsyncSync(fd2);
    closeSync(fd2);
    mkdirSync(artifactDir, { recursive: true });
    renameSync(dataTmp, join(artifactDir, "data"));
    renameSync(metaTmp, join(artifactDir, "meta"));
    writeFileSync(join(artifactDir, "COMMITTED"), stored.metaHash, "utf8");
    const dirFd = openSync(artifactDir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    rmSync(tmpDir, { recursive: true, force: true });
    this.registry.set(meta.artifactId, stored);
  }

  /** Immutable write of a result artifact + an expected-hash manifest.
   *
   *  Transactional, content-addressed layout (results/<id>/):
   *    payload.json + manifest.json written into a temp dir, fsynced, then
   *    atomically published via the COMMITTED marker (rename). A crash
   *    between payload and COMMITTED leaves NO resolvable artifact; a
   *    tampered payload/manifest pair is rejected at read time (the
   *    manifest itself is content-hash-protected by COMMITTED). */
  writeResult(artifactId: string, json: string): string {
    if (!ARTIFACT_ID_RE.test(artifactId)) {
      throw new Error(`invalid result artifact id: ${artifactId}`);
    }
    const resultsDir = join(this.baseDir, "results");
    mkdirSync(resultsDir, { recursive: true });
    const artifactDir = join(resultsDir, artifactId);
    const committed = join(artifactDir, "COMMITTED");
    // ATOMIC CLAIM: two writers racing on the same id — only one wins the
    // wx claim; the loser refuses instead of interleaving payloads
    const claimPath = join(resultsDir, `.${artifactId}.claim`);
    const claimFd = openSync(claimPath, "wx");
    closeSync(claimFd);
    try {
    if (existsSync(committed)) {
      throw new Error(`artifact ${artifactId} already exists (immutable)`);
    }
    const expectedHash = createHash("sha256").update(json).digest("hex");
    const manifest = {
      artifactId, expectedContentHash: expectedHash,
      schemaVersion: "1.0", createdAt: new Date().toISOString(),
    };
    const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    // temp dir + fsync + atomic publish (COMMITTED rename is the commit
    // point: the marker itself is written to a temp file and RENAMED into
    // place — a crash can never leave a truncated COMMITTED that blocks
    // the artifact forever)
    const tmpDir = join(resultsDir, `.${artifactId}.tmp-${process.pid}`);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const payloadPath = join(tmpDir, "payload.json");
    const manifestPath = join(tmpDir, "manifest.json");
    const committedTmp = join(tmpDir, "COMMITTED");
    writeFileSync(payloadPath, json, "utf8");
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    writeFileSync(committedTmp, manifestHash, "utf8");
    const fd = openSync(payloadPath, "r");
    fsyncSync(fd);
    closeSync(fd);
    const fd2 = openSync(manifestPath, "r");
    fsyncSync(fd2);
    closeSync(fd2);
    const fd3 = openSync(committedTmp, "r");
    fsyncSync(fd3);
    closeSync(fd3);
    // atomic publish: rename payload + manifest first, then COMMITTED
    mkdirSync(artifactDir, { recursive: true });
    renameSync(payloadPath, join(artifactDir, "payload.json"));
    renameSync(manifestPath, join(artifactDir, "manifest.json"));
    renameSync(committedTmp, committed);
    // fsync the DIRECTORY entries so a crash cannot lose the renames
    const dirFd = openSync(artifactDir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    const resultsFd = openSync(resultsDir, "r");
    try { fsyncSync(resultsFd); } finally { closeSync(resultsFd); }
    rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      rmSync(claimPath, { force: true });
    }
    return join(artifactDir, "payload.json");
  }

  async resolveArtifact(artifactId: string): Promise<{
    path: string;
    contentType: string;
    meta: Record<string, unknown>;
  } | null> {
    if (!ARTIFACT_ID_RE.test(artifactId)) return null;
    const meta = this.registry.get(artifactId) ?? this.loadRegisteredMeta(artifactId);
    if (!meta) return null;
    const path = join(this.baseDir, "inputs", artifactId, "data");
    if (!existsSync(path)) return null;
    const contentHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (contentHash !== meta.contentHash) return null;
    // READ-ONLY COPY for callers (never the registry object)
    this.registry.set(artifactId, meta);
    return { path, contentType: meta.contentType, meta: { ...meta } };
  }

  /** Resolve a RESULT artifact: current hash must equal the manifest's
   *  EXPECTED hash (written at first write) — self-comparison is never
   *  accepted. The COMMITTED marker binds the manifest hash; a missing or
   *  mismatched marker, payload, or manifest pair is unverifiable. */
  async resolveResult(artifactId: string): Promise<{
    path: string;
    content: string;
    contentHash: string;
  } | null> {
    if (!ARTIFACT_ID_RE.test(artifactId)) return null;
    // transactional content-addressed layout (results/<id>/)
    const artifactDir = join(this.baseDir, "results", artifactId);
    const committed = join(artifactDir, "COMMITTED");
    const payloadPath = join(artifactDir, "payload.json");
    const manifestPath = join(artifactDir, "manifest.json");
    if (existsSync(payloadPath)) {
      if (!existsSync(committed) || !existsSync(manifestPath)) return null;
      let expected = "";
      let manifestHash = "";
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { expectedContentHash?: string };
        expected = manifest.expectedContentHash ?? "";
        manifestHash = createHash("sha256").update(readFileSync(manifestPath, "utf8")).digest("hex");
      } catch {
        return null;
      }
      if (readFileSync(committed, "utf8").trim() !== manifestHash) return null; // tampered manifest
      const content = readFileSync(payloadPath, "utf8");
      const current = createHash("sha256").update(content).digest("hex");
      if (current !== expected) return null; // tampered payload
      return { path: payloadPath, content, contentHash: current };
    }
    // legacy flat layout (results/<id>.json) is NOT accepted: it has no
    // COMMITTED binding, so a tampered result+manifest pair could match
    // each other — unverifiable artifacts must fail closed
    return null;
  }

  getMeta(artifactId: string): StoredArtifactMeta | null {
    return this.registry.get(artifactId) ?? null;
  }

  readInput(artifactId: string): string | null {
    const raw = this.readInputBytes(artifactId);
    return raw ? raw.toString("utf8") : null;
  }

  /** Read input artifact BYTES (binary-safe: parquet/arrow must never be
   *  decoded as UTF-8 — hashing happens on the original bytes). */
  readInputBytes(artifactId: string): Buffer | null {
    const resolved = this.registry.get(artifactId) ?? this.loadRegisteredMeta(artifactId);
    if (!resolved) return null;
    const path = join(this.baseDir, "inputs", artifactId, "data");
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  private loadRegisteredMeta(artifactId: string): StoredArtifactMeta | null {
    const artifactDir = join(this.baseDir, "inputs", artifactId);
    const committed = join(artifactDir, "COMMITTED");
    const metaPath = join(artifactDir, "meta");
    const dataPath = join(artifactDir, "data");
    if (!existsSync(committed) || !existsSync(metaPath) || !existsSync(dataPath)) return null;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      return null;
    }
    if (!isStoredArtifactMeta(value) || value.artifactId !== artifactId) return null;
    // metaHash binds the governance meta document AND the data bytes: a
    // tampered meta file no longer matches its hash, and the COMMITTED
    // marker binds the whole unit — unverifiable = fail closed
    const { metaHash: mh, ...metaBody } = value;
    if (typeof mh !== "string") return null;
    const dataHash = createHash("sha256").update(readFileSync(dataPath)).digest("hex");
    const expected = createHash("sha256").update(JSON.stringify(metaBody) + ":" + dataHash).digest("hex");
    if (expected !== mh) return null;
    if (readFileSync(committed, "utf8").trim() !== mh) return null;
    // write back into the in-memory registry so a process that recovered
    // mid-run (preflight done, analysis resumed) sees the SAME meta
    this.registry.set(artifactId, value);
    return value;
  }
}

function isStoredArtifactMeta(value: unknown): value is StoredArtifactMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Record<string, unknown>;
  return typeof meta.artifactId === "string" && ARTIFACT_ID_RE.test(meta.artifactId) &&
    typeof meta.contentType === "string" &&
    typeof meta.contentHash === "string" && /^[a-f0-9]{64}$/.test(meta.contentHash) &&
    typeof meta.masked === "boolean" &&
    typeof meta.createdAt === "string";
}
