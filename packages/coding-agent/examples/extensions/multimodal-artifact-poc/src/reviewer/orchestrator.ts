/**
 * Reviewer orchestrator — the deterministic review core (Phase 1).
 *
 * Responsibilities (§1, §19, §20):
 *  - build review packages from a proposal + policy
 *  - per-review lock (not a global lock): one active worker per reviewKey
 *  - idempotency: same reviewKey returns the existing valid decision
 *  - stale review: a decision is saved only if the current proposal hash
 *    still matches the package it was built from
 *  - persist decisions with the full check/finding evidence
 */
import { ReviewerStore, ReviewerStoreError, canonicalHash } from "./store.ts";
import { buildPolicySnapshot } from "./policy.ts";
import { reduceReviewDecision } from "./decision-reducer.ts";
import {
  applyOverride,
  evaluateReviewGate,
  maxMode,
  evaluateAnalysisProposalGate,
  evaluateCodeProposalGate,
  exceedsBudget,
  GateUnavailableError,
  MODE_BUDGETS,
  requiredChecksFor,
  runnerModeFlags,
} from "./gate/review-gate.ts";
import type {
  AnalysisGateMeta,
  CodeGateMeta,
  DeliveryMode,
  GateStage,
  GateSubjectType,
  ReviewGateDecisionArtifact,
  ReviewMode,
  ReviewModeOverride,
  TriggerSource,
  TrustedExecutionPrincipal,
} from "./gate/review-gate.ts";
import type {
  ReviewCheckResult,
  ReviewDecisionArtifact,
  ReviewFinding,
  ReviewPackage,
  ReviewPolicySnapshot,
  ReviewProposalEnvelope,
  ReviewVerdict,
} from "./contracts/index.ts";
import { reviewKey } from "./contracts/index.ts";

export class StaleProposalError extends Error {}
export class ActiveReviewError extends Error {}
export class NotFoundError extends Error {}
export class AlreadyReviewedError extends Error {}

export interface PersistDecisionInput {
  proposalId: string;
  proposalVersion: number;
  reviewPackageId: string;
  profile: "CODE" | "ANALYSIS";
  runId: string;
  sessionId: string;
  model: string;
  reviewerVersion: string;
  checks: ReviewCheckResult[];
  findings: ReviewFinding[];
  reviewerTestManifestRef?: { artifactId: string; artifactType: string; contentHash: string };
  replayArtifactRef?: { artifactId: string; artifactType: string; contentHash: string };
  independentVerificationRef?: { artifactId: string; artifactType: string; contentHash: string };
}

/** Map a runner checkId onto its required capability name. */
function normalizeCheckCapability(checkId: string): string {
  if (checkId.startsWith("integrity:") || checkId.startsWith("analysis:artifact-") || checkId === "analysis:original-result") return "integrity";
  if (checkId.startsWith("exec:")) return checkId.startsWith("exec:shadow") ? "shadow" : "execution";
  if (checkId.startsWith("analysis:replay")) return "replay";
  if (checkId.startsWith("analysis:independent")) return "independent-verification";
  if (checkId.startsWith("semantic:") || checkId.startsWith("analysis:semantic")) return "semantic";
  return checkId.split(":")[0]!;
}

/**
 * Prove the gate's required checks actually ran. Missing capability ->
 * a required UNAVAILABLE check -> ABSTAIN (never a silent PASS).
 */
export function enforceRequiredChecks(
  gate: Pick<ReviewGateDecisionArtifact, "requiredChecks">,
  checks: ReviewCheckResult[],
): ReviewCheckResult[] {
  const present = new Set(checks.map((c) => normalizeCheckCapability(c.checkId)));
  const missing = gate.requiredChecks.filter((r) => !present.has(r));
  if (missing.length === 0) return checks;
  const now = new Date().toISOString();
  return [
    ...checks,
    {
      checkId: "gate:required-check-coverage",
      checkClass: "INTEGRITY",
      required: true,
      status: "UNAVAILABLE",
      summary: `Required checks missing: ${missing.join(", ")}`,
      evidenceRefs: [],
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      errorCode: "REQUIRED_CHECK_MISSING",
    } as ReviewCheckResult,
  ];
}

