/**
 * Graph Engine — Reviewer adapters (REAL evidence only, no synthetic data).
 *
 *   sys.review-gate   -> freezes the gate decision for the REAL proposal
 *                        (exact gateDecisionId in the gate-decision ref)
 *   sys.reviewer      -> consumes the EXACT gate decision ref + the real
 *                        analysis evidence refs -> executeReviewWithEvidence
 *   sys.promotion-auth-> authorizeAction(PUBLISH_REPORT) on the persisted
 *                        ReviewDecisionArtifact + REAL gate artifact
 *
 * Missing/unverifiable evidence -> ReviewEvidenceError -> the adapter fails
 * with HASH_MISMATCH / ARTIFACT_MISSING (graph maps it to ABSTAIN/fail-closed).
 * NO manifest/script/plan substitutes are ever generated.
 *
 * Promotion authorization combines (1) the machine verdict, (2) the REAL
 * persisted gate decision artifact (read by key from the reviewer store,
 * content-hash verified — never scanned, never guessed), and (3) for ABSTAIN,
 * a permission-controlled human review decision (an APPROVED operator
 * resolution on the pending human action), whose allowedActions are checked
 * before PUBLISH_REPORT is authorized.
 */
import { contentHash } from "../canonical.ts";
import type { ArtifactRef } from "../contracts.ts";
import { GraphError } from "../errors.ts";
import type { AdapterContext, AdapterResult, GraphNodeAdapter } from "./types.ts";
import {
  executeReviewWithEvidence,
  ReviewEvidenceError,
  type AnalysisEvidenceRefs,
  type ArtifactStoreLike,
  type ReviewIndexEntry,
} from "./review-execution.ts";
import { ReviewerStore, canonicalHash } from "../../reviewer/store.ts";

export interface ReviewerEvidenceResolver {
  /** Resolves an artifact id from the trusted store into evidence refs. */
  resolveEvidence(artifactId: string): Promise<AnalysisEvidenceRefs | null>;
}

/** Deterministic category -> reason code mapping (as before). */
const CATEGORY_TO_REASON: Array<[RegExp, string]> = [
  [/requirement|goal|ambiguity/i, "REQUIREMENT"],
  [/input|artifact|schema|quality|snapshot|masking|lineage/i, "QUALITY"],
  [/method|calculation|script|replay|kpi|result/i, "METHOD"],
  [/report|presentation|provenance|qa/i, "REPORT_QA"],
  [/permission|budget|policy|evidence/i, "BUDGET"],
];

interface ReviewFindingView {
  category: string;
  claim: string;
  suggestedAction: string;
}

