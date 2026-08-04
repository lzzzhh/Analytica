/**
 * Reviewer execution with REAL evidence refs.
 *
 * This is the ONLY reviewer entry the graph uses:
 *
 *   analysisResultRef + executionManifestRef + scriptArtifactRef +
 *   analysisPlanRef + inputArtifactRefs + validationRefs   (REAL, from the
 *   trusted ArtifactStore, hash-verified copies)
 *        -> AnalysisProposal (frozen, refs bound to the stored objects)
 *        -> ReviewGate (planReview)
 *        -> executePlannedReview (the gate decision id is passed EXACTLY)
 *
 * Missing or unverifiable evidence -> ABSTAIN semantics (fail closed):
 * the function throws with EVIDENCE_MISSING; callers map it to an
 * ABSTAIN review. No synthetic manifest/script/plan is ever generated.
 *
 * Idempotency: freezing the same evidence twice produces the SAME proposal
 * (deterministic createdAt), and the review-index (reviewId -> decision key
 * + hashes) is written once; a second execution of the same proposal either
 * reuses the index or fails closed on a content difference.
 */
import { contentHash } from "../canonical.ts";
import { ReviewerStore, canonicalHash } from "../../reviewer/store.ts";
import { ReviewerOrchestrator } from "../../reviewer/orchestrator.ts";
import {
  reviewKey,
  type AnalysisProposal,
  type ArtifactRef,
  type ProposalProducerRole,
  type ReviewDecisionArtifact,
  type ReviewProposalEnvelope,
} from "../../reviewer/contracts/index.ts";

export class ReviewEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewEvidenceError";
  }
}

export interface AnalysisEvidenceRefs {
  analysisResultRef: ArtifactRef;
  analysisPlanRef: ArtifactRef;
  executionManifestRef: ArtifactRef;
  scriptArtifactRef: ArtifactRef;
  /** Trusted-store copy of the FULL input manifest the script ran against. */
  inputManifestRef?: ArtifactRef;
  inputArtifactRefs: ArtifactRef[];
  validationRefs: ArtifactRef[];
}

export interface AnalysisEvidenceContent {
  result: unknown;
  resultFrozenHash: string;
  plan: unknown;
  planFrozenHash: string;
  manifest: unknown;
  manifestFrozenHash: string;
  script: unknown;
  scriptFrozenHash: string;
  inputManifest: unknown;
  inputManifestFrozenHash: string;
}

export interface ArtifactStoreLike {
  resolveResult(artifactId: string): Promise<{ content: string; contentHash: string } | null>;
  readInputBytes?(artifactId: string): Buffer | null;
  getMeta?(artifactId: string): { contentType?: string; masked?: boolean; columns?: string[] } | null;
}

/** Frozen review-index entry: the EXACT persisted decision + gate binding.
 *  Promotion reads this (never a directory scan) to verify the decision
 *  content hash and load the REAL gate decision artifact. */
export interface ReviewIndexEntry {
  reviewId: string;
  proposalId: string;
  decisionKey: string;
  decisionHash: string;
  gateDecisionId: string;
  gateHash: string;
  proposalHash: string;
  verdict: string;
  /** Real policy-snapshot binding (persisted package policy artifact). */
  policySnapshotHash: string;
  policyRef: string;
  createdAt: string;
}

/** Map an AnalysisProposal into the shared ReviewProposalEnvelope. */
export function toReviewProposalEnvelope(proposal: AnalysisProposal): ReviewProposalEnvelope {
  return {
    schemaVersion: "1.0",
    proposalId: proposal.proposalId,
    proposalType: "ANALYSIS" as never,
    proposalVersion: proposal.proposalVersion,
    producer: {
      agentRole: "data-analysis" as ProposalProducerRole,
      runId: proposal.proposalId,
      sessionId: "graph-executor",
      producerVersion: "1.0.0",
    },
    subjectRefs: [
      proposal.analysisResultRef,
      proposal.analysisPlanRef,
      proposal.executionManifestRef,
      proposal.scriptArtifactRef,
      ...(proposal.inputManifestRef ? [proposal.inputManifestRef] : []),
      ...proposal.inputArtifactRefs,
    ],
    requirementRefs: proposal.validationRefs,
    validationRefs: proposal.validationRefs,
    contentHash: proposal.contentHash,
    policySnapshotHash: "",
    createdAt: proposal.createdAt,
  };
}

