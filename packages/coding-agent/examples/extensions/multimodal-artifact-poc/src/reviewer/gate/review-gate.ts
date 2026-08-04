/**
 * ReviewGate — deterministic risk-tiered trigger for the reviewer.
 *
 * Not every change needs the full reviewer. The gate maps a risk score +
 * hard triggers to a ReviewMode; callers derive the score from change
 * metadata and use the mode to configure the runners:
 *
 *   NONE               -> no review
 *   DETERMINISTIC_ONLY -> hash/schema/typecheck/tests/replay only, no LLM
 *   STANDARD           -> deterministic checks + one semantic review
 *   STRICT             -> full: shadow tests, semantic, replay, independent
 *                         KPI verification
 *
 * Deterministic checks ALWAYS run first and short-circuit: a failed
 * deterministic check must never spend LLM tokens on an already-broken
 * proposal.
 */
export type ReviewMode = "NONE" | "DETERMINISTIC_ONLY" | "STANDARD" | "STRICT";

export interface ReviewRiskScore {
  /** 0-3: blast radius (single file -> cross-module/production). */
  impact: number;
  /** 0-3: higher = harder to roll back. */
  reversibility: number;
  /** 0-3: structural complexity. */
  complexity: number;
  /** 0-3: uncertainty (weak tests, fuzzy requirements). */
  uncertainty: number;
  /** 0-3: agent autonomy in producing the change. */
  autonomy: number;
}

export type HardTrigger =
  | "CREDENTIALS"              // auth, keys, secrets, sandbox, command exec
  | "PRODUCTION_WRITE"         // writes, migrations, rollback, CI/CD, auto publish
  | "DATA_DELETE_OR_MIGRATION" // deletes / schema migration
  | "EXTERNAL_PUBLICATION"     // report/PPT for management, clients, public
  | "STATISTICAL_OR_PREDICTIVE"// statistical tests, correlation, prediction
  | "DATA_QUALITY_WARNING";    // quality warnings present

export interface ReviewGateInput {
  score: ReviewRiskScore;
  triggers: HardTrigger[];
}

/** Total score -> mode thresholds (0-3 NONE, 4-6 DET, 7-10 STANDARD, 11-15 STRICT). */
export function evaluateReviewGate(input: ReviewGateInput): ReviewMode {
  const total = Math.min(
    15,
    input.score.impact + input.score.reversibility +
      input.score.complexity + input.score.uncertainty + input.score.autonomy,
  );
  let mode: ReviewMode =
    total <= 3 ? "NONE"
      : total <= 6 ? "DETERMINISTIC_ONLY"
        : total <= 10 ? "STANDARD"
          : "STRICT";

  const t = new Set(input.triggers);
  if (t.has("CREDENTIALS") || t.has("PRODUCTION_WRITE") ||
      t.has("DATA_DELETE_OR_MIGRATION") || t.has("STATISTICAL_OR_PREDICTIVE")) {
    mode = "STRICT";
  } else if (t.has("EXTERNAL_PUBLICATION") && (mode === "NONE" || mode === "DETERMINISTIC_ONLY")) {
    // at least STANDARD; never downgrades STRICT
    mode = "STANDARD";
  } else if (t.has("DATA_QUALITY_WARNING") && mode === "NONE") {
    mode = "DETERMINISTIC_ONLY";
  }
  return mode;
}

/** Budgets per mode; exceeding a budget must ABSTAIN, never truncate silently. */
export interface ReviewerBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxFiles: number;
  maxDiffLines: number;
  maxSemanticCalls: number;
}

export const MODE_BUDGETS: Record<ReviewMode, ReviewerBudget> = {
  NONE: { maxInputTokens: 0, maxOutputTokens: 0, maxFiles: 0, maxDiffLines: 0, maxSemanticCalls: 0 },
  DETERMINISTIC_ONLY: { maxInputTokens: 0, maxOutputTokens: 0, maxFiles: 64, maxDiffLines: 8_000, maxSemanticCalls: 0 },
  STANDARD: { maxInputTokens: 24_000, maxOutputTokens: 8_000, maxFiles: 16, maxDiffLines: 2_000, maxSemanticCalls: 1 },
  STRICT: { maxInputTokens: 64_000, maxOutputTokens: 16_000, maxFiles: 64, maxDiffLines: 8_000, maxSemanticCalls: 2 },
};