export class ReviewerOrchestrator {
  readonly store: ReviewerStore;
  readonly reviewerVersion: string;
  private _locks = new Map<string, Promise<unknown>>();

  constructor(store: ReviewerStore, reviewerVersion: string) {
    this.store = store;
    this.reviewerVersion = reviewerVersion;
  }

  // ---------------------------------------------------------------------
  // Package building
  // ---------------------------------------------------------------------

  async buildReviewPackage(
    proposal: ReviewProposalEnvelope,
    proposalPayload: Record<string, unknown>,
    profile: "CODE" | "ANALYSIS",
    reviewLevel: "STANDARD" | "STRICT",
    requiredChecks: string[],
    advisoryChecks: string[],
  ): Promise<ReviewPackage> {
    const policy = buildPolicySnapshot({
      policyVersion: "1.0",
      profile,
      reviewLevel,
      requiredChecks,
      advisoryChecks,
      severityRules: {},
    });
    return this._buildPackage(proposal, proposalPayload, policy);
  }

  private async _writeImmutableIdempotent(key: string, content: Record<string, unknown>): Promise<void> {
    try {
      await this.store.writeImmutable(key, content);
    } catch (error) {
      const existing = await this.store.read<Record<string, unknown>>(key);
      if (!existing || canonicalHash(existing.content) !== canonicalHash(content)) {
        throw error;
      }
    }
  }

  private async _buildPackage(
    proposal: ReviewProposalEnvelope,
    proposalPayload: Record<string, unknown>,
    policy: ReviewPolicySnapshot,
  ): Promise<ReviewPackage> {
    if (canonicalHash(proposalPayload) !== proposal.contentHash) {
      throw new ReviewerStoreError(
        "proposal content hash mismatch: payload does not match the envelope",
      );
    }
    const pkg: ReviewPackage = {
      schemaVersion: "1.0",
      // deterministic package identity + createdAt (freezing the same
      // proposal twice is idempotent)
      reviewPackageId: `rp_${proposal.proposalId.slice(0, 12)}`,
      proposalId: proposal.proposalId,
      proposalVersion: proposal.proposalVersion,
      proposalContentHash: proposal.contentHash,
      proposalRef: {
        artifactId: `proposals/${proposal.proposalId}/v${proposal.proposalVersion}/proposal.json`,
        artifactType: "review-proposal",
        contentHash: proposal.contentHash,
      },
      safeContextRef: {
        artifactId: `packages/${proposal.proposalId}-v${proposal.proposalVersion}/safe-context.json`,
        artifactType: "review-safe-context",
        contentHash: "",
      },
      policySnapshot: policy,
      validationRefs: proposal.validationRefs,
      requirementRefs: proposal.requirementRefs,
      packageContentHash: "",
      createdAt: new Date(parseInt(proposal.contentHash.slice(0, 10), 16) * 1000).toISOString(),
    };
    // persist the safe-context so its ref carries a REAL content hash
    // (idempotent: identical content is a no-op, differing content fails)
    await this._writeImmutableIdempotent(
      `packages/${proposal.proposalId}-v${proposal.proposalVersion}/safe-context.json`,
      { proposalId: proposal.proposalId, proposalVersion: proposal.proposalVersion,
        proposalContentHash: proposal.contentHash, createdAt: pkg.createdAt });
    const ctx = await this.store.read(
      `packages/${proposal.proposalId}-v${proposal.proposalVersion}/safe-context.json`);
    if (!ctx) throw new ReviewerStoreError("safe-context persistence failed");
    pkg.safeContextRef.contentHash = ctx.hash;
    const { packageContentHash: _omit, ...body } = pkg;
    pkg.packageContentHash = canonicalHash(body);
    return pkg;
  }

  // ---------------------------------------------------------------------
  // Review execution (lock + idempotency + stale)
  // ---------------------------------------------------------------------

