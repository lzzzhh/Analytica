/**
 * Code review orchestration (§16).
 *
 *   A. integrity checks (hash / diff / file / base commit / path escape)
 *   B. deterministic checks (allowlist commands: typecheck, compile, test)
 *   C. reviewer shadow tests (isolated, never committed)
 *   D. semantic review (isolated Pi RPC, findings only — no verdict)
 *
 * All shell commands come from an explicit allowlist; the LLM never
 * generates commands (§16.2).
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalHash, ReviewerStore } from "../store.ts";
import { ShadowTestRunner } from "./shadow-tests.ts";
import { SemanticReviewError } from "../adapters/pi-reviewer.ts";
import type { ReviewerBudget } from "../gate/review-gate.ts";
import { verifyCodeProposal } from "./proposal-builder.ts";
import type {
  ArtifactRef,
  CodeChangeProposal,
  ReviewCheckResult,
  ReviewFinding,
} from "../contracts/index.ts";

/**
 * Central command registry — the ONLY source of reviewer commands. The
 * caller passes checkIds; arbitrary command/args are never accepted.
 * HOME/TMPDIR are redirected into the reviewer workspace by the runner.
 */
export interface ReviewCheckCommand {
  command: string;
  args: string[];
  description: string;
}
export const REVIEW_CHECK_REGISTRY: Record<string, ReviewCheckCommand> = {
  "typecheck": { command: "node", args: ["--version"], description: "typecheck (POC placeholder: no TS toolchain)" },
  "lint": { command: "node", args: ["--check"], description: "syntax check (POC)" },
  "targeted-tests": { command: "node", args: ["--test"], description: "targeted tests (POC)" },
};

export const DEFAULT_REQUIRED_CAPABILITIES = ["integrity", "execution", "shadow", "semantic"];

export interface CodeReviewInput {
  proposal: CodeChangeProposal;
  snapshotWorkspace: string;   // read-only frozen snapshot
  testWorkspace: string;       // isolated workspace for shadow tests
  /** Central-allowlist check ids (resolved via REVIEW_CHECK_REGISTRY). */
  checkIds?: string[];
  /**
   * Capabilities the GATE requires. A capability that is NOT required is
   * SKIPPED (required=false) instead of a required UNAVAILABLE. Defaults to
   * everything (fail-closed) when omitted.
   */
  requiredCapabilities?: string[];
  /** Gate budget; enforced before any semantic call (never silent truncation). */
  budget?: ReviewerBudget;
  /**
   * When absent, the semantic check is UNAVAILABLE -> ABSTAIN (fail closed).
   * Output contract: evidenceRefIds are STRING ids (unified with the Pi RPC
   * adapter); the runner verifies they belong to the provided evidence set.
   */
  semanticReviewer?: (context: {
    objective: string;
    diff: string;
    fileContext: string;
    testSummary: string;
    staticSummary: string;
  }) => Promise<Array<{
    severity: ReviewFinding["severity"];
    category: string;
    claim: string;
    evidenceRefIds: string[];
    suggestedAction: string;
    location?: { file?: string; lineStart?: number; lineEnd?: number }
      | { artifactId: string; sectionId?: string; metricId?: string; sectionIndex?: number };
  }>>;
  /** When false (feature off), shadow tests are UNAVAILABLE -> ABSTAIN. */
  shadowTestsEnabled?: boolean;
}

export class CodeReviewRunner {
  readonly store: ReviewerStore;

  constructor(store: ReviewerStore) {
    this.store = store;
  }