export interface RunnerModeFlags {
  semantic: boolean;
  shadow: boolean;
}

/** Maps a gate mode onto runner configuration (semantic/shadow enablement). */
export function runnerModeFlags(mode: ReviewMode): RunnerModeFlags {
  switch (mode) {
    case "NONE":
    case "DETERMINISTIC_ONLY":
      return { semantic: false, shadow: false };
    case "STANDARD":
      return { semantic: true, shadow: false };
    case "STRICT":
      return { semantic: true, shadow: true };
  }
}

/**
 * Path-based heuristic triggers: the caller may refine these, but the
 * heuristic guarantees high-risk paths are never silently downgraded.
 * A path hitting any rule maps to at least the listed trigger.
 */
const PATH_RULES: Array<{ pattern: RegExp; trigger: HardTrigger }> = [
  { pattern: /(auth|credential|secret|apikey|api-key|token|sandbox|password|permission|rbac)/i, trigger: "CREDENTIALS" },
  { pattern: /(write[-_]?gate|repository|event[-_]?store|write|insert|upsert|overwrite)/i, trigger: "PRODUCTION_WRITE" },
  { pattern: /(delete|drop|truncate|migrat|rollback|ddl)/i, trigger: "DATA_DELETE_OR_MIGRATION" },
  { pattern: /(pipeline|ci|cd|publish|release|deploy|merge)/i, trigger: "PRODUCTION_WRITE" },
  { pattern: /(statistic|correlation|regression|forecast|predict|hypothesis|ab[-_]?test|significance)/i, trigger: "STATISTICAL_OR_PREDICTIVE" },
];

export function inferTriggersFromPaths(paths: string[]): HardTrigger[] {
  const out = new Set<HardTrigger>();
  for (const p of paths) {
    for (const rule of PATH_RULES) {
      if (rule.pattern.test(p)) out.add(rule.trigger);
    }
  }
  return [...out];
}


// ---------------------------------------------------------------------------
// Orchestrator-enforced gate (Phase 11)
// ---------------------------------------------------------------------------

export type GateStage = "PREFLIGHT" | "FINAL";
export type GateSubjectType = "TASK" | "CODE_PROPOSAL" | "ANALYSIS_PROPOSAL";

export type PromotionRestriction =
  | "NO_MERGE"
  | "NO_EXTERNAL_PUBLICATION"
  | "NO_PRODUCTION_WRITE"
  | "NO_FORMAL_REPORT"
  | "NO_GOVERNANCE_APPROVAL";

export interface TriggerSource {
  trigger: HardTrigger;
  source: "PATH" | "DIFF" | "TOOL" | "TASK_INTENT";
  evidence: string;
}

/** Frozen gate decision artifact; its contentHash binds to reviewKey. */
export interface ReviewGateDecisionArtifact {
  schemaVersion: "1.0";
  gateDecisionId: string;
  stage: GateStage;
  subjectType: GateSubjectType;
  subjectId: string;
  subjectContentHash: string;
  profile: "CODE" | "ANALYSIS";
  scores: { impact: number; reversibility: number; complexity: number; uncertainty: number; autonomy: number; total: number };
  triggers: HardTrigger[];
  triggerSources: TriggerSource[];
  reviewMode: ReviewMode;
  deliveryMode: "NORMAL" | "EXPLORATORY_UNREVIEWED";
  restrictions: PromotionRestriction[];
  override?: {
    actor: string;
    reason: string;
    authority: "OPERATOR_CLI";
    requestedMode: ReviewMode;
  };
  requiredChecks: string[];
  budget: ReviewerBudget;
  policyVersion: string;
  contentHash: string;
  createdAt: string;
}