async function reviewFindingsFromDecision(storeRoot: string, reviewId: string): Promise<ReviewFindingView[]> {
  try {
    const { readdirSync, readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const reviewsRoot = join(storeRoot, "reviews");
    for (const keyDir of readdirSync(reviewsRoot)) {
      const pointerPath = join(reviewsRoot, keyDir, "terminal-pointer.json");
      if (!existsSync(pointerPath)) continue;
      const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { attemptId?: string };
      const decisionPath = join(reviewsRoot, keyDir, "attempts", pointer.attemptId ?? "", "decision.json");
      if (!existsSync(decisionPath)) continue;
      const d = JSON.parse(readFileSync(decisionPath, "utf8")) as {
        reviewId?: string;
        blockingFindings?: Array<{ category?: string; claim?: string; suggestedAction?: string }>;
      };
      if (d.reviewId !== reviewId) continue;
      return (d.blockingFindings ?? []).map((f) => ({
        category: f.category ?? "",
        claim: f.claim ?? "",
        suggestedAction: f.suggestedAction ?? "",
      })).filter((f) => f.claim.length > 0);
    }
  } catch {
    // verdict-only
  }
  return [];
}

async function reasonCodesFromDecision(storeRoot: string, reviewId: string): Promise<string[]> {
  const findings = await reviewFindingsFromDecision(storeRoot, reviewId);
  const codes = new Set<string>();
  for (const f of findings) {
    const cat = f.category ?? "";
    for (const [pattern, code] of CATEGORY_TO_REASON) {
      if (pattern.test(cat)) { codes.add(code); break; }
    }
  }
  return [...codes];
}

/** gate-plan adapter deps. */
export interface ReviewGateAdapterDeps {
  storeRoot: string;
  resolveEvidence: ReviewerEvidenceResolver["resolveEvidence"];
  artifactStore?: ArtifactStoreLike;
}

/** review-execute adapter deps. */
export interface ReviewerAdapterDeps extends ReviewGateAdapterDeps {
  semanticReviewer?: (digest: unknown) => Promise<unknown[]>;
}

/** graph.review.plan — real gate decision for the real proposal.
 *  Idempotent per node operation key: a previously frozen gate is reused. */
export function reviewGateAdapter(deps: ReviewGateAdapterDeps): GraphNodeAdapter {
  return {
    capabilityId: "graph.review.plan",
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      // the analysis-result ref (from the fan-in / analysis node) carries the
      // artifact id that resolves the full evidence set
      const resultRef = ctx.inputRefs.find((r) => r.artifactType === "analysis-result")
        ?? ctx.inputRefs.find((r) => r.artifactType === "proposal");
      if (!resultRef) {
        throw new GraphError("ARTIFACT_MISSING", "review gate requires the analysis result ref", { retryable: false });
      }
      const evidence = await deps.resolveEvidence(resultRef.artifactId);
      if (!evidence) {
        throw new GraphError("HASH_MISMATCH", "review gate: real evidence not resolvable (ABSTAIN)", { retryable: false });
      }
      const { buildProposalFromEvidence, ReviewEvidenceError } = await import("./review-execution.ts");
      let store: Awaited<ReturnType<typeof buildProposalFromEvidence>>["store"];
      let orch: Awaited<ReturnType<typeof buildProposalFromEvidence>>["orch"];
      let proposal: Awaited<ReturnType<typeof buildProposalFromEvidence>>["proposal"];
      try {
        ({ store, orch, proposal } = await buildProposalFromEvidence(evidence, {
          storeRoot: deps.storeRoot,
          proposalId: `analysis-${resultRef.artifactId}`,
          artifactStore: deps.artifactStore,
        }));
      } catch (error) {
        if (error instanceof ReviewEvidenceError) {
          throw new GraphError("HASH_MISMATCH", `review gate evidence failed: ${error.message}`, { retryable: false });
        }
        throw error;
      }
      // gate IDEMPOTENCY: the operation key (runId/nodeId — stable across
      // attempts) pins ONE gate decision per node operation PER GRAPH
      // VERSION — a feedback revision bumps the version and re-plans the
      // gate for the new proposal
      const gateIndexKey = `graph-gate-index/${ctx.idempotencyKey}/v${ctx.graphVersion}`;
      // DETERMINISTIC gate id from the operation key + proposal: the SAME
      // operation always targets the SAME gate — a crash between gate write
      // and claim completion can never yield a second gate (get-or-create)
      const gateDecisionId = `final_${contentHash({ op: ctx.idempotencyKey, v: ctx.graphVersion, proposal: proposal.proposalId }).slice(0, 12)}`;
      let gateContentHash: string;
      const existing = await store.read<{ gateDecisionId?: string; contentHash?: string }>(gateIndexKey);
      if (existing && existing.content.gateDecisionId) {
        gateContentHash = existing.content.contentHash ?? "";
        // get-or-create: the gate may already exist even if the claim was
        // never completed (crash window) — reuse it
        const gateRec = await store.read<{ contentHash: string }>(`gate/${gateDecisionId}.json`);
        if (gateRec) gateContentHash = gateRec.content.contentHash;
      } else {
        if (!existing) {
          // claim FIRST with the deterministic id (atomic no-clobber): a
          // crash between the claim and the plan still pins THE gate id
          await store.writeImmutable(gateIndexKey, { status: "PENDING", gateDecisionId });
        }
        // get-or-create: planReview on a deterministic id is idempotent —
        // the second writer hits the immutable gate artifact and reuses it
        let gate: { gateDecisionId: string; contentHash: string };
        const gateRec = await store.read<{ gateDecisionId: string; contentHash: string }>(`gate/${gateDecisionId}.json`);
        if (gateRec) {
          gate = gateRec.content;
        } else {
          gate = await orch.planReview({
            stage: "FINAL", subjectType: "ANALYSIS_PROPOSAL",
            subjectId: proposal.proposalId, subjectContentHash: proposal.contentHash,
            profile: "ANALYSIS",
            userReviewPreference: "STANDARD",
            gateDecisionId,
            analysisMeta: {
              analysisType: "data-analysis", methods: [], forExternalPublication: false,
              dataQualityWarnings: 0, usesStatisticalTests: false, usesPrediction: false,
              metricCount: 0, inputArtifactCount: evidence.inputArtifactRefs.length,
            },
          }, { source: "SYSTEM", actorId: "graph-executor", authenticated: true });
        }
        gateContentHash = gate.contentHash;
        // complete the claim: overwrite-capable (the PENDING claim is
        // replaced); a LATER attempt sees the completed id and reuses it
        await store.write(gateIndexKey, { status: "COMPLETED", gateDecisionId, contentHash: gateContentHash });
      }
      // the gate-decision ref carries the EXACT gateDecisionId + hash
      const gateRef: ArtifactRef = {
        artifactId: gateDecisionId,
        artifactType: "gate-decision",
        contentHash: gateContentHash,
        schemaVersion: "1.0",
        createdByNodeId: ctx.node.nodeId,
      };
      return {
        outputRefs: [gateRef, resultRef],
        summary: `gate mode bound to ${gateDecisionId}`,
      };
    },
  };
}