  /** Run a review for a package, keyed by reviewKey for idempotency. */
  async runReview(
    pkg: ReviewPackage,
    policySnapshotHash: string,
    checkProvider: (pkg: ReviewPackage) => Promise<{
      checks: ReviewCheckResult[];
      findings: ReviewFinding[];
      reviewerTestManifestRef?: PersistDecisionInput["reviewerTestManifestRef"];
      replayArtifactRef?: PersistDecisionInput["replayArtifactRef"];
      independentVerificationRef?: PersistDecisionInput["independentVerificationRef"];
    }>,
    input: {
      runId: string;
      sessionId: string;
      model: string;
      profile: "CODE" | "ANALYSIS";
      /** Frozen gate decision (orchestrator-enforced). */
      gateDecision: ReviewGateDecisionArtifact;
    },
  ): Promise<ReviewDecisionArtifact> {
    // P0 hardening: re-verify the package is un-tampered before running
    const { packageContentHash: _omit, ...body } = pkg;
    if (canonicalHash(body) !== pkg.packageContentHash) {
      throw new ReviewerStoreError("PACKAGE_TAMPERED: review package hash mismatch");
    }
    if (policySnapshotHash !== pkg.policySnapshot.contentHash) {
      throw new ReviewerStoreError("POLICY_HASH_MISMATCH: supplied policy hash != package policy snapshot");
    }
    if (!pkg.safeContextRef.contentHash) {
      throw new ReviewerStoreError("SAFE_CONTEXT_UNHASHED: safeContextRef.contentHash must not be empty");
    }
    // re-verify the gate decision from the store (tamper / subject / stage /
    // profile) before anything runs — the caller cannot self-certify
    const gate = await this.verifyGateDecision(pkg, input.gateDecision, input.profile);
    const key = reviewKey({
      proposalContentHash: pkg.proposalContentHash,
      gateDecisionHash: input.gateDecision.contentHash,
      policySnapshotHash,
      reviewerVersion: this.reviewerVersion,
      reviewLevel: pkg.policySnapshot.reviewLevel,
    });

    // idempotency: return existing terminal decision for this reviewKey
    const existing = await this._findDecision(key);
    if (existing) {
      return existing;
    }

    // per-review lock: one active worker per key
    const prev = this._locks.get(key);
    const run = (prev ?? Promise.resolve()).then(async () => {
      const again = await this._findDecision(key);
      if (again) return again;
      // NONE mode: no reviewer run at all; the gate decision itself is the
      // record. Never labelled PASS — it is UNREVIEWED_LOW_RISK.
      if (gate.reviewMode === "NONE") {
        const decision = this._assembleDecision(key, pkg, policySnapshotHash,
          "UNREVIEWED_LOW_RISK",
          { checks: [], findings: [] }, input);
        await this.persistDecision(key, decision, [], []);
        return decision;
      }
      const out = await checkProvider(pkg);
      // required-check coverage: a gate saying STRICT with no shadow check
      // executed must degrade to ABSTAIN, never PASS
      const enforced = enforceRequiredChecks(gate, out.checks);
      const effectiveOut = { ...out, checks: enforced };
      const verdict = reduceReviewDecision({ checks: effectiveOut.checks, findings: effectiveOut.findings });
      // stale guard: proposal must be unchanged since the package was built
      const current = await this.store.read<Record<string, unknown>>(
        `proposals/${pkg.proposalId}/v${pkg.proposalVersion}/proposal.json`,
      );
      if (!current) {
        throw new NotFoundError(`proposal ${pkg.proposalId}@v${pkg.proposalVersion} missing`);
      }
      // stale guard: the CURRENT payload hash must equal the hash the package
      // was built from; any mutation of the frozen proposal invalidates it
      if (current.hash !== pkg.proposalContentHash) {
        throw new StaleProposalError(
          `STALE_PROPOSAL: proposal hash changed since package built — refusing to persist`,
        );
      }
      const decision = this._assembleDecision(key, pkg, policySnapshotHash, verdict, effectiveOut, input);
      try {
        await this.persistDecision(key, decision, effectiveOut.checks, effectiveOut.findings);
      } catch (e) {
        if (e instanceof AlreadyReviewedError) {
          const winner = await this._findDecision(key);
          if (winner) return winner;
        }
        throw e;
      }
      return decision;
    });
    this._locks.set(key, run);
    try {
      return await run;
    } finally {
      this._locks.delete(key);
    }
  }

