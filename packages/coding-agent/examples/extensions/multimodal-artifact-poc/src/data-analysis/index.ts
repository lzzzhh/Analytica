/**
 * Data Analysis Subagent — orchestration entry.
 *
 * Pipeline:
 *   1. forbid executable/credential/path inputs
 *   2. resolve inputs (trusted artifact registry only)
 *   3. DATA_INPUT_REQUIRED when inputs are insufficient
 *   4. task gate: QUERY_GATEWAY short-circuit for simple aggregations
 *   5. subagent: generate plan + write script (isolated context)
 *   6. plan validation (deterministic) before execution
 *   7. controlled script execution with bounded retries
 *   8. result validation → immutable artifact + execution manifest
 *   9. findings (optional) → sanitized summary for the main agent
 *
 * The main agent NEVER receives numbers: content carries only refs/status.
 */
import { createHash } from "node:crypto";
import type {
  AnalysisAgentSummary,
  AnalysisFailure,
  AnalysisPlan,
  AnalysisResultArtifact,
  DataAnalysisRequest,
  ExecutionManifest,
  TaskGateResult,
} from "./contracts.ts";
import { ANALYSIS_SCRIPT_RETRYABLE, CANARY_NUMBER } from "./contracts.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { analysisFlags, type AnalysisFeatureFlags } from "./feature-bindings.ts";
import { validateFindings } from "./findings.ts";
import {
  checkForbiddenRequest,
  newArtifactId,
  resolveAnalysisInput,
} from "./input-resolver.ts";
import { validateAnalysisPlan } from "./plan-validator.ts";
import {
  boundTableRows,
  downsampleSeries,
  validateResultArtifact,
} from "./result-validator.ts";
import {
  buildAgentSummary,
  modelFacingContent,
} from "./result-sanitizer.ts";
import {
  checkDependencies,
  outputTooLarge,
  runAnalysisScript,
  type RunScriptResult,
} from "./script-runner.ts";
import { evaluateTaskGate } from "./task-gate.ts";
import { buildSubagentPrompt } from "./subagent-prompt.ts";
import { writeJson, readJson, sha256OfFile } from "./workspace.ts";
import { writeFileSync } from "node:fs";
import { createWorkspace, linkInputData, newRunId, scriptFileForAttempt, type WorkspacePaths } from "./workspace.ts";
import { readResultFile } from "./script-runner.ts";
import { existsSync, readFileSync } from "node:fs";
import type { FeatureSnapshot } from "../features/types.ts";

export interface SubagentCaller {
  (prompt: string, opts: { timeoutMs: number }): Promise<{
    ok: boolean;
    text: string;
    error?: string;
  }>;
}

export interface RunAnalysisOptions {
  snapshot: FeatureSnapshot;
  store: ArtifactStore;
  subagent: SubagentCaller;
  defaultTimeoutSeconds?: number;
  maxScriptBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxResultBytes?: number;
  analysisDeps?: string[];
  /** Test hook: override workspace creation (deterministic runId/paths). */
  createWorkspaceForRun?: (runId: string) => WorkspacePaths;
  /** Stable run id for idempotent reruns (defaults to a fresh random id). */
  runId?: string;
  /** Cancellation: aborts before start, kills the script child on abort. */
  abortSignal?: AbortSignal;
}

export interface RunAnalysisOutput {
  route: "QUERY_GATEWAY" | "DATA_ANALYSIS_SUBAGENT" | "UNSUPPORTED" | "DATA_INPUT_REQUIRED";
  taskGate: TaskGateResult | null;
  summary?: AnalysisAgentSummary;
  artifact?: AnalysisResultArtifact;
  manifest?: ExecutionManifest;
  failure?: AnalysisFailure;
  content: string;
  details: AnalysisResultArtifact | { error: AnalysisFailure } | null;
}

const SCHEMA_VERSION = "1.0";

/** Extract the first balanced {...} JSON block (nested-safe). */
function extractBalancedJson(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") { if (start === -1) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && start !== -1) return text.slice(start, i + 1); }
  }
  return null;
}

/** Extract PLAN_JSON / SCRIPT_START..SCRIPT_END blocks from the subagent's
 *  final text message (text-output protocol, no write tool). */