/** graph.review.execute — execute with the EXACT gate decision + real evidence. */
export function reviewerAdapter(deps: ReviewerAdapterDeps): GraphNodeAdapter {
  return {
    capabilityId: "graph.review.execute",
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      const gateRef = ctx.inputRefs.find((r) => r.artifactType === "gate-decision");
      const resultRef = ctx.inputRefs.find((r) => r.artifactType === "analysis-result");
      if (!gateRef || !resultRef) {
        throw new GraphError("ARTIFACT_MISSING", "reviewer requires the gate-decision + analysis-result refs", { retryable: false });
      }
      const evidence = await deps.resolveEvidence(resultRef.artifactId);
      if (!evidence) {
        throw new GraphError("HASH_MISMATCH", "reviewer: real evidence not resolvable (ABSTAIN)", { retryable: false });
      }
      try {
        const { decision, gate, decisionKey, decisionHash, proposalHash } = await executeReviewWithEvidence(evidence, {
          storeRoot: deps.storeRoot,
          proposalId: `analysis-${resultRef.artifactId}`,
          artifactStore: deps.artifactStore,
          semanticReviewer: deps.semanticReviewer,
          gateDecisionId: gateRef.artifactId, // EXACT id, never a scan
        });
        void proposalHash;
        // decisionRef hash = the REAL persisted decision content hash (the
        // promotion adapter verifies it against the stored decision)
        const decisionRef: ArtifactRef = {
          artifactId: decision.reviewId,
          artifactType: "review-decision",
          contentHash: decisionHash,
          schemaVersion: "1.0",
          createdByNodeId: ctx.node.nodeId,
        };
        const verdict = decision.verdict;
        const verdictRef: ArtifactRef = {
          artifactId: `verdict:${verdict.toLowerCase()}`,
          artifactType: "verdict",
          contentHash: contentHash({
            reviewId: decision.reviewId,
            decisionHash,
            gateHash: gate.contentHash,
            proposalHash,
            verdict,
          }),
          schemaVersion: "1.0",
          createdByNodeId: ctx.node.nodeId,
        };
        const reasonCodes = await reasonCodesFromDecision(deps.storeRoot, decision.reviewId);
        const findings = await reviewFindingsFromDecision(deps.storeRoot, decision.reviewId);
        // REAL finding refs (hash-bound): the revision artifact carries them
        // to the routed target — a revision is never a blind re-run
        const findingRefs = findings.map((f, i) => ({
          artifactId: `finding:${decision.reviewId}:${i}`,
          artifactType: "review-finding" as const,
          contentHash: contentHash(f),
          schemaVersion: "1.0",
          createdByNodeId: ctx.node.nodeId,
        }));
        return {
          outputRefs: [decisionRef, verdictRef, ...findingRefs],
          decisionRefs: [decisionRef],
          decision: {
            verdict: verdict as never,
            reviewDecisionRef: decisionRef,
            reasonCodes,
            findingRefs,
            // ABSTAIN: the exact binding the operator resolution artifact
            // must carry (the executor records it into the pending action)
            humanActionContext: verdict === "ABSTAIN" ? {
              reviewId: decision.reviewId,
              gateDecisionId: gate.gateDecisionId,
              policySnapshotHash: decision.policySnapshotHash ?? "",
            } : undefined,
          },
          summary: `verdict ${verdict} (${decisionKey})`,
        };
      } catch (error) {
        if (error instanceof ReviewEvidenceError || error instanceof GraphError) throw error;
        // eslint-disable-next-line no-console
        console.warn(`[graph-reviewer] failed: ${String(error instanceof Error ? (error as Error).message : error)}`);
        throw new GraphError("REVIEW_BLOCKED", `review failed: ${String(error instanceof Error ? (error as Error).message : error)}`, { retryable: false });
      }
    },
  };
}