/** Only upgrades; a revision may never downgrade its review strength. */
export function maxMode(a: ReviewMode, b: ReviewMode): ReviewMode {
  const rank: Record<ReviewMode, number> = { NONE: 0, DETERMINISTIC_ONLY: 1, STANDARD: 2, STRICT: 3 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Explicit, non-LLM escape hatch. An ordinary agent may never downgrade:
 * the only supported override is an OPERATOR_CLI upgrade, or an explicit
 * EXPLORATORY_UNREVIEWED delivery mode that carries the documented
 * restrictions (no merge, no publish, no production write, no formal report).
 */
export interface ReviewModeOverride {
  requestedMode: ReviewMode;
  actor: string;
  reason: string;
  authority: "OPERATOR_CLI";
}

export type DeliveryMode = "NORMAL" | "EXPLORATORY_UNREVIEWED";

/** Trusted execution principal — injected by the host runtime, never by the LLM. */
export interface TrustedExecutionPrincipal {
  source: "OPERATOR_CLI" | "USER_UI" | "SYSTEM";
  actorId: string;
  authenticated: boolean;
}

export interface OverrideResult {
  mode: ReviewMode;
  deliveryMode: DeliveryMode;
  restrictions: PromotionRestriction[];
  override?: ReviewGateDecisionArtifact["override"];
  rejected?: string;
}

const EXPLORATORY_RESTRICTIONS: PromotionRestriction[] = [
  "NO_MERGE", "NO_EXTERNAL_PUBLICATION", "NO_PRODUCTION_WRITE",
  "NO_FORMAL_REPORT", "NO_GOVERNANCE_APPROVAL",
];

/**
 * Override rules:
 *  - EXPLORATORY_UNREVIEWED is honored ONLY from a trusted principal
 *    (OPERATOR_CLI / USER_UI, authenticated) — never from the LLM.
 *  - an OPERATOR_CLI override may only upgrade; anything else is rejected.
 */
export function applyOverride(
  gateMode: ReviewMode,
  principal: TrustedExecutionPrincipal,
  override?: ReviewModeOverride,
  deliveryMode: DeliveryMode = "NORMAL",
): OverrideResult {
  if (!principal.authenticated) {
    return { mode: gateMode, deliveryMode, restrictions: [], rejected: "unauthenticated principal" };
  }
  if (deliveryMode === "EXPLORATORY_UNREVIEWED") {
    if (principal.source !== "OPERATOR_CLI" && principal.source !== "USER_UI") {
      return { mode: gateMode, deliveryMode, restrictions: [], rejected: "EXPLORATORY_UNREVIEWED requires OPERATOR_CLI/USER_UI principal" };
    }
    return { mode: "NONE", deliveryMode, restrictions: EXPLORATORY_RESTRICTIONS };
  }
  if (!override) return { mode: gateMode, deliveryMode, restrictions: [] };
  if (override.authority !== "OPERATOR_CLI" || principal.source !== "OPERATOR_CLI") {
    return { mode: gateMode, deliveryMode, restrictions: [], rejected: "override requires a trusted OPERATOR_CLI principal" };
  }
  const mode = maxMode(gateMode, override.requestedMode);
  return {
    mode, deliveryMode, restrictions: [],
    override: { ...override },
  };
}

export class GateUnavailableError extends Error {}

export type PromotionAction =
  | "MERGE_CODE"
  | "PUBLISH_REPORT"
  | "PUBLISH_PRESENTATION"
  | "PRODUCTION_WRITE"
  | "REQUEST_HUMAN_APPROVAL"
  | "DELIVER_EXPLORATORY_RESULT";

export type PromotionVerdict = ReviewVerdictLike;

type ReviewVerdictLike = "PASS" | "CHANGES_REQUIRED" | "REJECT" | "ABSTAIN" | "UNREVIEWED_LOW_RISK";

export interface PromotionAuthorization {
  /** True only when at least one action is allowed (never an array). */
  allowed: boolean;
  allowedActions: PromotionAction[];
  deniedActions: Array<{ action: PromotionAction; reason: string }>;
}

export interface ActionAuthorization {
  allowed: boolean;
  reason?: string;
}

/** Deterministic per-action authorization. */
export function authorizeAction(
  action: PromotionAction,
  verdict: ReviewVerdictLike,
  gate: Pick<ReviewGateDecisionArtifact, "reviewMode" | "deliveryMode" | "restrictions">,
): ActionAuthorization {
  const auth = authorizePromotion(verdict, gate);
  if (auth.allowedActions.includes(action)) return { allowed: true };
  const denied = auth.deniedActions.find((d) => d.action === action);
  return { allowed: false, reason: denied?.reason ?? `${verdict} blocks ${action}` };
}

/**
 * Deterministic promotion guard: verdict + gate delivery mode decide what a
 * task may do next. EXPLORATORY_UNREVIEWED only permits exploratory delivery.
 */
export function authorizePromotion(
  verdict: ReviewVerdictLike,
  gate: Pick<ReviewGateDecisionArtifact, "reviewMode" | "deliveryMode" | "restrictions">,
): PromotionAuthorization {
  const allowed: PromotionAction[] = [];
  const deniedActions: PromotionAuthorization["deniedActions"] = [];
  const deny = (action: PromotionAction, reason: string) => deniedActions.push({ action, reason });
  const restriction = new Set(gate.restrictions);

  if (verdict === "PASS") {
    allowed.push("MERGE_CODE", "PUBLISH_REPORT", "PUBLISH_PRESENTATION", "REQUEST_HUMAN_APPROVAL");
  } else if (verdict === "UNREVIEWED_LOW_RISK" && gate.deliveryMode === "NORMAL") {
    allowed.push("MERGE_CODE", "REQUEST_HUMAN_APPROVAL");
    deny("PUBLISH_REPORT", "UNREVIEWED_LOW_RISK blocks formal publication");
    deny("PUBLISH_PRESENTATION", "UNREVIEWED_LOW_RISK blocks formal presentation");
    deny("PRODUCTION_WRITE", "UNREVIEWED_LOW_RISK blocks production writes");
  } else if (verdict === "UNREVIEWED_LOW_RISK" && gate.deliveryMode === "EXPLORATORY_UNREVIEWED") {
    allowed.push("DELIVER_EXPLORATORY_RESULT");
    deny("MERGE_CODE", "EXPLORATORY_UNREVIEWED blocks merge");
    deny("PUBLISH_REPORT", "EXPLORATORY_UNREVIEWED blocks formal publication");
    deny("PUBLISH_PRESENTATION", "EXPLORATORY_UNREVIEWED blocks formal presentation");
    deny("PRODUCTION_WRITE", "EXPLORATORY_UNREVIEWED blocks production writes");
    deny("REQUEST_HUMAN_APPROVAL", "EXPLORATORY_UNREVIEWED blocks governance approval");
  } else {
    // CHANGES_REQUIRED / REJECT / ABSTAIN
    deny("MERGE_CODE", `${verdict} blocks promotion`);
    deny("PUBLISH_REPORT", `${verdict} blocks promotion`);
    deny("PUBLISH_PRESENTATION", `${verdict} blocks promotion`);
    deny("PRODUCTION_WRITE", `${verdict} blocks promotion`);
    deny("REQUEST_HUMAN_APPROVAL", `${verdict} blocks promotion`);
  }
  if (restriction.has("NO_PRODUCTION_WRITE")) {
    const idx = allowed.indexOf("PRODUCTION_WRITE");
    if (idx >= 0) allowed.splice(idx, 1);
  }
  return {
    allowed: allowed.length > 0,
    allowedActions: allowed,
    deniedActions,
  };
}

/** Deterministic required checks per mode (profile-aware). */
export function requiredChecksFor(mode: ReviewMode, profile: "CODE" | "ANALYSIS"): string[] {
  if (profile === "CODE") {
    switch (mode) {
      case "NONE": return [];
      case "DETERMINISTIC_ONLY": return ["integrity", "execution"];
      case "STANDARD": return ["integrity", "execution", "semantic"];
      case "STRICT": return ["integrity", "execution", "shadow", "semantic"];
    }
  }
  switch (mode) {
    case "NONE": return [];
    case "DETERMINISTIC_ONLY": return ["integrity", "replay"];
    case "STANDARD": return ["integrity", "replay", "semantic"];
    case "STRICT": return ["integrity", "replay", "independent-verification", "semantic"];
  }
}

/** Deterministic diff-content signal (no LLM): classify touched paths + lines. */
export interface CodeGateMeta {
  changedPaths: string[];
  /** Optional raw diff text; when present, content patterns are classified. */
  diffContent?: string;
  diffLineCount: number;
  addedFileCount: number;
  deletedFileCount: number;
  toolCalls: string[];
  testsPassed: boolean;
  staticChecksPassed: boolean;
}

/**
 * Deterministic diff-content classification (no LLM): behavioral patterns in
 * added/removed lines. Snapshot/generated fixtures are NOT auto-promoted.
 */
const DIFF_WRITE_PATTERN = /\b(writeFile|appendFile|unlink|rm|mkdir|cp|mv|git push|deploy|publish|merge|approve)\b/i;
const DIFF_DELETE_PATTERN = /\b(DELETE FROM|DROP TABLE|TRUNCATE|unlink|rm)\b/i;
const DIFF_MUTATION_PATTERN = /\b(INSERT INTO|UPDATE|UPSERT|CREATE TABLE|ALTER TABLE)\b/i;

export interface CodeGateEvaluation {
  input: ReviewGateInput;
  triggerSources: TriggerSource[];
}

export function evaluateCodeProposalGate(meta: CodeGateMeta): CodeGateEvaluation {
  const triggerSources: TriggerSource[] = [];
  for (const t of inferTriggersFromPaths(meta.changedPaths)) {
    triggerSources.push({ trigger: t, source: "PATH", evidence: meta.changedPaths.join(", ") });
  }
  if (meta.diffContent) {
    const lines = meta.diffContent.split("\n").filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l));
    const text = lines.join("\n");
    if (DIFF_DELETE_PATTERN.test(text)) {
      triggerSources.push({ trigger: "DATA_DELETE_OR_MIGRATION", source: "DIFF", evidence: "delete/migration pattern in diff" });
    }
    if (DIFF_MUTATION_PATTERN.test(text)) {
      triggerSources.push({ trigger: "PRODUCTION_WRITE", source: "DIFF", evidence: "write/mutation pattern in diff" });
    }
    if (DIFF_WRITE_PATTERN.test(text)) {
      triggerSources.push({ trigger: "PRODUCTION_WRITE", source: "DIFF", evidence: "write/exec pattern in diff" });
    }
  }
  const triggers = [...new Set(triggerSources.map((t) => t.trigger))];
  const unique = new Set(meta.changedPaths);
  const impact = unique.size >= 5 ? 3 : unique.size >= 2 ? 2 : unique.size >= 1 ? 1 : 0;
  const complexity = meta.diffLineCount > 800 ? 3 : meta.diffLineCount > 200 ? 2 : meta.diffLineCount > 30 ? 1 : 0;
  const uncertainty = !meta.testsPassed ? 2 : !meta.staticChecksPassed ? 1 : 0;
  const autonomy = meta.toolCalls.includes("write") || meta.toolCalls.includes("bash") ? 2 : 1;
  return {
    input: {
      score: {
        impact,
        reversibility: impact >= 2 ? 2 : 1,
        complexity,
        uncertainty,
        autonomy,
      },
      triggers,
    },
    triggerSources,
  };
}