/** Idempotent immutable write: identical content is a no-op; anything else
 *  fails closed (a second freeze with DIFFERENT content is an integrity
 *  violation). */
async function writeImmutableIdempotent(store: ReviewerStore, key: string, content: unknown): Promise<string> {
  try {
    return await store.writeImmutable(key, content);
  } catch (error) {
    const existing = await store.read<unknown>(key);
    if (!existing || canonicalHash(existing.content) !== canonicalHash(content)) {
      throw error; // no-clobber: different content is an integrity violation
    }
    // identical content -> idempotent success (frozen hash is authoritative)
    return existing.hash;
  }
}

/** Copy REAL evidence from the trusted store into the reviewer store
 *  (hash-verified; a mismatch or a missing artifact fails closed). */
async function freezeEvidence(
  store: ReviewerStore,
  evidence: AnalysisEvidenceRefs,
  resolver: (ref: ArtifactRef) => Promise<{ content: unknown; contentHash: string } | null>,
  storeBytes?: (ref: ArtifactRef) => Promise<{ bytes: Buffer; hash: string } | null>,
): Promise<AnalysisEvidenceContent> {
  const read = async (ref: ArtifactRef, what: string): Promise<{ content: unknown; frozenHash: string }> => {
    const rec = await resolver(ref);
    if (!rec) throw new ReviewEvidenceError(`EVIDENCE_MISSING: ${what} (${ref.artifactId}) not resolvable`);
    if (ref.contentHash && rec.contentHash !== ref.contentHash) {
      throw new ReviewEvidenceError(`EVIDENCE_HASH_MISMATCH: ${what} (${ref.artifactId})`);
    }
    const frozenHash = await writeImmutableIdempotent(store, `artifacts/${ref.artifactId}.json`, rec.content);
    return { content: rec.content, frozenHash };
  };
  const inputManifest = evidence.inputManifestRef
    ? await read(evidence.inputManifestRef, "input-manifest")
    : null;
  // freeze the INPUT BYTES into the reviewer-owned store (binary, immutable,
  // hash-verified): replay reads ONLY these frozen copies — a later
  // re-registration of the same business artifact id can never change what
  // the reviewer replays (TOCTOU closed)
  if (evidence.inputArtifactRefs.length > 0 && !storeBytes) {
    throw new ReviewEvidenceError("INPUT_FREEZE_UNAVAILABLE: no binary store access for frozen inputs");
  }
  for (const ref of evidence.inputArtifactRefs) {
    const frozen = await storeBytes!(ref);
    if (!frozen) {
      throw new ReviewEvidenceError(`EVIDENCE_MISSING: input bytes (${ref.artifactId}) not resolvable`);
    }
    if (ref.contentHash && frozen.hash !== ref.contentHash) {
      throw new ReviewEvidenceError(`EVIDENCE_HASH_MISMATCH: input bytes (${ref.artifactId})`);
    }
  }
  const result = await read(evidence.analysisResultRef, "analysis-result");
  const plan = await read(evidence.analysisPlanRef, "analysis-plan");
  const manifest = await read(evidence.executionManifestRef, "execution-manifest");
  const script = await read(evidence.scriptArtifactRef, "analysis-script");
  return {
    result: result.content,
    resultFrozenHash: result.frozenHash,
    plan: plan.content,
    planFrozenHash: plan.frozenHash,
    manifest: manifest.content,
    manifestFrozenHash: manifest.frozenHash,
    script: script.content,
    scriptFrozenHash: script.frozenHash,
    inputManifest: inputManifest?.content ?? null,
    inputManifestFrozenHash: inputManifest?.frozenHash ?? "",
  };
}