  /**
   * Re-verify a gate decision from the store. The caller cannot self-certify:
   * the artifact must exist, hash-clean, FINAL, bound to this proposal, and
   * match the expected profile.
   */
  async verifyGateDecision(
    pkg: ReviewPackage,
    supplied: ReviewGateDecisionArtifact,
    expectedProfile: "CODE" | "ANALYSIS",
  ): Promise<ReviewGateDecisionArtifact> {
    const stored = await this.store.read<ReviewGateDecisionArtifact>(
      `gate/${supplied.gateDecisionId}.json`,
    );
    if (!stored) {
      throw new GateUnavailableError("GATE_DECISION_MISSING");
    }
    const s = stored.content;
    const { contentHash: _c, ...body } = s;
    if (canonicalHash(body) !== s.contentHash) {
      throw new GateUnavailableError("GATE_DECISION_TAMPERED");
    }
    if (s.contentHash !== supplied.contentHash) {
      throw new GateUnavailableError("GATE_DECISION_HASH_MISMATCH");
    }
    if (s.stage !== "FINAL") {
      throw new GateUnavailableError("FINAL_GATE_REQUIRED");
    }
    if (s.subjectId !== pkg.proposalId || s.subjectContentHash !== pkg.proposalContentHash) {
      throw new GateUnavailableError("GATE_SUBJECT_MISMATCH");
    }
    if (s.profile !== expectedProfile) {
      throw new GateUnavailableError("GATE_PROFILE_MISMATCH");
    }
    return s;
  }

  /**
   * The single governed review entry point for the main flow. The main agent
   * submits a task/proposal; the orchestrator loads the FINAL gate decision
   * by id, maps the mode onto the runner (semantic/shadow/independent
   * verification), enforces required-check coverage, and runs the review.
   */
  async executePlannedReview(input: {
    pkg: ReviewPackage;
    gateDecisionId: string;
    profile: "CODE" | "ANALYSIS";
    runId: string;
    sessionId: string;
    model: string;
    codeInput?: {
      snapshotWorkspace: string;
      testWorkspace: string;
      /** Central-allowlist check ids (resolved via REVIEW_CHECK_REGISTRY). */
      checkIds: string[];
      semanticReviewer?: (context: unknown) => Promise<Array<{ severity: ReviewFinding["severity"]; category: string; claim: string; evidenceRefIds: string[]; suggestedAction: string; location?: { file?: string; lineStart?: number; lineEnd?: number } }>>;
    };
    analysisInput?: {
      replayRunner: (proposal: unknown, workspaceRoot: string) => Promise<unknown>;
      verificationCases: unknown[];
      sectionsMeta?: Array<{ sectionId: string }>;
      semanticReviewer?: (digest: unknown) => Promise<unknown[]>;
    };
  }): Promise<ReviewDecisionArtifact> {
    const stored = await this.store.read<ReviewGateDecisionArtifact>(
      `gate/${input.gateDecisionId}.json`,
    );
    if (!stored) throw new GateUnavailableError("GATE_DECISION_MISSING");
    const gate = stored.content;
    // runReview re-verifies; but we already know it is store-loaded and FINAL
    if (gate.stage !== "FINAL") throw new GateUnavailableError("FINAL_GATE_REQUIRED");
    if (gate.profile !== input.profile) throw new GateUnavailableError("GATE_PROFILE_MISMATCH");
    const flags = runnerModeFlags(gate.reviewMode);

    // NONE: no runner at all; runReview records UNREVIEWED_LOW_RISK
    if (gate.reviewMode === "NONE") {
      return this.runReview(input.pkg, input.pkg.policySnapshot.contentHash,
        async () => ({ checks: [], findings: [] }),
        { runId: input.runId, sessionId: input.sessionId, model: input.model, profile: input.profile, gateDecision: gate });
    }

    // FULL gate verification happens BEFORE any runner executes: a forged or
    // mis-bound gate can never start shadow tests or an LLM call.
    await this.verifyGateDecision(input.pkg, gate, input.profile);
    // load the real typed proposal from the store (never a ref stub)
    const proposalRecord = await this.store.read<Record<string, unknown>>(
      input.pkg.proposalRef.artifactId,
    );
    if (!proposalRecord || proposalRecord.hash !== input.pkg.proposalContentHash) {
      throw new ReviewerStoreError("PROPOSAL_MISSING_OR_TAMPERED: proposal artifact missing or hash mismatch");
    }
    const proposal = proposalRecord.content;

    const { CodeReviewRunner } = await import("./code/review-runner.ts");
    const { AnalysisReviewRunner } = await import("./analysis/review-runner.ts");
    const out = input.profile === "CODE"
      ? await new CodeReviewRunner(this.store).run({
          proposal: proposal as never,
          snapshotWorkspace: input.codeInput!.snapshotWorkspace,
          testWorkspace: input.codeInput!.testWorkspace,
          checkIds: input.codeInput!.checkIds,
          requiredCapabilities: gate.requiredChecks,
          budget: gate.budget,
          semanticReviewer: flags.semantic ? input.codeInput!.semanticReviewer as never : undefined,
          shadowTestsEnabled: flags.shadow,
        })
      : await new AnalysisReviewRunner(this.store).run({
          proposal: proposal as never,
          objective: "analysis review",
          replayRunner: input.analysisInput!.replayRunner as never,
          verificationCases: input.analysisInput!.verificationCases as never,
          sectionsMeta: input.analysisInput!.sectionsMeta as never,
          requiredCapabilities: gate.requiredChecks,
          semanticReviewer: flags.semantic ? input.analysisInput!.semanticReviewer as never : undefined,
        });

    return this.runReview(input.pkg, input.pkg.policySnapshot.contentHash,
      async () => out,
      { runId: input.runId, sessionId: input.sessionId, model: input.model, profile: input.profile, gateDecision: gate });
  }