export interface AnalysisGateMeta {
  analysisType: string;
  methods: string[];
  forExternalPublication: boolean;
  dataQualityWarnings: number;
  usesStatisticalTests: boolean;
  usesPrediction: boolean;
  metricCount: number;
  inputArtifactCount: number;
}

export function evaluateAnalysisProposalGate(meta: AnalysisGateMeta): ReviewGateInput {
  const triggers: HardTrigger[] = [];
  if (meta.usesStatisticalTests || meta.usesPrediction) triggers.push("STATISTICAL_OR_PREDICTIVE");
  if (meta.forExternalPublication) triggers.push("EXTERNAL_PUBLICATION");
  if (meta.dataQualityWarnings > 0) triggers.push("DATA_QUALITY_WARNING");
  return {
    score: {
      impact: meta.forExternalPublication ? 3 : meta.metricCount >= 3 ? 2 : 1,
      reversibility: meta.forExternalPublication ? 3 : 1,
      complexity: meta.methods.length >= 3 ? 2 : meta.methods.length >= 1 ? 1 : 0,
      uncertainty: meta.dataQualityWarnings >= 2 ? 2 : meta.dataQualityWarnings > 0 ? 1 : 0,
      autonomy: 1,
    },
    triggers,
  };
}

/** Exceeds any budget bound -> true (caller must ABSTAIN, never truncate). */
export function exceedsBudget(budget: ReviewerBudget, meta: { files: number; diffLines: number; inputTokens: number }): boolean {
  if (budget.maxFiles > 0 && meta.files > budget.maxFiles) return true;
  if (budget.maxDiffLines > 0 && meta.diffLines > budget.maxDiffLines) return true;
  if (budget.maxInputTokens > 0 && meta.inputTokens > budget.maxInputTokens) return true;
  return false;
}