/** Freeze a REAL evidence-backed AnalysisProposal + package. */
export async function buildProposalFromEvidence(
  evidence: AnalysisEvidenceRefs,
  opts: { storeRoot: string; proposalId: string; artifactStore?: ArtifactStoreLike },
): Promise<{
  store: ReviewerStore;
  orch: ReviewerOrchestrator;
  proposal: AnalysisProposal;
  payload: Record<string, unknown>;
  pkg: Awaited<ReturnType<ReviewerOrchestrator["buildReviewPackage"]>>;
}> {
  const store = new ReviewerStore(opts.storeRoot);
  const orch = new ReviewerOrchestrator(store, "1.0.0");
  // artifact store resolver: the trusted store where data analysis wrote results
  let artifactStore = opts.artifactStore as ArtifactStoreLike | null;
  if (!artifactStore) {
    const { ArtifactStore } = await import("../../data-analysis/artifact-store.ts");
    artifactStore = new ArtifactStore();
  }
  const resolver = async (ref: ArtifactRef): Promise<{ content: unknown; contentHash: string } | null> => {
    // results live in results/<id>.json
    const res = await artifactStore!.resolveResult(ref.artifactId);
    if (res) return { content: JSON.parse(res.content), contentHash: res.contentHash };
    return null;
  };
  // input bytes are frozen into the REVIEWER store (inputs/<id>.data) —
  // replay reads these copies, never the live business store
  const storeBytes = async (ref: ArtifactRef): Promise<{ bytes: Buffer; hash: string } | null> => {
    if (!artifactStore!.readInputBytes) return null;
    const bytes = artifactStore!.readInputBytes(ref.artifactId);
    if (bytes === null) {
      // results-backed inputs (intermediate materializations)
      const rec = await artifactStore!.resolveResult(ref.artifactId);
      if (!rec) return null;
      return { bytes: Buffer.from(rec.content, "utf8"), hash: rec.contentHash };
    }
    const hash = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    // idempotent freeze: identical bytes already frozen -> no-op
    const existing = await store.readBytes(`inputs/${ref.artifactId}.data`);
    if (existing) {
      if (existing.hash !== hash) {
        throw new ReviewEvidenceError(`EVIDENCE_HASH_MISMATCH: frozen input bytes (${ref.artifactId}) differ`);
      }
      return { bytes, hash };
    }
    await store.writeBytes(`inputs/${ref.artifactId}.data`, bytes);
    return { bytes, hash };
  };
  const evidenceContent = await freezeEvidence(store, evidence, resolver, storeBytes);

  const proposal: AnalysisProposal = {
    schemaVersion: "1.0",
    proposalId: opts.proposalId,
    proposalVersion: 1,
    analysisResultRef: {
      artifactId: `artifacts/${evidence.analysisResultRef.artifactId}.json`,
      artifactType: "analysis-result",
      contentHash: evidenceContent.resultFrozenHash,
    },
    analysisPlanRef: {
      artifactId: `artifacts/${evidence.analysisPlanRef.artifactId}.json`,
      artifactType: "analysis-plan",
      contentHash: evidenceContent.planFrozenHash,
    },
    executionManifestRef: {
      artifactId: `artifacts/${evidence.executionManifestRef.artifactId}.json`,
      artifactType: "execution-manifest",
      contentHash: evidenceContent.manifestFrozenHash,
    },
    scriptArtifactRef: {
      artifactId: `artifacts/${evidence.scriptArtifactRef.artifactId}.json`,
      artifactType: "analysis-script",
      contentHash: evidenceContent.scriptFrozenHash,
    },
    inputManifestRef: evidence.inputManifestRef ? {
      artifactId: `artifacts/${evidence.inputManifestRef.artifactId}.json`,
      artifactType: "input-manifest",
      contentHash: evidenceContent.inputManifestFrozenHash,
    } : undefined,
    // input refs point at the FROZEN byte copies in the reviewer store
    // (inputs/<id>.data) — replay reads exactly these
    inputArtifactRefs: evidence.inputArtifactRefs.map((r) => ({
      artifactId: `inputs/${r.artifactId}.data`,
      artifactType: r.artifactType,
      contentHash: r.contentHash,
    })),
    validationRefs: evidence.validationRefs.map((r) => ({
      artifactId: `artifacts/${r.artifactId}.json`,
      artifactType: r.artifactType,
      contentHash: r.contentHash,
    })),
    replayPolicy: {
      required: true, numericTolerancePolicyId: "default",
      independentMetricIds: [], strictMode: false,
    },
    contentHash: "x",
    // DETERMINISTIC createdAt (frozen from the evidence hash) so freezing
    // the same evidence twice is idempotent (identical payload hash)
    createdAt: new Date(parseInt(evidence.analysisResultRef.contentHash.slice(0, 10), 16) * 1000).toISOString(),
  };
  const { contentHash: _ch, ...payload } = proposal;
  proposal.contentHash = contentHash(payload);
  await writeImmutableIdempotent(store, `proposals/${opts.proposalId}/v1/proposal.json`, payload);
  const pkg = await orch.buildReviewPackage(toReviewProposalEnvelope(proposal), payload, "ANALYSIS", "STANDARD", [], []);
  // persist the REAL policy snapshot (immutable) so human-approval and
  // promotion can reference the actual policy artifact — never a synthetic ref
  await writeImmutableIdempotent(
    store,
    `packages/${opts.proposalId}-v1/policy-snapshot.json`,
    pkg.policySnapshot,
  );
  return { store, orch, proposal, payload, pkg };
}