  /**
   * Orchestrator-enforced gate planning: evaluate (deterministic), freeze the
   * decision artifact, and return the mode the runner MUST execute. The main
   * agent never chooses the mode; it may only pass an OPERATOR_CLI override
   * (upgrades) or an explicit EXPLORATORY_UNREVIEWED delivery mode.
   */
  async planReview(
    input: {
      stage: GateStage;
      subjectType: GateSubjectType;
      subjectId: string;
      subjectContentHash: string;
      profile: "CODE" | "ANALYSIS";
      codeMeta?: CodeGateMeta;
      analysisMeta?: AnalysisGateMeta;
      preflightMode?: ReviewMode;         // effectiveMode = max(preflight, final)
      override?: ReviewModeOverride;
      deliveryMode?: DeliveryMode;
      /** user-level minimum (host records this, the LLM cannot) */
      userReviewPreference?: "DEFAULT" | "STANDARD" | "STRICT";
      /** Deterministic gate id (host-derived from the operation key): a
       *  get-or-create caller passes it so a crash can never produce a
       *  SECOND gate for the same operation. */
      gateDecisionId?: string;
    },
    principal: TrustedExecutionPrincipal,
  ): Promise<ReviewGateDecisionArtifact> {
    let gateMode: ReviewMode;
    let gateInput: ReturnType<typeof evaluateCodeProposalGate> | ReturnType<typeof evaluateAnalysisProposalGate>;
    let triggerSources: TriggerSource[] = [];
    if (input.profile === "CODE") {
      if (!input.codeMeta) throw new GateUnavailableError("GATE_UNAVAILABLE: code gate requires codeMeta");
      const ev = evaluateCodeProposalGate(input.codeMeta);
      gateInput = ev.input;
      triggerSources = ev.triggerSources;
    } else {
      if (!input.analysisMeta) throw new GateUnavailableError("GATE_UNAVAILABLE: analysis gate requires analysisMeta");
      gateInput = evaluateAnalysisProposalGate(input.analysisMeta);
      triggerSources = gateInput.triggers.map((t) => ({ trigger: t, source: "TASK_INTENT", evidence: "analysis metadata" }));
    }
    gateMode = evaluateReviewGate(gateInput);
    // only upgrades; revision of a STRICT proposal may never downgrade
    if (input.preflightMode) gateMode = maxMode(input.preflightMode, gateMode);
    // user-level minimum preference (host-sourced, not agent-sourced)
    if (input.userReviewPreference && input.userReviewPreference !== "DEFAULT") {
      gateMode = maxMode(gateMode, input.userReviewPreference);
    }
    const applied = applyOverride(gateMode, principal, input.override, input.deliveryMode);
    if (applied.rejected) {
      throw new GateUnavailableError(`GATE_OVERRIDE_REJECTED: ${applied.rejected}`);
    }
    const finalMode = applied.mode;
    const artifact: ReviewGateDecisionArtifact = {
      schemaVersion: "1.0",
      gateDecisionId: input.gateDecisionId ?? `${input.stage.toLowerCase()}_${cryptoRandom(12)}`,
      stage: input.stage,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectContentHash: input.subjectContentHash,
      profile: input.profile,
      scores: {
        ...gateInput.score,
        total: Math.min(15,
          gateInput.score.impact + gateInput.score.reversibility +
          gateInput.score.complexity + gateInput.score.uncertainty + gateInput.score.autonomy),
      },
      triggers: gateInput.triggers,
      triggerSources,
      reviewMode: finalMode,
      deliveryMode: applied.deliveryMode,
      restrictions: applied.restrictions,
      override: applied.override,
      requiredChecks: requiredChecksFor(finalMode, input.profile),
      budget: MODE_BUDGETS[finalMode],
      policyVersion: this.reviewerVersion,
      contentHash: "",
      createdAt: new Date().toISOString(),
    };
    const { contentHash: _omit, ...body } = artifact;
    artifact.contentHash = canonicalHash(body);
    const artifactId = `gate/${artifact.gateDecisionId}.json`;
    await this.store.writeImmutable(artifactId, artifact);
    await this.store.appendLedger({
      event: "gate.decision", gateDecisionId: artifact.gateDecisionId,
      stage: artifact.stage, mode: artifact.reviewMode,
      subjectId: artifact.subjectId, subjectHash: artifact.subjectContentHash,
    });
    return artifact;
  }