export function extractPlanAndScript(text: string): {
  plan: unknown | null;
  script: string | null;
} {
  let plan: unknown | null = null;
  const planIdx = text.indexOf("PLAN_JSON:");
  if (planIdx >= 0) {
    const block = extractBalancedJson(text.slice(planIdx + "PLAN_JSON:".length));
    if (block) {
      try {
        plan = JSON.parse(block);
      } catch {
        plan = null;
      }
    }
  }
  let script: string | null = null;
  const scriptMatch = text.match(/SCRIPT_START([\s\S]*?)SCRIPT_END/);
  if (scriptMatch) script = scriptMatch[1]!.trim();
  return { plan, script };
}

/**
 * Deterministic result normalization: model-written scripts frequently emit
 * (a) TABLE rows as positional arrays or a single {"col": [...]} wrapper
 * instead of objects keyed by column name, and (b) chart `series` as a bare
 * object or as an array of [x, y] tuples. Both shapes are unambiguous, so
 * the host rewrites them instead of failing the whole analysis.
 */
function normalizeResultArtifact(artifact: unknown, maxSeriesPoints?: number): unknown {
  if (!artifact || typeof artifact !== "object") return artifact;
  const sections = (artifact as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return artifact;
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    if (section.type !== "TABLE" && section.type !== "METRIC_CARDS") {
      normalizeChartSection(section as Record<string, unknown>, maxSeriesPoints);
    }
    if (section.type !== "TABLE") continue;
    const columns = Array.isArray(section.columns)
      ? section.columns.map((c: { name?: unknown }) => String(c?.name ?? ""))
      : [];
    if (!Array.isArray(section.rows) || columns.length === 0) continue;
    section.rows = section.rows.map((row: unknown) => {
      let values: unknown[] | null = null;
      if (Array.isArray(row)) values = row;
      else if (row && typeof row === "object") {
        const entries = Object.entries(row);
        if (entries.length === 1 && Array.isArray(entries[0]![1]) && entries[0]![1].length === columns.length) {
          values = entries[0]![1] as unknown[];
        }
      }
      if (!values || values.length !== columns.length) return row;
      const zipped: Record<string, unknown> = {};
      columns.forEach((name, index) => {
        zipped[name] = values![index];
      });
      return zipped;
    });
  }
  return artifact;
}

/** Rewrite chart shapes that the validator rejects but are unambiguous. */
function normalizeChartSection(section: Record<string, unknown>, maxSeriesPoints?: number): void {
  if (typeof section.chartTitle !== "string" && typeof section.title === "string") {
    section.chartTitle = section.title;
  }
  if (typeof section.x !== "string" && typeof section.xField === "string") {
    section.x = section.xField;
  }
  let series = section.series;
  if (series && !Array.isArray(series) && typeof series === "object") {
    // a single bare series object: { name?, points: [...] }
    series = [series];
  }
  if (!Array.isArray(series)) return;
  section.series = series.map((ser: unknown) => {
    if (!ser || typeof ser !== "object") return ser;
    const s = ser as Record<string, unknown>;
    if (!Array.isArray(s.points)) return ser;
    s.points = (s.points as unknown[]).map((p: unknown) => {
      if (Array.isArray(p) && p.length >= 2) return { x: p[0], y: p[1] };
      return p;
    });
    return s;
  });
  // Deterministic downsampling before schema validation: an oversized chart
  // carries the same information at display resolution, so thin it instead of
  // failing the whole analysis (validator bound is re-checked afterwards).
  if (typeof maxSeriesPoints === "number" && Array.isArray(section.series)) {
    let total = 0;
    for (const ser of section.series as Array<{ points?: unknown[] }>) {
      total += Array.isArray(ser.points) ? ser.points.length : 0;
    }
    if (total > maxSeriesPoints) {
      const step = Math.ceil(total / maxSeriesPoints);
      for (const ser of section.series as Array<{ points?: unknown[] }>) {
        if (Array.isArray(ser.points)) ser.points = ser.points.filter((_, i) => i % step === 0);
      }
    }
  }
}