/** Run the review: gate (planReview) then EXACT executePlannedReview.
 *  Returns the persisted decision key + REAL decision hash so promotion can
 *  verify the decision content without scanning the store. */
export async function executeReviewWithEvidence(
  evidence: AnalysisEvidenceRefs,
  opts: {
    storeRoot: string;
    proposalId: string;
    artifactStore?: ArtifactStoreLike;
    semanticReviewer?: (digest: unknown) => Promise<unknown[]>;
    analysisMeta?: {
      analysisType: string;
      metricCount: number;
      dataQualityWarnings: number;
    };
    /** EXACT gate decision id frozen by the graph's sys.review-gate node. */
    gateDecisionId?: string;
  },
): Promise<{
  decision: ReviewDecisionArtifact;
  gateDecisionId: string;
  gate: { contentHash: string; reviewMode: string; subjectContentHash: string; gateDecisionId: string };
  decisionKey: string;
  decisionHash: string;
  proposalHash: string;
}> {
  const { store, orch, proposal, pkg } = await buildProposalFromEvidence(evidence, {
    storeRoot: opts.storeRoot, proposalId: opts.proposalId, artifactStore: opts.artifactStore,
  });

  let gate: { gateDecisionId: string; contentHash: string; reviewMode: string; subjectContentHash: string };
  if (opts.gateDecisionId) {
    // consume the EXACT gate decision frozen by the graph's sys.review-gate
    // node — never plan a NEW one
    const rec = await store.read<{
      gateDecisionId: string; contentHash: string; reviewMode: string; subjectContentHash: string;
    }>(`gate/${opts.gateDecisionId}.json`);
    if (!rec) {
      throw new ReviewEvidenceError(`GATE_DECISION_MISSING: ${opts.gateDecisionId}`);
    }
    gate = rec.content;
  } else {
    const planned = await orch.planReview({
      stage: "FINAL", subjectType: "ANALYSIS_PROPOSAL",
      subjectId: proposal.proposalId, subjectContentHash: proposal.contentHash,
      profile: "ANALYSIS",
      userReviewPreference: "STANDARD",
      analysisMeta: {
        analysisType: opts.analysisMeta?.analysisType ?? "data-analysis",
        methods: [], forExternalPublication: false,
        dataQualityWarnings: opts.analysisMeta?.dataQualityWarnings ?? 0,
        usesStatisticalTests: false, usesPrediction: false,
        metricCount: opts.analysisMeta?.metricCount ?? 0,
        inputArtifactCount: evidence.inputArtifactRefs.length,
      },
    }, { source: "SYSTEM", actorId: "graph-executor", authenticated: true });
    gate = {
      gateDecisionId: planned.gateDecisionId,
      contentHash: planned.contentHash,
      reviewMode: planned.reviewMode,
      subjectContentHash: planned.subjectContentHash,
    };
  }

  // pass the EXACT gate decision id (never a store scan)
  const decision = await orch.executePlannedReview({
    pkg,
    gateDecisionId: gate.gateDecisionId,
    profile: "ANALYSIS",
    runId: `review-${proposal.proposalId}`,
    sessionId: "graph-executor",
    model: process.env.REVIEWER_MODEL ?? "gpt-5.6-luna",
    analysisInput: {
      replayRunner: async (proposalArg: unknown, workspaceRoot: string) => {
        const { canonicalizeAnalysisResult } = await import("../../reviewer/analysis/verifier.ts");
        const p = proposalArg as AnalysisProposal;
        // REAL computation replay: re-execute the frozen script on the frozen
        // inputs, then canonicalize the NEW result (never the saved one)
        const replayStore = opts.artifactStore ?? await artifactStoreForDefault();
        const replayed = await replayScriptFromEvidence(p, replayStore, store, workspaceRoot);
        const c = canonicalizeAnalysisResult(replayed);
        return {
          metrics: c.metrics, tables: c.tables, status: c.status,
          replayResult: { proposalId: p.proposalId, replayed: true },
          replayManifest: {
            proposalId: p.proposalId,
            replayedAt: new Date().toISOString(),
            replayMode: "script-on-frozen-inputs",
          },
        };
      },
      verificationCases: [],
      semanticReviewer: opts.semanticReviewer as never
        ?? (await import("../../reviewer/adapters/pi-reviewer.ts")).createPiSemanticReviewer() as never,
    },
  });

  // REVIEW-INDEX: the exact persisted decision + gate binding (no scan).
  // The decision lives at reviews/<key>/attempts/<attemptId>/decision.json;
  // the no-clobber terminal-pointer is the atomic commit point.
  const key = reviewKey({
    proposalContentHash: proposal.contentHash,
    gateDecisionHash: gate.contentHash,
    policySnapshotHash: pkg.policySnapshot.contentHash,
    reviewerVersion: "1.0.0",
    reviewLevel: pkg.policySnapshot.reviewLevel,
  });
  const pointer = await store.read<{ attemptId: string }>(`reviews/${key}/terminal-pointer.json`);
  // ABSTAIN is NOT terminal: no terminal-pointer, but the attempt marker
  // exists so the attempt decision can be resolved and returned (the
  // promotion adapter then requires an approved human review decision)
  const abstain = pointer ? null : await store.read<{ attemptId: string }>(`reviews/${key}/abstain-latest.json`);
  if (!pointer && !abstain) {
    throw new ReviewEvidenceError(`DECISION_NOT_FOUND: no terminal or abstain decision for ${key}`);
  }
  const decisionKey = `reviews/${key}/attempts/${(pointer ?? abstain)!.content.attemptId}/decision.json`;
  const decisionRec = await store.read<unknown>(decisionKey);
  if (!decisionRec) {
    throw new ReviewEvidenceError(`DECISION_MISSING: ${decisionKey}`);
  }
  const decisionHash = canonicalHash(decisionRec.content);
  const indexEntry: ReviewIndexEntry = {
    reviewId: decision.reviewId,
    proposalId: proposal.proposalId,
    decisionKey,
    decisionHash,
    gateDecisionId: gate.gateDecisionId,
    gateHash: gate.contentHash,
    proposalHash: proposal.contentHash,
    verdict: decision.verdict,
    policySnapshotHash: decision.policySnapshotHash ?? "",
    policyRef: `packages/${opts.proposalId}-v1/policy-snapshot.json`,
    createdAt: decision.createdAt,
  };
  await writeImmutableIdempotent(store, `graph-review-index/${decision.reviewId}.json`, indexEntry);

  return {
    decision,
    gateDecisionId: gate.gateDecisionId,
    gate: {
      contentHash: gate.contentHash, reviewMode: gate.reviewMode,
      subjectContentHash: gate.subjectContentHash, gateDecisionId: gate.gateDecisionId,
    },
    decisionKey,
    decisionHash,
    proposalHash: proposal.contentHash,
  };
}