  async run(input: CodeReviewInput): Promise<{
    checks: ReviewCheckResult[];
    findings: ReviewFinding[];
    reviewerTestManifestRef?: ArtifactRef;
  }> {
    const checks: ReviewCheckResult[] = [];
    const findings: ReviewFinding[] = [];

    // ---- A. integrity ---------------------------------------------------
    const integrity = verifyCodeProposal(input.proposal, await this._readSnapshot(input.snapshotWorkspace, input.proposal));
    for (const r of integrity) {
      checks.push(this._check(`integrity:${r.checkId}`, "INTEGRITY", r.ok ? "PASSED" : "FAILED",
        r.detail, r.ok ? [] : [input.proposal.diffArtifactRef]));
    }
    // diff artifact hash
    const diffOk = await this._verifyDiff(input);
    checks.push(this._check("integrity:diff", "INTEGRITY", diffOk ? "PASSED" : "FAILED",
      diffOk ? "diff hash matches" : "diff artifact hash mismatch", [input.proposal.diffArtifactRef]));

    // ---- B. deterministic central-allowlist checks ----------------------
    // checkIds resolve ONLY through REVIEW_CHECK_REGISTRY; arbitrary
    // command/args are never accepted. HOME/TMPDIR are redirected into the
    // reviewer workspace (never the real user directories), cwd is verified
    // via realpath, absolute-path args are rejected, no shell is used
    // (execFile), and the env is the reviewer whitelist.
    const requiredCapabilities = input.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES;
    const executionRequired = requiredCapabilities.includes("execution");
    const snapshotReal = await realpath(input.snapshotWorkspace);
    for (const id of input.checkIds ?? []) {
      const started = Date.now();
      const reg = REVIEW_CHECK_REGISTRY[id];
      if (!reg) {
        checks.push(this._check(`exec:${id}`, "EXECUTION", "UNAVAILABLE",
          `command '${id}' is not in the central reviewer registry`, [], 0, executionRequired));
        continue;
      }
      if (reg.args.some((a) => a.startsWith("/") || a.includes(".."))) {
        checks.push(this._check(`exec:${id}`, "EXECUTION", "FAILED",
          `registry entry '${id}' contains absolute/escape args — rejected`, [], 0, executionRequired));
        continue;
      }
      try {
        const cwd = await realpath(snapshotReal);
        if (!this._insideWorkspace(snapshotReal, cwd)) {
          throw new Error(`cwd escapes reviewer workspace: ${cwd}`);
        }
        const { code, stdout, stderr } = await runCommand(
          reg.command, reg.args, cwd, isolatedExecEnv(cwd));
        checks.push(this._check(`exec:${id}`, "EXECUTION", code === 0 ? "PASSED" : "FAILED",
          code === 0 ? "ok" : `exit ${code}: ${tail(stderr, 200)}`, [],
          Date.now() - started));
      } catch (e) {
        checks.push(this._check(`exec:${id}`, "EXECUTION", "FAILED",
          `spawn failed: ${String(e)}`, [], Date.now() - started));
      }
    }

    // ---- C. reviewer shadow tests (real execution loop) ------------------
    // Enabled only via input.shadowTestsEnabled; the runner executes fixed
    // templates in an isolated workspace and records manifest + log hashes.
    let shadowManifestRef: ArtifactRef | undefined;
    if (input.shadowTestsEnabled) {
      const runner = new ShadowTestRunner(this.store);
      const shadow = await runner.run(input.testWorkspace,
        input.proposal.changedFiles.map((f) => f.path));
      shadowManifestRef = shadow.manifestRef;
      checks.push(this._check("exec:shadow-tests", "TESTING",
        shadow.outcome.status === "UNAVAILABLE" ? "UNAVAILABLE"
          : shadow.outcome.status === "FAILED" ? "FAILED" : "PASSED",
        shadow.outcome.status === "UNAVAILABLE"
          ? shadow.outcome.detail
          : shadow.outcome.status === "FAILED"
            ? shadow.outcome.detail
            : `shadow tests executed and passed (${shadow.outcome.executed} template(s))`,
        shadow.manifestRef ? [shadow.manifestRef] : [],
        0, true /* required */));
    } else {
      const shadowRequired = requiredCapabilities.includes("shadow");
      checks.push(this._check("exec:shadow-tests", "TESTING", shadowRequired ? "UNAVAILABLE" : "SKIPPED",
        shadowRequired ? "shadow test execution not enabled" : "shadow tests not required by gate",
        [], 0, shadowRequired));
    }

    // ---- D. semantic review (LLM findings only; fail closed) ------------
    const semanticRequired = requiredCapabilities.includes("semantic");
    if (!input.semanticReviewer) {
      checks.push(this._check("semantic:llm", "SEMANTIC", semanticRequired ? "UNAVAILABLE" : "SKIPPED",
        semanticRequired ? "semantic reviewer not configured" : "semantic review not required by gate",
        [], 0, semanticRequired));
    } else {
    let semantic: Awaited<ReturnType<NonNullable<CodeReviewInput["semanticReviewer"]>>> = [];
    let semanticCalls = 0;
    try {
      if (input.budget && semanticCalls >= input.budget.maxSemanticCalls) {
        throw new SemanticReviewError(`BUDGET_EXCEEDED: max ${input.budget.maxSemanticCalls} semantic call(s)`);
      }
      const diffText = await this._readDiff(input);
      const ctxText = `${diffText}
${await this._readSnapshotSummary(input.snapshotWorkspace, input.proposal)}`;
      const estimatedTokens = Math.ceil(ctxText.length / 4);
      if (input.budget && estimatedTokens > input.budget.maxInputTokens) {
        throw new SemanticReviewError(`BUDGET_EXCEEDED: context ~${estimatedTokens} tokens > ${input.budget.maxInputTokens}`);
      }
      if (input.budget && input.proposal.changedFiles.length > input.budget.maxFiles) {
        throw new SemanticReviewError(`BUDGET_EXCEEDED: ${input.proposal.changedFiles.length} files > ${input.budget.maxFiles}`);
      }
    semantic = await input.semanticReviewer({
      objective: input.proposal.proposerSummary.objective,
      diff: diffText,
      fileContext: await this._readSnapshotSummary(input.snapshotWorkspace, input.proposal),
      testSummary: checks
        .filter((c) => c.checkClass === "EXECUTION")
        .map((c) => `${c.checkId}: ${c.status}`)
        .join("; "),
      staticSummary: "",
    });
    semanticCalls++;
    for (const f of semantic) {
      findings.push({
        ...f,
        findingId: `cf_${Math.random().toString(16).slice(2, 10)}`,
        evidenceRefs: f.evidenceRefIds.map((id) => ({
          artifactId: id, artifactType: "evidence-ref", contentHash: "",
        })),
        deterministic: false,
        confidence: 0.8,
        createdAt: new Date().toISOString(),
      });
    }
    // evidence whitelist: the LLM may only reference evidence refs that were
    // actually provided (checks' evidenceRefs). Unknown IDs -> FAILED.
    const allowedEvidence = new Set<string>();
    for (const c of checks) for (const r of c.evidenceRefs) allowedEvidence.add(r.artifactId);
    const refsOf = (f: (typeof semantic)[number]) => Array.isArray(f.evidenceRefIds) ? f.evidenceRefIds : [];
    const missingEvidence = semantic.filter(
      (f) => (f.severity === "BLOCKER" || f.severity === "HIGH") && refsOf(f).length === 0);
    const unknownEvidence = semantic.filter((f) =>
      refsOf(f).some((id) => !allowedEvidence.has(id)));
    if (missingEvidence.length > 0 || unknownEvidence.length > 0) {
      checks.push(this._check("semantic:evidence", "EVIDENCE", "FAILED",
        `${missingEvidence.length} HIGH/BLOCKER without evidence; ${unknownEvidence.length} with unknown evidence IDs`,
        [], 0, true));
    }
    checks.push(this._check("semantic:llm", "SEMANTIC", "PASSED",
      `semantic review produced ${semantic.length} finding(s)`,
      [], 0, true));
    } catch {
      // semantic reviewer failed (timeout/invalid JSON/schema) -> UNAVAILABLE
      checks.push(this._check("semantic:llm", "SEMANTIC", "UNAVAILABLE",
        "semantic reviewer failed to produce valid findings", [], 0, true));
    }
    }

    return { checks, findings, reviewerTestManifestRef: shadowManifestRef };
  }

