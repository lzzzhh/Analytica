/**
 * Analytica Web Adapter — data-analysis + artifact data source (read-only).
 *
 * Reads the REAL ArtifactStore layout:
 *   ~/.pi/artifacts/data-analysis/run_<id>/{input,plan,code,output,logs}
 *   ~/.pi/artifacts/data-analysis/inputs/<artId>/{data,meta,COMMITTED}
 * Raw data bytes are NEVER served (governance); only meta, plans, and
 * sanitized result JSON. Absolute user paths are masked ("~/...").
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
export const DATA_ANALYSIS_DIR = process.env.ANALYTICA_DATA_DIR ?? join(HOME, ".pi", "artifacts", "data-analysis");

export function maskPath(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

function readJsonSafe(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export interface AnalysisRunSummary {
  runDirName: string;
  hasPlan: boolean;
  hasCode: boolean;
  hasResult: boolean;
  hasFindings: boolean;
  createdAt: string;
  inputs: string[];
}

export function listAnalysisRuns(): AnalysisRunSummary[] {
  const out: AnalysisRunSummary[] = [];
  if (!existsSync(DATA_ANALYSIS_DIR)) return out;
  for (const entry of readdirSync(DATA_ANALYSIS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
    const dir = join(DATA_ANALYSIS_DIR, entry.name);
    const inputsManifest = readJsonSafe(join(dir, "input", "input-manifest.json")) as { artifacts?: Array<{ artifactId?: string }> } | null;
    let createdAt = "";
    try {
      createdAt = statSync(dir).birthtime.toISOString();
    } catch { /* ignore */ }
    out.push({
      runDirName: entry.name,
      hasPlan: existsSync(join(dir, "plan", "analysis-plan.json")),
      hasCode: existsSync(join(dir, "code", "analysis.py")),
      hasResult: existsSync(join(dir, "output", "analysis-result.json")),
      hasFindings: existsSync(join(dir, "output", "analysis-findings.json")),
      createdAt,
      inputs: (inputsManifest?.artifacts ?? []).map((a) => a.artifactId ?? "").filter(Boolean),
    });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export function getAnalysisRunDetail(runDirName: string): Record<string, unknown> | null {
  if (!/^run_[a-z0-9]{8}_[a-z0-9]{8}$/.test(runDirName)) return null;
  const dir = join(DATA_ANALYSIS_DIR, runDirName);
  if (!existsSync(dir)) return null;
  return {
    runDirName,
    plan: readJsonSafe(join(dir, "plan", "analysis-plan.json")),
    result: readJsonSafe(join(dir, "output", "analysis-result.json")),
    findings: readJsonSafe(join(dir, "output", "analysis-findings.json")),
    executionManifest: readJsonSafe(join(dir, "output", "execution-manifest.json")),
    inputManifest: readJsonSafe(join(dir, "input", "input-manifest.json")),
    // code files may embed dataset paths; expose presence, not content, by default
    codeFiles: existsSync(join(dir, "code")) ? readdirSync(join(dir, "code")) : [],
  };
}

export interface RegisteredArtifact {
  artifactId: string;
  committed: boolean;
  meta: Record<string, unknown> | null;
}

export function listRegisteredArtifacts(): RegisteredArtifact[] {
  const out: RegisteredArtifact[] = [];
  const inputsDir = join(DATA_ANALYSIS_DIR, "inputs");
  if (!existsSync(inputsDir)) return out;
  for (const entry of readdirSync(inputsDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      // current layout: inputs/<artId>/{data,meta,COMMITTED}
      const dir = join(inputsDir, entry.name);
      out.push({
        artifactId: entry.name,
        committed: existsSync(join(dir, "COMMITTED")),
        meta: readJsonSafe(join(dir, "meta")) as Record<string, unknown> | null,
      });
    } else if (entry.name.endsWith(".json")) {
      // legacy flat layout: inputs/<artId>.json + inputs/<artId>.data
      const artifactId = entry.name.replace(/\.json$/, "");
      out.push({
        artifactId,
        committed: existsSync(join(inputsDir, `${artifactId}.data`)),
        meta: readJsonSafe(join(inputsDir, entry.name)) as Record<string, unknown> | null,
      });
    }
  }
  out.sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  return out;
}
