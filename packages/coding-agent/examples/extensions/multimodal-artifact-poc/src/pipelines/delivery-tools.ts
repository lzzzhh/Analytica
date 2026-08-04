/**
 * Delivery-chain tools — pipeline ingest, write-gate check, promotion guard.
 *
 * These close the abstraction chain the tool-calling evaluation found
 * missing: materialize -> pipeline write -> WriteGate -> Promotion.
 *
 * - materialize_query lives in data-tools (gateway API).
 * - pipeline_ingest: governed arbitrary-source ingestion via the product
 *   Python CLI (pipelines.run --contract); governance is enforced by the
 *   CLI itself (no approval -> refusal before any warehouse write).
 * - write_gate_check: READ-ONLY authorization check against the governance
 *   repository (sealed approval + OPERATOR_CLI decision + hash bindings).
 * - promote_analysis: deterministic promotion authorization from the
 *   review decision (verdict + gate delivery mode) — never performs the
 *   promotion itself.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "../../../../../src/core/extensions/types.ts";

const POC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// pipeline_ingest — governed arbitrary-source ingestion
// ---------------------------------------------------------------------------

const IngestSchema = Type.Object({
  contractPath: Type.String({ description: "absolute path to the frozen ingestion contract (JSON)" }),
  warehouse: Type.String({ description: "absolute local warehouse path" }),
  governanceRoot: Type.Optional(Type.String({ description: "governance repository holding the bound approval (default PIPELINE_GOVERNANCE_ROOT)" })),
  dryRun: Type.Optional(Type.Boolean({ description: "validate + plan only; no runtime artifacts" })),
});

type IngestParams = Static<typeof IngestSchema>;

function runPythonCli(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile("python3", args, {
      cwd: POC_ROOT,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        LAKEHOUSE_GATEWAY_URL: process.env.LAKEHOUSE_GATEWAY_URL ?? "",
      },
    }, (error, stdout, stderr) => {
      resolvePromise({
        code: error ? (typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : 1) : 0,
        stdout: String(stdout), stderr: String(stderr),
      });
    });
  });
}

/** Last JSON document on stdout (run.py --contract prints the result JSON). */
function lastJson(text: string): unknown | null {
  const lines = text.split("\n").filter((l) => l.trim().startsWith("{"));
  for (const line of [...lines].reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning
    }
  }
  return null;
}

export const PIPELINE_INGEST_TOOL: ToolDefinition<typeof IngestSchema, unknown> = {
  name: "pipeline_ingest",
  label: "Pipeline Ingest",
  description:
    "Governed declarative ingestion of a frozen local CSV/Parquet file into an " +
    "explicitly configured warehouse. Runs the product pipeline CLI with the " +
    "contract (source path/hash/format/target/schema policy/primary key/event " +
    "time/quality rules/approvalId). Write authorization is ENFORCED by the " +
    "pipeline itself: without a valid sealed approval the run refuses before " +
    "creating any warehouse object. dryRun validates and plans only.",
  promptSnippet: "pipeline_ingest(contractPath, warehouse, governanceRoot?, dryRun?) — governed ingestion",
  promptGuidelines: [
    "Only ingest files the user explicitly authorized; never bypass governance.",
    "Use dryRun first when unsure; inspect the plan and quality findings before a real write.",
  ],
  parameters: IngestSchema,

  async execute(
    _toolCallId: string,
    params: IngestParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const governanceRoot = params.governanceRoot
      ?? process.env.PIPELINE_GOVERNANCE_ROOT
      ?? ".data/pipeline-governance";
    const args = [
      "-m", "pipelines.run",
      "--contract", params.contractPath,
      "--warehouse", params.warehouse,
      "--governance-root", governanceRoot,
    ];
    if (params.dryRun) args.push("--dry-run");
    try {
      const { code, stdout, stderr } = await runPythonCli(args, 300_000);
      const result = lastJson(stdout) ?? { raw: stdout.slice(-800), stderr: stderr.slice(-400) };
      const ok = code === 0 && (result as { success?: boolean }).success !== false;
      return {
        content: [{
          type: "text",
          text: ok
            ? `pipeline_ingest ${params.dryRun ? "dry-run" : "run"}: success (${JSON.stringify(result).slice(0, 400)})`
            : `pipeline_ingest refused: ${JSON.stringify(result).slice(0, 500)}`,
        }],
        details: { code, result, stderr: stderr.slice(-1000) },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `pipeline_ingest failed: ${String(error)}` }],
        details: { error: String(error) },
      };
    }
  },
};