/**
 * Human review decision — permission-controlled operator override consumed
 * by promotion when the machine verdict is ABSTAIN. The ref is created by
 * the executor from a REAL HUMAN_ACTION_RECORDED resolution event.
 */
export interface HumanReviewDecision {
  originalReviewId: string;
  action: "ACCEPT_RISK_FOR_REPORT" | "REQUEST_NEW_REVIEW";
  allowedActions: string[];
  principalRef: ArtifactRef;
  policyRef: ArtifactRef;
  contentHash: string;
}

/** Resolve + verify a human review decision ref against the run's event
 *  chain. The operator's EXPLICIT action is the source of truth: a generic
 *  APPROVED is NEVER upgraded to a publish authorization — the recorded
 *  action must be ACCEPT_RISK_FOR_REPORT and the recorded allowedActions
 *  must contain PUBLISH_REPORT. The review/gate/policy bindings of the
 *  resolution must match the run's own review. Returns null when the ref
 *  is absent; throws on a forged or insufficient resolution. */
export async function resolveHumanReviewDecision(
  ctx: AdapterContext,
  humanRef: ArtifactRef,
  originalReviewId: string,
  readEventChain: (runId: string) => Promise<Array<{ eventType: string; nodeId?: string; refs: ArtifactRef[]; meta: Record<string, string>; errorCode?: string }>>,
  gateDecisionId: string,
  policySnapshotHash: string,
): Promise<HumanReviewDecision | null> {
  const actionRef = humanRef.artifactId.replace(/^human-review:/, "");
  const events = await readEventChain(ctx.runId);
  const recorded = events.find((e) =>
    e.eventType === "HUMAN_ACTION_RECORDED" &&
    e.refs.some((r) => r.artifactId === actionRef));
  if (!recorded) {
    throw new GraphError("PROMOTION_DENIED", `human review decision ${humanRef.artifactId} has no recorded resolution`, { retryable: false });
  }
  const resolutionRef = recorded.refs.find((r) => r.artifactId === actionRef);
  if (!resolutionRef) {
    throw new GraphError("PROMOTION_DENIED", `human review resolution ref missing for ${actionRef}`, { retryable: false });
  }
  const resolution = recorded.meta["resolution"];
  if (resolution !== "APPROVED") {
    throw new GraphError("PROMOTION_DENIED", `human review resolution for ${actionRef} is ${resolution ?? "unknown"}`, { retryable: false });
  }
  // the EXPLICIT operator action — never inferred from the generic APPROVED
  const action = recorded.meta["action"];
  if (action !== "ACCEPT_RISK_FOR_REPORT") {
    throw new GraphError("PROMOTION_DENIED", `human review action '${action ?? "none"}' does not accept report risk (${actionRef})`, { retryable: false });
  }
  const allowedActions = (recorded.meta["allowedActions"] ?? "").split(",").map((a) => a.trim()).filter((a) => a.length > 0);
  if (!allowedActions.includes("PUBLISH_REPORT")) {
    throw new GraphError("PROMOTION_DENIED", `human review allowedActions ${allowedActions.join(",") || "(none)"} do not include PUBLISH_REPORT (${actionRef})`, { retryable: false });
  }
  if (recorded.meta["reasonCode"] !== "HUMAN_ACCEPT_RISK") {
    throw new GraphError("PROMOTION_DENIED", `human review reasonCode mismatch for ${actionRef}`, { retryable: false });
  }
  // bindings: the resolution must refer to the SAME review, gate, and policy
  // as the run's review-index
  if (recorded.meta["originalReviewId"] && recorded.meta["originalReviewId"] !== originalReviewId) {
    throw new GraphError("PROMOTION_DENIED", `human review resolution refers to review ${recorded.meta["originalReviewId"]}, not ${originalReviewId}`, { retryable: false });
  }
  if (!recorded.meta["gateDecisionId"] || recorded.meta["gateDecisionId"] !== gateDecisionId) {
    throw new GraphError("PROMOTION_DENIED", `human review resolution gate '${recorded.meta["gateDecisionId"] ?? "(empty)"}' does not match ${gateDecisionId}`, { retryable: false });
  }
  if (!recorded.meta["policySnapshotHash"]) {
    throw new GraphError("PROMOTION_DENIED", `human review resolution has no policySnapshotHash binding (${actionRef})`, { retryable: false });
  }
  // the human-review-decision ref must bind the SAME resolution hash
  if (humanRef.contentHash && humanRef.contentHash !== resolutionRef.contentHash) {
    throw new GraphError("PROMOTION_DENIED", `human review decision hash does not match the recorded resolution (${actionRef})`, { retryable: false });
  }
  // policy binding: the resolution's policySnapshotHash must equal the
  // review-index's real policy snapshot hash (never skipped via empty)
  if (!policySnapshotHash || recorded.meta["policySnapshotHash"] !== policySnapshotHash) {
    throw new GraphError("PROMOTION_DENIED", `human review policy hash '${recorded.meta["policySnapshotHash"] ?? "(empty)"}' does not match the review's ${policySnapshotHash || "(empty)"}`, { retryable: false });
  }
  const gateIndex = await readGatePolicyFor(ctx, readEventChain, events);
  return {
    originalReviewId,
    action: "ACCEPT_RISK_FOR_REPORT",
    allowedActions,
    principalRef: resolutionRef,
    policyRef: gateIndex.policyRef,
    contentHash: humanRef.contentHash,
  };
}

