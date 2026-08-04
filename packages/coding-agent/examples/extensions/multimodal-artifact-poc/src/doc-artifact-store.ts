/**
 * Document artifact store — persists parsed documents to disk with caching.
 *
 * Layout:
 *   ~/.pi/artifacts/<hash>/raw.md      — markitdown output (source of truth)
 *   ~/.pi/artifacts/<hash>/meta.json   — artifact metadata
 *
 * A re-parse of the same file (same path + mtime) hits the cache instead of
 * re-running markitdown.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ARTIFACTS_DIR = join(homedir(), ".pi", "artifacts");

interface ArtifactMeta {
  artifactId: string;
  sourcePath: string;
  mtimeMs: number;
  size: number;
  mimeType: string;
  parsedAt: string;
}

function hashPath(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

export function getArtifactDir(filePath: string): string {
  return join(ARTIFACTS_DIR, hashPath(filePath));
}

export function artifactExists(filePath: string): boolean {
  const dir = getArtifactDir(filePath);
  return existsSync(join(dir, "raw.md")) && existsSync(join(dir, "meta.json"));
}

/** Returns true if the cached artifact matches the current file (mtime check). */
export function artifactFresh(filePath: string): boolean {
  if (!artifactExists(filePath)) return false;
  try {
    const meta = readMeta(filePath);
    const current = statSync(filePath);
    return meta.mtimeMs === current.mtimeMs && meta.size === current.size;
  } catch {
    return false;
  }
}

export function storeArtifact(
  filePath: string,
  markdown: string,
  mimeType: string,
): { artifactId: string; dir: string } {
  const dir = getArtifactDir(filePath);
  mkdirSync(dir, { recursive: true });

  const stat = statSync(filePath);
  const artifactId = `doc_${hashPath(filePath)}`;
  const meta: ArtifactMeta = {
    artifactId,
    sourcePath: filePath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    mimeType,
    parsedAt: new Date().toISOString(),
  };

  writeFileSync(join(dir, "raw.md"), markdown);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return { artifactId, dir };
}

export function readStoredMarkdown(filePath: string): string {
  return readFileSync(join(getArtifactDir(filePath), "raw.md"), "utf8");
}

export function readMeta(filePath: string): ArtifactMeta {
  return JSON.parse(readFileSync(join(getArtifactDir(filePath), "meta.json"), "utf8")) as ArtifactMeta;
}

/** Full artifact record for the subagent prompt / tool result. */
export interface StoredDocument {
  artifactId: string;
  dir: string;
  mimeType: string;
  markdown: string;
  cached: boolean;
}

/**
 * Get or create the persisted document for a file.
 * Returns cached markdown when the file is unchanged; otherwise re-parses via the
 * provided parse function.
 */
export async function getOrCreateDocument(
  filePath: string,
  mimeType: string,
  parse: () => Promise<string>,
): Promise<StoredDocument> {
  if (artifactFresh(filePath)) {
    return {
      artifactId: readMeta(filePath).artifactId,
      dir: getArtifactDir(filePath),
      mimeType,
      markdown: readStoredMarkdown(filePath),
      cached: true,
    };
  }

  const markdown = await parse();
  const { artifactId, dir } = storeArtifact(filePath, markdown, mimeType);
  return { artifactId, dir, mimeType, markdown, cached: false };
}