  private _assembleDecision(
    key: string,
    pkg: ReviewPackage,
    policySnapshotHash: string,
    verdict: ReviewVerdict,
    out: { checks: ReviewCheckResult[]; findings: ReviewFinding[] } & Pick<
      PersistDecisionInput,
      | "reviewerTestManifestRef" | "replayArtifactRef" | "independentVerificationRef"
    >,
    input: { runId: string; sessionId: string; model: string; profile: "CODE" | "ANALYSIS"; gateDecision: ReviewGateDecisionArtifact },
  ): ReviewDecisionArtifact {
    const blocking = out.findings.filter((f) => f.severity === "BLOCKER" || f.severity === "HIGH");
    const advisory = out.findings.filter((f) => f.severity !== "BLOCKER" && f.severity !== "HIGH");
    const decision: ReviewDecisionArtifact = {
      schemaVersion: "1.0",
      reviewId: `review_${key.slice(0, 12)}`,
      reviewAttempt: 1,
      reviewPackageId: pkg.reviewPackageId,
      reviewPackageContentHash: pkg.packageContentHash,
      proposalId: pkg.proposalId,
      proposalVersion: pkg.proposalVersion,
      proposalContentHash: pkg.proposalContentHash,
      reviewMode: input.gateDecision.reviewMode,
      gateDecisionRef: {
        artifactId: `gate/${input.gateDecision.gateDecisionId}.json`,
        contentHash: input.gateDecision.contentHash,
      },
      reviewer: {
        profile: input.profile,
        runId: input.runId,
        sessionId: input.sessionId,
        model: input.model,
        reviewerVersion: this.reviewerVersion,
      },
      verdict,
      blockingFindings: blocking,
      advisoryFindings: advisory,
      deterministicChecks: out.checks.filter((c) =>
        ["INTEGRITY", "SCHEMA", "NUMERIC", "REPLAY", "SECURITY"].includes(c.checkClass),
      ),
      executionChecks: out.checks.filter((c) =>
        ["EXECUTION", "TESTING", "REQUIREMENT"].includes(c.checkClass),
      ),
      semanticChecks: out.checks.filter((c) => c.checkClass === "SEMANTIC"),
      reviewerTestManifestRef: out.reviewerTestManifestRef,
      replayArtifactRef: out.replayArtifactRef,
      independentVerificationRef: out.independentVerificationRef,
      policySnapshotHash,
      confidence: 1.0,
      createdAt: new Date().toISOString(),
    };
    return decision;
  }

