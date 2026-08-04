/**
 * Workspace — per-run isolated directory under ~/.pi/artifacts/data-analysis/<run-id>/.
 *
 * Structure:
 *   <run-id>/input/input-manifest.json      (read-only inputs)
 *   <run-id>/plan/analysis-plan.json
 *   <run-id>/code/analysis.py               (attempt-versioned)
 *   <run-id>/output/{analysis-result.json, analysis-findings.json, chart-data.json, execution-manifest.json}
 *   <run-id>/logs/{stdout.log, stderr.log}
 *
 * runIds are unique per invocation; successful result artifacts are never
 * overwritten; retries use attempt versions.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdirSync as _mkdir } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WorkspacePaths {
  root: string;
  inputDir: string;
  planDir: string;
  codeDir: string;
  outputDir: string;
  logsDir: string;
  inputManifest: string;
  planFile: string;
  scriptFile: string;
  resultFile: string;
  findingsFile: string;
  chartDataFile: string;
  executionManifestFile: string;
  stdoutLog: string;
  stderrLog: string;
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function artifactsBaseDir(): string {
  return join(homedir(), ".pi", "artifacts", "data-analysis");
}

export function createWorkspace(runId: string): WorkspacePaths {
  const root = join(artifactsBaseDir(), runId);
  const inputDir = join(root, "input");
  const planDir = join(root, "plan");
  const codeDir = join(root, "code");
  const outputDir = join(root, "output");
  const logsDir = join(root, "logs");
  for (const d of [inputDir, planDir, codeDir, outputDir, logsDir]) {
    mkdirSync(d, { recursive: true });
  }
  return {
    root,
    inputDir,
    planDir,
    codeDir,
    outputDir,
    logsDir,
    inputManifest: join(inputDir, "input-manifest.json"),
    planFile: join(planDir, "analysis-plan.json"),
    scriptFile: join(codeDir, "analysis.py"),
    resultFile: join(outputDir, "analysis-result.json"),
    findingsFile: join(outputDir, "analysis-findings.json"),
    chartDataFile: join(outputDir, "chart-data.json"),
    executionManifestFile: join(outputDir, "execution-manifest.json"),
    stdoutLog: join(logsDir, "stdout.log"),
    stderrLog: join(logsDir, "stderr.log"),
  };
}

/** Script file name for a retry attempt (attempt 1 → analysis.py). */
export function scriptFileForAttempt(paths: WorkspacePaths, attempt: number): string {
  if (attempt <= 1) return paths.scriptFile;
  const base = paths.scriptFile.replace(/\.py$/, "");
  return `${base}.attempt-${attempt}.py`;
}

export function sha256OfFile(path: string): string {
  const content = readFileSync(path, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Copy input artifact bytes into the workspace input dir as a readonly link. */
export function linkInputData(
  paths: WorkspacePaths,
  artifactId: string,
  sourcePath: string,
): string {
  const dest = join(paths.inputDir, `${artifactId}.data`);
  // Read-only copy (local mode): keep the artifact immutable.
  const bytes = readFileSync(sourcePath);
  writeFileSync(dest, bytes);
  return dest;
}

export { dirname, existsSync };
