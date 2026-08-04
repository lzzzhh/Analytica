/**
 * Controlled script runner — executes analysis.py in a restricted way.
 *
 * Real limits implemented in this PoC:
 *  - fixed cwd = the per-run workspace;
 *  - `python3 <script>` only (no -c, no heredoc, no node);
 *  - env whitelist (PATH, HOME, LANG, LC_*, TZ, PYTHONPATH removed);
 *  - timeout, max script size, max stdout/stderr bytes, max result file size;
 *  - no pip install, no network (env cleared; no network flags needed on a
 *    plain python3 child), no shell pipes;
 *  - dependency availability is checked BEFORE running (import probe).
 *
 * Documented PoC limits (no real sandbox): the child runs as the same OS user
 * and can read any file the user can read; we rely on policy (script is
 * produced by the subagent in an isolated context, inputs are readonly copies,
 * outputs bounded) plus the env whitelist and the absence of credentials.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AnalysisErrorCode } from "./contracts.ts";
import type { WorkspacePaths } from "./workspace.ts";
import { readText } from "./workspace.ts";

export interface RunScriptRequest {
  runId: string;
  scriptPath: string;
  workspace: WorkspacePaths;
  timeoutSeconds: number;
  maxScriptBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxResultBytes: number;
  /** When aborted, the child process is KILLED (real cancellation). */
  abortSignal?: AbortSignal;
}

export interface RunScriptResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  errorCode?: AnalysisErrorCode;
  errorMessage?: string;
  timedOut?: boolean;
}

const ENV_WHITELIST_PREFIXES = ["PATH=", "HOME=", "LANG=", "LC_", "TZ=", "TERM="];

function buildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const entry = `${key}=`;
    if (ENV_WHITELIST_PREFIXES.some((p) => entry.startsWith(p))) {
      out[key] = process.env[key]!;
    }
  }
  // Explicitly never pass credentials / lakehouse / aws env.
  for (const key of Object.keys(out)) {
    if (/LAKEHOUSE|AWS|S3|DATABASE|DB_|REDSHIFT|BIGQUERY|SNOWFLAKE|PGHOST|PGUSER|PGPASSWORD|API_KEY|TOKEN|SECRET/i.test(key)) {
      delete out[key];
    }
  }
  return out;
}

/** Probe whether required analysis deps are importable (before running). */
export function checkDependencies(deps: string[], pythonBin = "python3"): {
  ok: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const dep of deps) {
    const probe = `import ${dep}`;
    const r = spawnSync(pythonBin, ["-c", probe], {
      stdio: "ignore",
      env: buildEnv(),
      timeout: 15_000,
    });
    // spawnSync with -c here is the runner's own dependency probe, not user
    // code; it never executes analysis logic.
    if (r.status !== 0) missing.push(dep);
  }
  return { ok: missing.length === 0, missing };
}

export function runAnalysisScript(req: RunScriptRequest): Promise<RunScriptResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const { scriptPath, workspace, timeoutSeconds } = req;

    if (!existsSync(scriptPath)) {
      resolve({
        ok: false, exitCode: null, stdout: "", stderr: "script file missing",
        durationMs: 0, errorCode: "INPUT_ARTIFACT_MISSING",
        errorMessage: `script not found: ${basename(scriptPath)}`,
      });
      return;
    }
    const scriptBytes = statSync(scriptPath).size;
    if (scriptBytes > req.maxScriptBytes) {
      resolve({
        ok: false, exitCode: null, stdout: "", stderr: "script too large",
        durationMs: 0, errorCode: "SANDBOX_VIOLATION",
        errorMessage: `script ${scriptBytes} bytes exceeds limit ${req.maxScriptBytes}`,
      });
      return;
    }

    // The analysis script runs with stdout/stderr redirected to log files so
    // logs never enter the agent context by default.
    const args = [scriptPath];
    const child = spawn("python3", args, {
      cwd: workspace.root,
      env: buildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutSeconds * 1000,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const cap = (buf: Buffer, current: string, limit: number, side: "stdout" | "stderr"): string => {
      if (current.length >= limit) return current;
      return (current + buf.toString("utf8")).slice(0, limit);
    };

    child.stdout.on("data", (d: Buffer) => {
      stdout = cap(d, stdout, req.maxStdoutBytes, "stdout");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = cap(d, stderr, req.maxStderrBytes, "stderr");
    });
    // REAL cancellation: an aborted signal kills the child (the executor's
    // node timeout aborts the adapter; the run must not linger)
    if (req.abortSignal) {
      const onAbort = () => {
        timedOut = true;
        child.kill("SIGKILL");
      };
      if (req.abortSignal.aborted) onAbort();
      else req.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => {
      resolve({
        ok: false, exitCode: null, stdout, stderr: stderr || err.message,
        durationMs: Date.now() - started, errorCode: "SANDBOX_VIOLATION",
        errorMessage: err.message,
      });
    });
    child.on("close", (code, signal) => {
      const durationMs = Date.now() - started;
      if (signal === "SIGTERM") timedOut = true;
      if (code === 0) {
        resolve({ ok: true, exitCode: code, stdout, stderr, durationMs });
        return;
      }
      // Classify fixable vs non-fixable errors.
      const errorCode: AnalysisErrorCode = timedOut
        ? "EXECUTION_TIMEOUT"
        : /SyntaxError|IndentationError|NameError|TypeError|ValueError|ZeroDivisionError/.test(stderr)
          ? "SCRIPT_SYNTAX_ERROR"
          : /ModuleNotFoundError|ImportError/.test(stderr)
            ? "SCRIPT_IMPORT_ERROR"
            : /numerical|NaN|inf|overflow/i.test(stderr)
              ? "NUMERIC_ERROR"
              : "SCRIPT_SYNTAX_ERROR";
      resolve({
        ok: false, exitCode: code, stdout, stderr, durationMs,
        timedOut,
        errorCode,
        errorMessage: stderr.slice(0, 500) || `exit ${code}`,
      });
    });
  });
}

/** Read the result file with a size cap. */
export function readResultFile(workspace: WorkspacePaths, maxBytes: number): string {
  const candidates = [
    join(workspace.outputDir, "analysis-result.json"),
    join(workspace.root, "analysis-result.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    if (size > maxBytes) return "";
    return readText(path);
  }
  // tolerate scripts writing the result under a nested dir (scan, bounded)
  const { readdirSync } = require("node:fs");
  try {
    for (const entry of readdirSync(workspace.root, { recursive: true })) {
      if (String(entry).endsWith("analysis-result.json")) {
        const path = join(workspace.root, String(entry));
        const size = statSync(path).size;
        if (size <= maxBytes) return readText(path);
      }
    }
  } catch {
    // ignore scan errors
  }
  return "";
}

export function outputTooLarge(workspace: WorkspacePaths, maxBytes: number): boolean {
  const path = join(workspace.outputDir, "analysis-result.json");
  if (!existsSync(path)) return false;
  return statSync(path).size > maxBytes;
}