  private async persistDecision(
    key: string,
    decision: ReviewDecisionArtifact,
    checks: ReviewCheckResult[],
    findings: ReviewFinding[],
  ): Promise<void> {
    // P0 hardening — attempt isolation: each run writes into its own attempt
    // directory; a crash residue can never mix with a later attempt's
    // decision. The terminal-pointer.json is the atomic commit point:
    //   reviews/<key>/attempts/<attemptId>/{checks,findings,decision}.json
    //   reviews/<key>/terminal-pointer.json  (no-clobber, written last)
    const attemptId = cryptoRandom(10);
    const dir = `reviews/${key}/attempts/${attemptId}`;
    await this.store.writeImmutable(`${dir}/checks.json`, checks);
    await this.store.writeImmutable(`${dir}/findings.json`, findings);
    await this.store.writeImmutable(`${dir}/decision.json`, decision);
    // ABSTAIN is NOT terminal: it writes an attempt but never a terminal
    // pointer, so a later run creates a NEW attempt and can reach a verdict.
    // All other verdicts commit the atomic no-clobber terminal pointer
    // (UNREVIEWED_LOW_RISK included — it IS a terminal decision).
    if (decision.verdict === "ABSTAIN") {
      // ABSTAIN is NOT terminal: no terminal-pointer, but the latest attempt
      // marker lets an executor resolve the attempt decision by key
      await this.store.write(`reviews/${key}/abstain-latest.json`,
        { attemptId, reviewId: decision.reviewId, verdict: "ABSTAIN" });
      await this.store.appendLedger({
        event: "REVIEW_ATTEMPT_ABSTAINED",
        reviewKey: key, reviewId: decision.reviewId,
        proposalId: decision.proposalId, verdict: decision.verdict, at: decision.createdAt,
      });
      return;
    }
    // terminal pointer (no-clobber): the first writer wins; a crash before
    // this leaves no terminal decision (old pointer may still point at an
    // older valid attempt)
    try {
      await this.store.writeImmutable(`reviews/${key}/terminal-pointer.json`,
        { attemptId, decisionId: decision.reviewId, verdict: decision.verdict, at: decision.createdAt });
    } catch (err) {
      const winner = await this._findDecision(key);
      if (winner) throw new AlreadyReviewedError(key);
      throw err;
    }
    await this.store.appendLedger({
      event: "REVIEW_DECISION",
      reviewKey: key,
      reviewId: decision.reviewId,
      proposalId: decision.proposalId,
      proposalVersion: decision.proposalVersion,
      proposalContentHash: decision.proposalContentHash,
      verdict: decision.verdict,
      at: decision.createdAt,
    });
  }

  private async _findDecision(key: string): Promise<ReviewDecisionArtifact | null> {
    const pointer = await this.store.read<{ attemptId: string }>(
      `reviews/${key}/terminal-pointer.json`);
    if (!pointer) return null;
    const rec = await this.store.read<ReviewDecisionArtifact>(
      `reviews/${key}/attempts/${pointer.content.attemptId}/decision.json`);
    if (rec && ["PASS", "CHANGES_REQUIRED", "REJECT", "UNREVIEWED_LOW_RISK"].includes(rec.content.verdict)) {
      return rec.content;
    }
    return null;
  }
}

function cryptoRandom(len: number): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}