/** Read the FROZEN input manifest (the exact contract the script ran
 *  against) from the reviewer store. */
async function readFrozenInputManifest(
  proposal: AnalysisProposal,
  store: ReviewerStore,
): Promise<Record<string, unknown>> {
  // the proposal's input-manifest ref points at artifacts/<id>.json
  const artifactId = proposal.proposalId.replace(/^analysis-/, "");
  const rec = await store.read<Record<string, unknown>>(`artifacts/${artifactId}.json`);
  if (!rec?.content) {
    throw new ReviewEvidenceError("REPLAY_MANIFEST_MISSING: frozen input manifest not available");
  }
  const result = rec.content as { inputManifestRef?: string };
  if (!result.inputManifestRef) {
    throw new ReviewEvidenceError("REPLAY_MANIFEST_MISSING: result has no inputManifestRef");
  }
  const manifestRec = await store.read<Record<string, unknown>>(`artifacts/${result.inputManifestRef}.json`);
  if (!manifestRec?.content) {
    throw new ReviewEvidenceError("REPLAY_MANIFEST_MISSING: frozen input manifest artifact not found");
  }
  if (proposal.inputManifestRef?.contentHash && manifestRec.hash !== proposal.inputManifestRef.contentHash) {
    throw new ReviewEvidenceError(`REPLAY_MANIFEST_TAMPERED: frozen input manifest hash ${manifestRec.hash} != proposal ${proposal.inputManifestRef.contentHash}`);
  }
  return manifestRec.content as Record<string, unknown>;
}