// ---------------------------------------------------------------------------
// write_gate_check — read-only authorization query on the governance repo
// ---------------------------------------------------------------------------

const WriteGateSchema = Type.Object({
  target: Type.String({ description: "target table, e.g. eval_raw.sample" }),
  governanceRoot: Type.Optional(Type.String({ description: "governance repository (default PIPELINE_GOVERNANCE_ROOT)" })),
});

type WriteGateParams = Static<typeof WriteGateSchema>;

/** Canonical JSON hash matching the python governance sha256_canonical. */
export function canonicalJsonHash(obj: unknown): string {
  const canonical = JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort() as never, undefined as never);
  // JSON.stringify with sorted keys via replacer
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  const canonical2 = JSON.stringify(sortKeys(obj));
  return `sha256:${createHash("sha256").update(canonical2).digest("hex")}`;
}

function repoObject(root: string, type: string, id: string, version: number): Record<string, unknown> | null {
  const path = join(root, "objects", type, `${id}@${version}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read-only authorization state for a write target (mirrors the python
 *  WriteGate._sealed_approval_for checks: sealed spec + OPERATOR_CLI APPROVE
 *  decision + hash bindings). The python gate remains the enforcement point. */
export function checkWriteAuthorization(target: string, governanceRoot: string): {
  authorized: boolean;
  approvalId?: string;
  reasons: string[];
} {
  const reasons: string[] = [];
  const ledgerPath = join(governanceRoot, "ledger.jsonl");
  if (!existsSync(ledgerPath)) {
    return { authorized: false, reasons: ["governance repository does not exist"] };
  }
  const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry["type"] !== "approved-pipeline-spec") continue;
    const id = String(entry["id"]);
    const version = Number(entry["version"]);
    const seal = repoObject(governanceRoot, "approved-pipeline-spec", id, version);
    if (!seal) {
      reasons.push(`seal ${id}@${version} missing from repository`);
      continue;
    }
    const content = (seal["content"] ?? seal) as Record<string, unknown>;
    const approvalId = String(content["approvalId"] ?? "");
    if (!approvalId) {
      reasons.push(`seal ${id}@${version} has no approvalId`);
      continue;
    }
    if (String(content["target"] ?? "") !== target) {
      continue; // seal for another target
    }
    // the operator decision must exist and be an OPERATOR_CLI APPROVE
    let decisionOk = false;
    for (const dline of lines) {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(dline) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (d["type"] !== "approval-decision") continue;
      const decision = repoObject(governanceRoot, "approval-decision", String(d["id"]), Number(d["version"]));
      const dc = (decision?.["content"] ?? decision) as Record<string, unknown> | null;
      if (dc && String(dc["approvalId"] ?? "") === approvalId) {
        decisionOk = String(dc["decision"]) === "APPROVE" && String(dc["approverSource"]) === "OPERATOR_CLI";
        break;
      }
    }
    if (!decisionOk) {
      reasons.push(`approval ${approvalId} has no OPERATOR_CLI APPROVE decision`);
      continue;
    }
    // pipelineSpecHash binding
    const specId = String(content["specId"] ?? "");
    const specVersion = Number(content["version"] ?? version);
    const spec = repoObject(governanceRoot, "pipeline-spec", specId, specVersion);
    const specContent = (spec?.["content"] ?? spec) as Record<string, unknown> | null;
    const expectedSpecHash = String(content["pipelineSpecHash"] ?? "");
    if (specContent && expectedSpecHash && canonicalJsonHash(specContent) !== expectedSpecHash) {
      reasons.push(`seal ${id}@${version} pipelineSpecHash mismatch`);
      continue;
    }
    return { authorized: true, approvalId, reasons: ["sealed OPERATOR_CLI approval verified"] };
  }
  return { authorized: false, reasons: reasons.length ? reasons : [`no sealed approval covers target '${target}'`] };
}

export const WRITE_GATE_CHECK_TOOL: ToolDefinition<typeof WriteGateSchema, unknown> = {
  name: "write_gate_check",
  label: "Write Gate Check",
  description:
    "Read-only check whether a target table has a valid sealed approval in the " +
    "governance repository (sealed spec + OPERATOR_CLI APPROVE decision + hash " +
    "bindings). The actual write enforcement lives in the pipeline WriteGate — " +
    "this tool only reports authorization state before a write is attempted.",
  promptSnippet: "write_gate_check(target, governanceRoot?) — is this write authorized?",
  promptGuidelines: [
    "Call before pipeline_ingest to confirm authorization exists.",
    "An unauthorized target must never be written; report the refusal.",
  ],
  parameters: WriteGateSchema,

  async execute(
    _toolCallId: string,
    params: WriteGateParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const governanceRoot = params.governanceRoot
      ?? process.env.PIPELINE_GOVERNANCE_ROOT
      ?? ".data/pipeline-governance";
    try {
      const state = checkWriteAuthorization(params.target, governanceRoot);
      return {
        content: [{
          type: "text",
          text: state.authorized
            ? `write_gate_check ${params.target}: AUTHORIZED (approval ${state.approvalId})`
            : `write_gate_check ${params.target}: BLOCKED — ${state.reasons.join("; ")}`,
        }],
        details: state,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `write_gate_check failed: ${String(error)}` }],
        details: { error: String(error) },
      };
    }
  },
};

// ---------------------------------------------------------------------------
// promote_analysis — deterministic promotion authorization from a review
// ---------------------------------------------------------------------------

const PromoteSchema = Type.Object({
  reviewId: Type.String({ description: "review decision id (e.g. review_<hash>), from review_data_analysis" }),
  action: Type.Optional(Type.Union([
    Type.Literal("MERGE_CODE"), Type.Literal("PUBLISH_REPORT"), Type.Literal("PUBLISH_PRESENTATION"),
    Type.Literal("PRODUCTION_WRITE"), Type.Literal("REQUEST_HUMAN_APPROVAL"),
    Type.Literal("DELIVER_EXPLORATORY_RESULT"),
  ], { description: "single action to authorize (default: list all)" })),
  storeRoot: Type.Optional(Type.String({ description: "reviewer store root (default REVIEWER_STORE_ROOT)" })),
});

type PromoteParams = Static<typeof PromoteSchema>;

export const PROMOTE_ANALYSIS_TOOL: ToolDefinition<typeof PromoteSchema, unknown> = {
  name: "promote_analysis",
  label: "Promote Analysis",
  description:
    "Deterministic promotion authorization for a review decision: given the " +
    "reviewId, loads the decision and its gate, and reports which delivery " +
    "actions are allowed (PASS) or denied (CHANGES_REQUIRED / REJECT / " +
    "ABSTAIN / UNREVIEWED_LOW_RISK with EXPLORATORY restrictions). This tool " +
    "NEVER performs the promotion — it only authorizes.",
  promptSnippet: "promote_analysis(reviewId, action?) — may this review be delivered?",
  promptGuidelines: [
    "Formal delivery requires PASS; ABSTAIN/CHANGES_REQUIRED/REJECT block promotion.",
    "EXPLORATORY_UNREVIEWED only permits exploratory delivery.",
  ],
  parameters: PromoteSchema,

  async execute(
    _toolCallId: string,
    params: PromoteParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const root = params.storeRoot ?? process.env.REVIEWER_STORE_ROOT;
    if (!root) {
      return {
        content: [{ type: "text", text: "promote_analysis: REVIEWER_STORE_ROOT not set" }],
        details: { error: "store not configured" },
      };
    }
    try {
      const reviewsRoot = join(root, "reviews");
      let decision: Record<string, unknown> | null = null;
      let gate: Record<string, unknown> | null = null;
      for (const keyDir of readdirSync(reviewsRoot)) {
        // terminal-pointer.json is the atomic commit point for TERMINAL
        // verdicts only; ABSTAIN is intentionally non-terminal (orchestrator
        // contract). Falling back to the latest attempt keeps ABSTAIN reviews
        // resolvable — without this, promote_analysis reports "not found"
        // for every ABSTAIN decision and promotion checks silently skip.
        let attemptId: string | null = null;
        const pointerPath = join(reviewsRoot, keyDir, "terminal-pointer.json");
        if (existsSync(pointerPath)) {
          const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { attemptId?: string };
          attemptId = pointer.attemptId ?? null;
        } else {
          const attemptsRoot = join(reviewsRoot, keyDir, "attempts");
          if (existsSync(attemptsRoot)) {
            const attempts = readdirSync(attemptsRoot)
              .filter((name) => existsSync(join(attemptsRoot, name, "decision.json")))
              .sort();
            attemptId = attempts[attempts.length - 1] ?? null;
          }
        }
        if (!attemptId) continue;
        const decisionPath = join(reviewsRoot, keyDir, "attempts", attemptId, "decision.json");
        if (!existsSync(decisionPath)) continue;
        const d = JSON.parse(readFileSync(decisionPath, "utf8")) as Record<string, unknown>;
        if (String(d["reviewId"]) !== params.reviewId) continue;
        decision = d;
        const gateRef = (d["gateDecisionRef"] ?? {}) as { artifactId?: string; contentHash?: string };
        if (gateRef.artifactId) {
          const gatePath = join(root, gateRef.artifactId);
          if (existsSync(gatePath)) {
            const rec = JSON.parse(readFileSync(gatePath, "utf8")) as Record<string, unknown>;
            gate = (rec["content"] ?? rec) as Record<string, unknown>;
          }
        }
        break;
      }
      if (!decision) {
        return {
          content: [{ type: "text", text: `promote_analysis: review ${params.reviewId} not found` }],
          details: { error: "REVIEW_NOT_FOUND" },
        };
      }
      const { authorizePromotion, authorizeAction } = await import("../reviewer/gate/review-gate.ts");
      const verdict = String(decision["verdict"]);
      const gateView = {
        reviewMode: String(gate?.["reviewMode"] ?? "STANDARD"),
        deliveryMode: String(gate?.["deliveryMode"] ?? "NORMAL"),
        restrictions: Array.isArray(gate?.["restrictions"]) ? gate!["restrictions"] as string[] : [],
      };
      if (params.action) {
        const auth = authorizeAction(params.action, verdict as never, gateView as never);
        return {
          content: [{ type: "text", text: `promote_analysis ${params.action} for ${params.reviewId}: ${auth.allowed ? "ALLOWED" : `DENIED — ${auth.reason ?? verdict}`}` }],
          details: auth,
        };
      }
      const auth = authorizePromotion(verdict as never, gateView as never);
      const lines = [
        `Promotion authorization for ${params.reviewId} (verdict ${verdict}):`,
        `  allowed: ${auth.allowedActions.join(", ") || "(none)"}`,
        ...auth.deniedActions.map((d) => `  denied ${d.action}: ${d.reason}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: auth };
    } catch (error) {
      return {
        content: [{ type: "text", text: `promote_analysis failed: ${String(error)}` }],
        details: { error: String(error) },
      };
    }
  },
};