export async function runDataAnalysis(
  request: DataAnalysisRequest,
  options: RunAnalysisOptions,
): Promise<RunAnalysisOutput> {
  const flags = analysisFlags(options.snapshot);
  const timeoutSeconds = request.constraints?.timeoutSeconds ??
    options.defaultTimeoutSeconds ?? 120;
  const maxAttempts = Math.min(
    request.constraints?.maxAttempts ?? 2,
    flags.retry ? 2 : 1,
  );
  const maxOutputRows = request.constraints?.maxOutputRows ?? 500;
  const maxSeriesPoints = request.constraints?.maxSeriesPoints ?? 2000;
  const maxResultBytes = options.maxResultBytes ?? 1_000_000;
  const deps = options.analysisDeps ?? ["json", "csv", "math", "statistics", "datetime"];

  // 1. forbidden input
  const forbidden = checkForbiddenRequest(request);
  if (forbidden) {
    return {
      route: "UNSUPPORTED",
      taskGate: null,
      failure: { errorCode: "SANDBOX_VIOLATION", message: forbidden, retryable: false },
      content: `数据分析输入被拒绝：${forbidden}`,
      details: null,
    };
  }

  // 2-3. input resolution
  const resolved = await resolveAnalysisInput(request, options.store);
  if (resolved.missing.length > 0) {
    const failure: AnalysisFailure = {
      errorCode: "DATA_INPUT_REQUIRED",
      message: `缺少输入：${resolved.missing.join(", ")}`,
      retryable: true,
    };
    const summary = buildAgentSummary({
      artifactId: "",
      runId: "",
      status: "FAILED",
      title: request.objective,
      availableViews: [],
      findingRefs: [],
      warningCodes: [],
      dataInputRequired: { missing: resolved.missing, message: failure.message },
    });
    return {
      route: "DATA_INPUT_REQUIRED",
      taskGate: null,
      summary,
      failure,
      content: modelFacingContent(summary),
      details: { error: failure },
    };
  }

  // 4. task gate
  const gate = evaluateTaskGate(request);
  if (gate.route === "QUERY_GATEWAY") {
    return {
      route: "QUERY_GATEWAY",
      taskGate: gate,
      content: `简单聚合由 Query Gateway 直接计算（task gate: QUERY_GATEWAY）。请使用 execute_query 完成。`,
      details: null,
    };
  }

  if (gate.route === "UNSUPPORTED") {
    return {
      route: "UNSUPPORTED",
      taskGate: gate,
      failure: { errorCode: "UNSUPPORTED_ANALYSIS", message: "analysis type not supported", retryable: false },
      content: "该分析类型暂不支持。",
      details: null,
    };
  }

  // 5. workspace + subagent (isolated context)
  if (options.abortSignal?.aborted) {
    return {
      route: "DATA_ANALYSIS_SUBAGENT",
      taskGate: null,
      failure: { errorCode: "EXECUTION_TIMEOUT", message: "analysis aborted before start", retryable: true },
      content: "analysis aborted before start",
      details: null,
    };
  }
  const runId = options.runId ?? newRunId();
  const ws = options.createWorkspaceForRun
    ? options.createWorkspaceForRun(runId)
    : createWorkspace(runId);

  // Copy input data into the workspace (readonly links), build manifest.
  const inputLinks: Array<{ artifactId: string; path: string }> = [];
  for (const ref of resolved.dataRefs) {
    if (ref.resolvedPath) {
      const dest = linkInputData(ws, ref.artifactId, ref.resolvedPath);
      inputLinks.push({ artifactId: ref.artifactId, path: dest });
    }
  }
  const inputManifest = {
    runId,
    objective: request.objective,
    analysisType: request.analysisType,
    workspaceRoot: ws.root,
    inputDir: ws.inputDir,
    outputDir: ws.outputDir,
    resultFile: ws.resultFile,
    findingsFile: ws.findingsFile,
    inputs: resolved.dataRefs.map((r) => ({
      artifactId: r.artifactId,
      sourceType: r.sourceType,
      queryId: r.queryId,
      snapshotId: r.snapshotId,
      contentHash: r.contentHash,
      format: r.format,
      schema: r.schema,
      rowCount: r.rowCount,
      allowedColumns: r.allowedColumns,
      masked: r.masked,
    })),
    columns: resolved.columns,
    rowCount: resolved.rowCount,
    metricDefinitions: request.metricDefinitions,
    dimensions: request.dimensions,
    timeField: request.timeField,
    timeRange: request.timeRange,
    comparison: request.comparison,
    expectedViews: request.expectedViews,
    createdAt: new Date().toISOString(),
  };
  writeJson(ws.inputManifest, inputManifest);

  const planPath = ws.planFile;
  const scriptPath = ws.scriptFile;

  const subagentPrompt = buildSubagentPrompt({
    runId,
    request,
    inputManifestPath: ws.inputManifest,
    workspacePath: ws.root,
    planPath,
    scriptPath,
    maxAttempts,
    timeoutSeconds,
    outputSchemaHint: SCHEMA_VERSION,
  });

  // The subagent must plan AND emit the full analysis script in one reply;
  // measured wall time is ~90-150s on a cold API, so the request budget is a
  // floor, not the effective timeout — a tight budget turned slow-but-working
  // launches into SUBAGENT_LAUNCH_FAILED (eval 2026-08-03: 7/8 tasks lost).
  // the 240s floor applies only to normal-budget runs; an explicitly tiny
  // budget (e.g. a 1s stop-policy probe) must keep its semantics.
  const subagentTimeoutMs = timeoutSeconds >= 60 ? Math.max(timeoutSeconds * 1000, 240_000) : timeoutSeconds * 1000;
  let subagentResult = await options.subagent(subagentPrompt, {
    timeoutMs: subagentTimeoutMs,
  });
  if (!subagentResult.ok && timeoutSeconds >= 60 && /[Tt]imeout/.test(subagentResult.error ?? "")) {
    // Transient API slowness: one retry with an extended budget before
    // classifying the launch as failed.
    subagentResult = await options.subagent(subagentPrompt, {
      timeoutMs: Math.min(subagentTimeoutMs * 2, 600_000),
    });
  }
  if (subagentResult.ok && subagentResult.text) {
    // the subagent has no tools: plan + script arrive as text blocks
    const extracted = extractPlanAndScript(subagentResult.text);
    if (process.env.DA_DEBUG_PLAN === "1") {
      // eslint-disable-next-line no-console
      console.log("[da-debug] plan text:", subagentResult.text.slice(0, 1200));
    }
    if (extracted.plan) writeJson(planPath, extracted.plan);
    if (extracted.script) writeFileSync(scriptPath, extracted.script, "utf8");
  }
  if (!subagentResult.ok || subagentResult.error) {
    const failure: AnalysisFailure = {
      // the subagent PROCESS failed (launch/entry/RPC), not the analysis
      // script — never classify it as a script syntax error
      errorCode: "SUBAGENT_LAUNCH_FAILED",
      message: `analysis subagent launch failed: ${subagentResult.error ?? "no output"}`,
      retryable: true,
    };
    return {
      route: "DATA_ANALYSIS_SUBAGENT",
      taskGate: gate,
      failure,
      content: `数据分析子代理失败：${failure.message}`,
      details: null,
    };
  }

  // 6. plan validation (deterministic, before execution) with ONE bounded
  // corrective retry: validation issues are deterministic and precise, so
  // feeding them back to the subagent is cheap compared to failing the task.
  let plan = readJson<AnalysisPlan>(planPath);
  let planValidation = plan
    ? validateAnalysisPlan(plan, request, new Set(resolved.columns))
    : { valid: false, issues: [{ code: "PLAN_MISSING", message: "subagent did not write a plan" }] };
  if (!planValidation.valid) {
    const issuesText = planValidation.issues.map((i) => i.message).join("; ");
    const planRetryPrompt = [
      "Your AnalysisPlan failed deterministic validation. Fix ONLY the listed issues and regenerate the full AnalysisPlan and Python script in the same EXACT format.",
      `validationIssues: ${issuesText}`,
      `Reminder: the plan must match the request exactly (e.g. timeField must be "${request.timeField ?? ""}" when the request specifies one).`,
      `The plan objective MUST be exactly: ${request.objective}`,
      `Reminder: plan inputArtifacts MUST list these artifact ids: ${resolved.dataRefs.map((r) => r.artifactId).join(", ")}`,
    ].join("\n");
    const planRetry = await options.subagent(planRetryPrompt, { timeoutMs: subagentTimeoutMs });
    if (planRetry.ok && planRetry.text) {
      const extracted = extractPlanAndScript(planRetry.text);
      if (extracted.plan) writeJson(planPath, extracted.plan);
      if (extracted.script) writeFileSync(scriptPath, extracted.script, "utf8");
      plan = readJson<AnalysisPlan>(planPath);
      planValidation = plan
        ? validateAnalysisPlan(plan, request, new Set(resolved.columns))
        : { valid: false, issues: [{ code: "PLAN_MISSING", message: "subagent did not write a plan" }] };
    }
  }
  if (!planValidation.valid) {
    const failure: AnalysisFailure = {
      errorCode: "INPUT_SCHEMA_MISMATCH",
      message: `plan validation failed: ${planValidation.issues.map((i) => i.message).join("; ")}`,
      retryable: true,
    };
    return {
      route: "DATA_ANALYSIS_SUBAGENT",
      taskGate: gate,
      failure,
      content: `分析计划校验未通过：${failure.message}`,
      details: null,
    };
  }

  // 7. controlled execution with bounded retries
  const attempts: ExecutionManifest["attempts"] = [];
  const scriptHashes: string[] = [];
  let lastRun: RunScriptResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptScript = scriptFileForAttempt(ws, attempt);
    if (attempt > 1 && attemptScript !== scriptPath && readJson(planPath)) {
      // subagent writes attempt-versioned script; for the PoC the subagent
      // re-writes the same file — hash is captured per attempt.
      void attemptScript;
    }
    if (!existsSync(scriptPath)) {
      const failure: AnalysisFailure = {
        errorCode: "SCRIPT_SYNTAX_ERROR",
        message: `script not written by subagent (attempt ${attempt})`,
        retryable: attempt < maxAttempts,
      };
      return {
        route: "DATA_ANALYSIS_SUBAGENT",
        taskGate: gate,
        failure,
        content: failure.message,
        details: null,
      };
    }

    // Dependency check before running.
    const depCheck = checkDependencies(deps);
    if (!depCheck.ok) {
      const failure: AnalysisFailure = {
        errorCode: "SCRIPT_IMPORT_ERROR",
        message: `missing analysis dependencies: ${depCheck.missing.join(", ")}`,
        retryable: false,
      };
      return {
        route: "DATA_ANALYSIS_SUBAGENT",
        taskGate: gate,
        failure,
        content: failure.message,
        details: null,
      };
    }

    lastRun = await runAnalysisScript({
      runId,
      scriptPath,
      workspace: ws,
      timeoutSeconds,
      maxScriptBytes: options.maxScriptBytes ?? 200_000,
      maxStdoutBytes: options.maxStdoutBytes ?? 100_000,
      maxStderrBytes: options.maxStderrBytes ?? 100_000,
      maxResultBytes,
      abortSignal: options.abortSignal,
    });

    const scriptHash = sha256OfFile(scriptPath);
    scriptHashes.push(scriptHash);

    const outputOversize = outputTooLarge(ws, maxResultBytes);
    attempts.push({
      attempt,
      status: lastRun.ok && !outputOversize ? "SUCCEEDED" : "FAILED",
      errorCode: outputOversize ? "OUTPUT_TOO_LARGE" : lastRun.errorCode,
      errorMessage: outputOversize ? "result file exceeds limit" : lastRun.errorMessage,
      durationMs: lastRun.durationMs,
    });

    if (outputOversize) {
      const failure: AnalysisFailure = {
        errorCode: "OUTPUT_TOO_LARGE",
        message: "result file exceeds size limit",
        retryable: false,
      };
      return {
        route: "DATA_ANALYSIS_SUBAGENT",
        taskGate: gate,
        failure,
        content: failure.message,
        details: null,
      };
    }

    if (lastRun.ok) break;

    const retryable = ANALYSIS_SCRIPT_RETRYABLE.has(lastRun.errorCode ?? "SCRIPT_SYNTAX_ERROR");
    if (!retryable || attempt >= maxAttempts) {
      const failure: AnalysisFailure = {
        errorCode: lastRun.errorCode ?? "SCRIPT_SYNTAX_ERROR",
        // Do NOT include raw stderr in the model-facing message: script
        // output may contain numeric values. stderr stays in the workspace
        // logs and (for retryable errors) in the isolated subagent prompt.
        message: `analysis script failed with ${lastRun.errorCode ?? "SCRIPT_SYNTAX_ERROR"} (attempt ${attempt})`,
        retryable,
      };
      return {
        route: "DATA_ANALYSIS_SUBAGENT",
        taskGate: gate,
        failure,
        content: `数据分析脚本执行失败（attempt ${attempt}）：${failure.message}`,
        details: null,
      };
    }

    // Retry: ask the subagent to fix the script (bounded).
    const retryPrompt = [
      "The controlled runner reported a fixable error. Rewrite analysis.py to fix it.",
      `errorCode=${lastRun.errorCode}`,
      `stderr: ${lastRun.stderr.slice(0, 2000)}`,
      "Write the corrected script to the same path. Respond only with the fix summary (no numbers).",
    ].join("\n");
    const retryResult = await options.subagent(retryPrompt, { timeoutMs: 60_000 });
    if (!retryResult.ok) {
      const failure: AnalysisFailure = {
        errorCode: "SCRIPT_SYNTAX_ERROR",
        message: `retry subagent failed: ${retryResult.error ?? "no output"}`,
        retryable: false,
      };
      return {
        route: "DATA_ANALYSIS_SUBAGENT",
        taskGate: gate,
        failure,
        content: failure.message,
        details: null,
      };
    }
  }

  if (!lastRun?.ok) {
    const failure: AnalysisFailure = {
      errorCode: "SCRIPT_SYNTAX_ERROR",
      message: "script execution did not succeed",
      retryable: false,
    };
    return {
      route: "DATA_ANALYSIS_SUBAGENT",
      taskGate: gate,
      failure,
      content: failure.message,
      details: null,
    };
  }

  // 8. result validation + immutable artifact + manifest
  const resultRaw = readResultFile(ws, maxResultBytes);
  let artifactJson: string | null = null;
  try {
    artifactJson = resultRaw ? JSON.stringify(JSON.parse(resultRaw)) : null;
  } catch {
    artifactJson = null;
  }
  if (!artifactJson) {
    const failure: AnalysisFailure = {
      errorCode: "RESULT_SCHEMA_INVALID",
      message: "script did not produce valid analysis-result.json",
      retryable: true,
    };
    return {
      route: "DATA_ANALYSIS_SUBAGENT",
      taskGate: gate,
      failure,
      content: failure.message,
      details: null,
    };
  }

  const parsed = normalizeResultArtifact(JSON.parse(artifactJson) as unknown, maxSeriesPoints);
  artifactJson = JSON.stringify(parsed);
  const validation = validateResultArtifact({
    artifact: parsed,
    maxOutputRows,
    maxSeriesPoints,
    maxSections: 50,
  });
  if (!validation.valid || !validation.artifact) {
    const failure: AnalysisFailure = {
      errorCode: "RESULT_SCHEMA_INVALID",
      message: `result validation: ${validation.issues.map((i) => i.message).join("; ")}`,
      retryable: true,
    };
    return {
      route: "DATA_ANALYSIS_SUBAGENT",
      taskGate: gate,
      failure,
      content: failure.message,
      details: null,
    };
  }

  // Bound tables and downsample charts deterministically.
  const artifact = validation.artifact;
  artifact.sections = artifact.sections.map((s) => {
    if (s.type === "TABLE") return boundTableRows(s, maxOutputRows);
    if (s.type !== "METRIC_CARDS") return downsampleSeries(s, maxSeriesPoints);
    return s;
  });
  artifact.schemaVersion = SCHEMA_VERSION;
  artifact.runId = runId;
  artifact.reviewStatus = "NOT_REVIEWED";
  artifact.validationRefs = [];
  artifact.createdAt = new Date().toISOString();
  artifact.artifactId = newArtifactId(`${runId}:${artifactJson}`);

  // findings
  let findingRefs: string[] = [];
  const findingsRaw = readJson<{ findings: unknown }>(ws.findingsFile);
  if (flags.findings && findingsRaw) {
    const fv = validateFindings(findingsRaw);
    if (fv.valid) {
      const findingsArtifactId = newArtifactId(`${runId}:findings`);
      writeJson(ws.findingsFile, { schemaVersion: SCHEMA_VERSION, runId, findings: fv.findings });
      findingRefs = fv.findings.map((f) => f.findingId);
      artifact.findingsRef = findingsArtifactId;
    }
  }

  // execution manifest (provenance for round-5)
  const manifest: ExecutionManifest = {
    runId,
    artifactId: artifact.artifactId,
    inputArtifacts: resolved.dataRefs.map((r) => ({
      artifactId: r.artifactId,
      queryId: r.queryId,
      snapshotId: r.snapshotId,
      contentHash: r.contentHash,
    })),
    scriptHash: scriptHashes[scriptHashes.length - 1] ?? "",
    scriptAttempts: attempts.length,
    runtimeVersions: { python: "3", node: process.version },
    dependencyVersions: {},
    attempts,
    warnings: [],
    createdAt: new Date().toISOString(),
  };
  writeJson(ws.executionManifestFile, manifest);
  artifact.executionManifestRef = newArtifactId(`${runId}:manifest`);
  // persist the REAL analysis plan + execution manifest + script provenance
  // in the trusted store so reviewers consume genuine evidence (never
  // synthetic substitutes)
  if (plan) {
    artifact.analysisPlanRef = newArtifactId(`${runId}:plan`);
    try {
      options.store.writeResult(artifact.analysisPlanRef, JSON.stringify(plan));
    } catch {
      // immutable rerun
    }
  }
  // persist manifest + script provenance in the trusted store so the Round 5
  // reviewer can build a real proposal bound to real artifacts
  try {
    options.store.writeResult(artifact.executionManifestRef, JSON.stringify(manifest));
  } catch {
    // immutable: identical deterministic id on rerun is acceptable
  }
  artifact.inputManifestRef = newArtifactId(`${runId}:input-manifest`);
  try {
    // the FULL input manifest the script executed against is frozen so a
    // reviewer replay can reconstruct the EXACT same environment contract
    options.store.writeResult(artifact.inputManifestRef, JSON.stringify(inputManifest));
  } catch {
    // immutable rerun
  }
  artifact.scriptArtifactRef = newArtifactId(`${runId}:script`);
  try {
    // REAL script CONTENT is frozen too (not just the hash): the graph
    // reviewer's computation replay re-executes THIS text on the frozen
    // inputs, so it must be durable and immutable
    let scriptContent = "";
    try {
      scriptContent = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";
    } catch {
      scriptContent = "";
    }
    options.store.writeResult(artifact.scriptArtifactRef, JSON.stringify({
      scriptHash: scriptHashes[scriptHashes.length - 1] ?? "",
      scriptContent,
      runId,
      createdAt: new Date().toISOString(),
    }));
  } catch {
    // immutable rerun
  }

  // immutable persistence
  const finalJson = JSON.stringify(artifact, null, 2);
  let artifactPath: string;
  try {
    artifactPath = options.store.writeResult(artifact.artifactId, finalJson);
  } catch {
    // already exists (same deterministic id) — acceptable for re-runs.
    artifactPath = artifact.artifactId;
  }
  writeJson(ws.resultFile, artifact);

  const summary = buildAgentSummary({
    artifactId: artifact.artifactId,
    runId,
    status: artifact.status,
    title: artifact.title,
    availableViews: artifact.sections.map((s) => s.type),
    findingRefs,
    warningCodes: artifact.sections
      .filter((s) => s.type !== "METRIC_CARDS" && (s as { warnings?: string[] }).warnings)
      .flatMap((s) => (s as { warnings?: string[] }).warnings ?? []),
  });

  return {
    route: "DATA_ANALYSIS_SUBAGENT",
    taskGate: gate,
    summary,
    artifact,
    manifest,
    content: modelFacingContent(summary),
    details: artifact,
  };
}

export { CANARY_NUMBER };