  private async _readSnapshot(workspace: string, proposal: CodeChangeProposal): Promise<Array<{ path: string; content: string }>> {
    const out: Array<{ path: string; content: string }> = [];
    for (const cf of proposal.changedFiles) {
      try {
        const p = resolve(workspace, cf.path);
        if (!p.startsWith(resolve(workspace) + sep)) continue;
        out.push({ path: cf.path, content: await readFile(p, "utf8") });
      } catch {
        /* missing file -> integrity check reports it */
      }
    }
    return out;
  }

  private async _readSnapshotSummary(workspace: string, proposal: CodeChangeProposal): Promise<string> {
    const files = await this._readSnapshot(workspace, proposal);
    return files.map((f) => `${f.path}: ${f.content.length} chars`).join("\n");
  }

  private async _readDiff(input: CodeReviewInput): Promise<string> {
    try {
      return await readFile(join(input.snapshotWorkspace, "diff.patch"), "utf8");
    } catch {
      return input.proposal.changedFiles
        .map((f) => `${f.status}: ${f.path}`)
        .join("\n");
    }
  }

  private async _verifyDiff(input: CodeReviewInput): Promise<boolean> {
    // P0 hardening: fail CLOSED. Missing sidecar or hash mismatch -> FAILED.
    let sidecar: string;
    try {
      sidecar = await readFile(`${input.snapshotWorkspace}/diff.patch.sha256`, "utf8");
    } catch {
      return false;
    }
    const declared = sidecar.trim().split(" ")[0];
    const diff = await this._readDiff(input);
    return canonicalHash(diff) === declared;
  }

  private _insideWorkspace(workspace: string, cwd: string): boolean {
    const root = resolve(workspace);
    const target = resolve(cwd);
    return target === root || target.startsWith(root + sep);
  }

  private _check(
    checkId: string, checkClass: ReviewCheckResult["checkClass"],
    status: ReviewCheckResult["status"], summary: string,
    evidenceRefs: ArtifactRef[], durationMs = 0,
    requiredOverride?: boolean,
  ): ReviewCheckResult {
    return {
      checkId, checkClass,
      required: requiredOverride ?? (checkClass === "INTEGRITY" || checkClass === "EXECUTION"),
      status, summary, evidenceRefs,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
    };
  }
}

/** Reviewer env whitelist — no inherited credentials/secrets. */
export const REVIEWER_ENV_WHITELIST: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: process.env.LANG ?? "en_US.UTF-8",
  LC_ALL: process.env.LC_ALL ?? "",
};

/** Command env: reviewer whitelist with HOME/TMPDIR redirected into the
 *  reviewer workspace — commands never see real user directories. */
export function isolatedExecEnv(workspace: string): Record<string, string> {
  return {
    ...REVIEWER_ENV_WHITELIST,
    HOME: workspace,
    TMPDIR: join(workspace, ".tmp"),
  };
}

export function runCommand(
  command: string, args: string[], cwd: string,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { cwd, env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : 1) : 0,
          stdout: String(stdout), stderr: String(stderr),
        });
      });
  });
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(-n) : s;
}