async function readGatePolicyFor(
  ctx: AdapterContext,
  readEventChain: (runId: string) => Promise<Array<{ eventType: string; nodeId?: string; refs: ArtifactRef[]; meta: Record<string, string>; errorCode?: string }>>,
  events: Array<{ eventType: string; nodeId?: string; refs: ArtifactRef[]; meta: Record<string, string>; errorCode?: string }>,
): Promise<{ policyRef: ArtifactRef }> {
  const review = events.find((e) => e.eventType === "REVIEW_COMPLETED" && e.refs.some((r) => r.artifactType === "review-decision"));
  const decisionRef = review?.refs.find((r) => r.artifactType === "review-decision");
  if (!decisionRef) throw new GraphError("PROMOTION_DENIED", "no review decision in event chain", { retryable: false });
  return {
    policyRef: {
      artifactId: `gate-policy:${decisionRef.artifactId}`,
      artifactType: "gate-policy",
      contentHash: decisionRef.contentHash,
      schemaVersion: "1.0",
      createdByNodeId: "graph-executor",
    },
  };
}

/** graph.review.authorize — REAL authorizeAction on the persisted decision
 *  + the REAL gate artifact (verified by key, never a directory scan). */
export function promotionAdapter(deps: {
  storeRoot: string;
  /** Optional: verify a human review decision against the run's event chain. */
  readEventChain?: (runId: string) => Promise<Array<{ eventType: string; nodeId?: string; refs: ArtifactRef[]; meta: Record<string, string>; errorCode?: string }>>;
}): GraphNodeAdapter {
  return {
    capabilityId: "graph.review.authorize",
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
      const decisionRef = ctx.inputRefs.find((r) => r.artifactType === "review-decision");
      if (!decisionRef) {
        throw new GraphError("ARTIFACT_MISSING", "authorization requires a review decision", { retryable: false });
      }
      const store = new ReviewerStore(deps.storeRoot);
      // 1) REVIEW-INDEX (written by executeReviewWithEvidence): the exact
      //    persisted decision key + hashes — NO directory scanning
      const index = await store.read<ReviewIndexEntry>(`graph-review-index/${decisionRef.artifactId}.json`);
      if (!index) {
        throw new GraphError("ARTIFACT_MISSING", `review index missing for ${decisionRef.artifactId}`, { retryable: false });
      }
      const idx = index.content;
      // 2) the decision ref hash must equal the frozen decision hash
      if (decisionRef.contentHash && decisionRef.contentHash !== idx.decisionHash) {
        throw new GraphError("PROMOTION_DENIED", `review decision ${decisionRef.artifactId} content hash mismatch`, { retryable: false });
      }
      // 3) read the REAL decision by key + verify its content hash
      const decisionRec = await store.read<Record<string, unknown>>(idx.decisionKey);
      if (!decisionRec) {
        throw new GraphError("ARTIFACT_MISSING", `review decision ${decisionRef.artifactId} not found at ${idx.decisionKey}`, { retryable: false });
      }
      const actualHash = canonicalHash(decisionRec.content);
      if (actualHash !== idx.decisionHash) {
        throw new GraphError("PROMOTION_DENIED", `review decision ${decisionRef.artifactId} was tampered (hash mismatch)`, { retryable: false });
      }
      const decision = decisionRec.content as {
        verdict?: string;
        reviewMode?: string;
        gateDecisionRef?: { artifactId?: string; contentHash?: string };
      };
      if (!decision.verdict) {
        throw new GraphError("ARTIFACT_MISSING", `review decision ${decisionRef.artifactId} has no verdict`, { retryable: false });
      }
      // 4) the REAL gate: read by the decision's gateDecisionRef, verify hash
      const gateKey = decision.gateDecisionRef?.artifactId;
      if (!gateKey) {
        throw new GraphError("PROMOTION_DENIED", `review decision ${decisionRef.artifactId} has no gate ref`, { retryable: false });
      }
      const gateRec = await store.read<{
        gateDecisionId?: string;
        reviewMode?: string;
        deliveryMode?: string;
        restrictions?: string[];
        contentHash?: string;
      }>(gateKey);
      if (!gateRec) {
        throw new GraphError("PROMOTION_DENIED", `gate decision ${gateKey} not found`, { retryable: false });
      }
      const gate = gateRec.content;
      const expectedGateHash = decision.gateDecisionRef?.contentHash ?? idx.gateHash;
      // the gate's content hash is VERIFIED against its actual body (the
      // artifact's own contentHash field is part of the stored object, so
      // the canonical body hash excludes it — a tampered artifact whose
      // contentHash field was left untouched is still caught)
      const { contentHash: _gateHashField, ...gateBody } = gate;
      const actualGateHash = canonicalHash(gateBody);
      if (gate.contentHash && actualGateHash !== gate.contentHash) {
        throw new GraphError("PROMOTION_DENIED", `gate decision ${gateKey} content hash mismatch (tampered)`, { retryable: false });
      }
      if (expectedGateHash && gate.contentHash && gate.contentHash !== expectedGateHash) {
        throw new GraphError("PROMOTION_DENIED", `gate decision ${gateKey} hash does not match the decision binding`, { retryable: false });
      }
      // 5) authorization = machine verdict + REAL gate policy
      if (idx.policySnapshotHash) {
        const policyRec = await store.read<Record<string, unknown>>(idx.policyRef);
        if (!policyRec) {
          throw new GraphError("PROMOTION_DENIED", `policy snapshot ${idx.policyRef} not found`, { retryable: false });
        }
        // the policy snapshot's own contentHash excludes itself from the
        // body hash — verify the BODY against the index binding
        const { contentHash: _pch, ...policyBody } = policyRec.content;
        if (canonicalHash(policyBody) !== idx.policySnapshotHash) {
          throw new GraphError("PROMOTION_DENIED", `policy snapshot ${idx.policyRef} hash mismatch`, { retryable: false });
        }
      }
      const { authorizeAction } = await import("../../reviewer/gate/review-gate.ts");
      const auth = authorizeAction("PUBLISH_REPORT", decision.verdict as never, {
        reviewMode: gate.reviewMode ?? decision.reviewMode ?? "STANDARD",
        deliveryMode: gate.deliveryMode ?? "NORMAL",
        restrictions: gate.restrictions ?? [],
      } as never);
      let allowed = auth.allowed;
      let reason = auth.reason ?? decision.verdict;
      // 6) ABSTAIN: permission-controlled human review decision required.
      // The ref is emitted by the executor onto the reviewer node on resume
      // (there is no ARTIFACT edge for it — it only exists on ABSTAIN
      // approval), so it is read from the reviewer node's outputs too
      const reviewerNodeId = ctx.inputRefs.find((r) => r.artifactType === "review-decision")?.createdByNodeId
        ?? "sys.reviewer";
      if (decision.verdict === "ABSTAIN") {
        const humanRef = ctx.inputRefs.find((r) => r.artifactType === "human-review-decision")
          ?? ctx.state.nodeRuns[reviewerNodeId]?.outputRefs.find((r) => r.artifactType === "human-review-decision");
        if (!humanRef) {
          throw new GraphError("PROMOTION_DENIED", "PUBLISH_REPORT denied: ABSTAIN requires an approved human review decision", { retryable: false });
        }
        if (!deps.readEventChain) {
          throw new GraphError("PROMOTION_DENIED", "PUBLISH_REPORT denied: human review verification unavailable", { retryable: false });
        }
        const human = await resolveHumanReviewDecision(ctx, humanRef, decisionRef.artifactId, deps.readEventChain, idx.gateDecisionId, idx.policySnapshotHash ?? "");
        if (human && !human.allowedActions.includes("PUBLISH_REPORT")) {
          throw new GraphError("PROMOTION_DENIED", "PUBLISH_REPORT denied: human decision does not allow it", { retryable: false });
        }
        if (human) {
          allowed = true;
          reason = "ABSTAIN + ACCEPT_RISK_FOR_REPORT (operator approved)";
        }
      }
      if (!allowed) {
        throw new GraphError("PROMOTION_DENIED", `PUBLISH_REPORT denied: ${reason}`, { retryable: false });
      }
      return {
        outputRefs: [{
          artifactId: `auth_${contentHash(`${ctx.runId}:${decisionRef.artifactId}`).slice(0, 12)}`,
          artifactType: "authorization",
          contentHash: contentHash({
            reviewId: decisionRef.artifactId,
            action: "PUBLISH_REPORT",
            allowed: true,
            gateHash: gate.contentHash ?? expectedGateHash,
            decisionHash: idx.decisionHash,
          }),
          schemaVersion: "1.0",
          createdByNodeId: ctx.node.nodeId,
        }],
        summary: "PUBLISH_REPORT authorized",
      };
    },
  };
}