async function artifactStoreForDefault(): Promise<ArtifactStoreLike> {
  const { ArtifactStore } = await import("../../data-analysis/artifact-store.ts");
  return new ArtifactStore();
}

/** REAL computation replay: run the frozen script on the frozen input bytes
 *  in an isolated workspace and return the NEW result JSON. Never re-reads
 *  the saved result (a script that was wrong but self-consistent is caught
 *  by the reviewer's canonicalize comparison in the runner). */
async function replayScriptFromEvidence(
  proposal: AnalysisProposal,
  artifactStore: ArtifactStoreLike | undefined,
  store: ReviewerStore,
  workspaceRoot: string,
): Promise<unknown> {
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  // frozen script CONTENT (persisted by runDataAnalysis as scriptContent)
  const scriptRec = await store.read<{ scriptContent?: string; scriptHash?: string }>(
    proposal.scriptArtifactRef.artifactId);
  if (!scriptRec?.content?.scriptContent) {
    throw new ReviewEvidenceError(`REPLAY_SCRIPT_MISSING: frozen script content not available (${proposal.scriptArtifactRef.artifactId})`);
  }
  // P1-7: the FROZEN script must still match the proposal ref hash — a
  // tampered frozen script changes replay behavior and is caught here
  if (proposal.scriptArtifactRef.contentHash && scriptRec.hash !== proposal.scriptArtifactRef.contentHash) {
    throw new ReviewEvidenceError(`REPLAY_SCRIPT_TAMPERED: frozen script hash ${scriptRec.hash} != proposal ${proposal.scriptArtifactRef.contentHash}`);
  }
  const inputDir = join(workspaceRoot, "input");
  const outputDir = join(workspaceRoot, "output");
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  // FROZEN input bytes from the REVIEWER store (inputs/<id>.data) — the
  // live business store is NEVER read during replay (TOCTOU closed). The
  // frozen copy's hash must match the proposal ref's hash.
  let anyInput = false;
  for (const ref of proposal.inputArtifactRefs) {
    const frozen = await store.readBytes(ref.artifactId);
    if (!frozen) {
      throw new ReviewEvidenceError(`REPLAY_INPUT_MISSING: frozen input ${ref.artifactId} not in reviewer store`);
    }
    if (ref.contentHash && frozen.hash !== ref.contentHash) {
      throw new ReviewEvidenceError(`REPLAY_INPUT_CHANGED: frozen input ${ref.artifactId} hash mismatch`);
    }
    // original workspace layout: input files are <artifactId>.data (the
    // exact mapping the script executed against)
    const id = ref.artifactId.replace(/^inputs\//, "").replace(/\.data$/, "");
    writeFileSync(join(inputDir, `${id}.data`), frozen.bytes);
    anyInput = true;
  }
  if (!anyInput) {
    throw new ReviewEvidenceError("REPLAY_INPUT_MISSING: no frozen inputs");
  }
  const scriptPath = join(workspaceRoot, "script.py");
  writeFileSync(scriptPath, scriptRec.content.scriptContent, "utf8");
  // the ORIGINAL input manifest (frozen from the analysis run) is reused
  // VERBATIM — same schema/columns/rowCount/expectedViews/mappings the
  // script saw; only the workspace paths point at the replay sandbox. A
  // script depending on any manifest contract replays the SAME logic.
  const manifestRec = await store.read<Record<string, unknown>>(
    `artifacts/${proposal.proposalId.replace(/^analysis-/, "")}.json`,
  ).catch(() => null);
  void manifestRec;
  const frozenManifest = await readFrozenInputManifest(proposal, store);
  const replayManifest = { ...frozenManifest } as Record<string, unknown>;
  const resultFile = join(outputDir, "analysis-result.json"); // ONE contract
  replayManifest["workspaceRoot"] = workspaceRoot;
  replayManifest["inputDir"] = inputDir;
  replayManifest["outputDir"] = outputDir;
  replayManifest["resultFile"] = resultFile;
  replayManifest["findingsFile"] = join(outputDir, "findings.json");
  writeFileSync(join(inputDir, "input-manifest.json"), JSON.stringify(replayManifest));
  const { runAnalysisScript } = await import("../../data-analysis/script-runner.ts");
  const run = await runAnalysisScript({
    runId: `replay-${proposal.proposalId}`,
    scriptPath,
    workspace: {
      root: workspaceRoot, inputDir, outputDir,
      scriptFile: scriptPath, resultFile,
      findingsFile: join(outputDir, "findings.json"),
      manifestFile: "", planFile: "", executionManifestFile: "",
      inputManifestFile: join(inputDir, "input-manifest.json"),
    } as unknown as import("../../data-analysis/workspace.ts").WorkspacePaths,
    timeoutSeconds: 120,
    maxScriptBytes: 200_000,
    maxStdoutBytes: 100_000,
    maxStderrBytes: 100_000,
    maxResultBytes: 1_000_000,
  });
  if (!run.ok) {
    throw new ReviewEvidenceError(`REPLAY_FAILED: ${run.errorCode ?? "unknown"} ${run.errorMessage ?? ""}`);
  }
  if (!existsSync(resultFile)) {
    throw new ReviewEvidenceError("REPLAY_RESULT_MISSING: script produced no result file");
  }
  try {
    return JSON.parse(readFileSync(resultFile, "utf8"));
  } catch (error) {
    throw new ReviewEvidenceError(`REPLAY_RESULT_INVALID: ${String(error)}`);
  }
}
