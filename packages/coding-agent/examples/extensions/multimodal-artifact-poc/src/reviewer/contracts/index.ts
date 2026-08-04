/**
 * Reviewer — shared contracts: canonical hashing, proposal envelopes,
 * review packages, checks, findings, decisions, summaries.
 *
 * Round 5 Proposer–Reviewer architecture. All persisted objects carry a
 * canonical SHA-256 (field-order independent). Everything here is type-only
 * plus the deterministic hash/verify helpers; no LLM, no side effects.
 */

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  // stable field order: sort object keys recursively; arrays keep order
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// ---------------------------------------------------------------------------
// Shared enums / types
// ---------------------------------------------------------------------------

export type ProposalState =
  | "PROPOSED"
  | "REVIEWING"
  | "PASSED"
  | "CHANGES_REQUIRED"
  | "REJECTED"
  | "ABSTAINED"
  | "SUPERSEDED";

/** Machine verdict — deliberately NOT "APPROVE" (that is human-only). */
export type ReviewVerdict = "PASS" | "CHANGES_REQUIRED" | "REJECT" | "ABSTAIN" | "UNREVIEWED_LOW_RISK";

export type ProposalType = "CODE_CHANGE" | "DATA_ANALYSIS";

export type ProposalProducerRole = "CODING_AGENT" | "DATA_ANALYSIS_AGENT";

export interface ArtifactRef {
  artifactId: string;
  artifactType: string;
  contentHash: string;
}

export type ReviewCheckStatus = "PASSED" | "FAILED" | "UNAVAILABLE" | "SKIPPED";
export type ReviewCheckClass =
  | "INTEGRITY" | "SCHEMA" | "REQUIREMENT" | "EXECUTION" | "REPLAY"
  | "NUMERIC" | "SECURITY" | "COMPATIBILITY" | "PERFORMANCE" | "TESTING"
  | "METHODOLOGY" | "EVIDENCE" | "SEMANTIC";

export type ReviewSeverity = "BLOCKER" | "HIGH" | "MEDIUM" | "LOW";

// ---------------------------------------------------------------------------
// ReviewProposalEnvelope (§6)
// ---------------------------------------------------------------------------

export interface ReviewProposalEnvelope {
  schemaVersion: "1.0";
  proposalId: string;
  proposalType: ProposalType;
  proposalVersion: number;
  producer: {
    agentRole: ProposalProducerRole;
    runId: string;
    sessionId: string;
    model?: string;
    producerVersion: string;
  };
  subjectRefs: ArtifactRef[];
  requirementRefs: ArtifactRef[];
  validationRefs: ArtifactRef[];
  contentHash: string;
  policySnapshotHash: string;
  createdAt: string;
  supersedesProposalId?: string;
  supersedesProposalVersion?: number;
}

// ---------------------------------------------------------------------------
// CodeChangeProposal (§7)
// ---------------------------------------------------------------------------

export type CodeProposalMode = "GIT_COMMIT_RANGE" | "FROZEN_WORKTREE_SNAPSHOT";
export type ChangedFileStatus = "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";

export interface ChangedFileRef {
  path: string;
  status: ChangedFileStatus;
  beforeHash?: string;
  afterHash?: string;
  previousPath?: string;
  language?: string;
}

export interface CodeChangeProposal {
  schemaVersion: "1.0";
  proposalId: string;
  proposalVersion: number;
  mode: CodeProposalMode;
  repository: {
    repositoryId: string;
    baseCommitSha: string;
    headCommitSha?: string;
    snapshotArtifactId: string;
  };
  diffArtifactRef: ArtifactRef;
  changedFiles: ChangedFileRef[];
  requirementRefs: ArtifactRef[];
  testManifestRef?: ArtifactRef;
  ciManifestRef?: ArtifactRef;
  staticAnalysisRefs: ArtifactRef[];
  proposerSummary: {
    objective: string;
    implementationSummary: string;
    knownLimitations: string[];
    unverifiedAssumptions: string[];
  };
  contentHash: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// AnalysisProposal (§8)
// ---------------------------------------------------------------------------

export interface AnalysisProposal {
  schemaVersion: "1.0";
  proposalId: string;
  proposalVersion: number;
  analysisResultRef: ArtifactRef;
  analysisPlanRef: ArtifactRef;
  executionManifestRef: ArtifactRef;
  scriptArtifactRef: ArtifactRef;
  findingsRef?: ArtifactRef;
  /** Trusted-store copy of the FULL input manifest (replay equivalence). */
  inputManifestRef?: ArtifactRef;
  inputArtifactRefs: ArtifactRef[];
  validationRefs: ArtifactRef[];
  replayPolicy: {
    required: boolean;
    numericTolerancePolicyId: string;
    independentMetricIds: string[];
    strictMode: boolean;
  };
  contentHash: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// ReviewPolicySnapshot + ReviewPackage (§9)
// ---------------------------------------------------------------------------

export type ReviewProfile = "CODE" | "ANALYSIS";
export type ReviewLevel = "STANDARD" | "STRICT";

export interface ReviewPolicySnapshot {
  policyVersion: string;
  profile: ReviewProfile;
  reviewLevel: ReviewLevel;
  requiredChecks: string[];
  advisoryChecks: string[];
  severityRules: Record<string, string>;
  contentHash: string;
}

export interface ReviewPackage {
  schemaVersion: "1.0";
  reviewPackageId: string;
  proposalId: string;
  proposalVersion: number;
  proposalContentHash: string;
  proposalRef: ArtifactRef;
  safeContextRef: ArtifactRef;
  policySnapshot: ReviewPolicySnapshot;
  validationRefs: ArtifactRef[];
  requirementRefs: ArtifactRef[];
  packageContentHash: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// ReviewCheckResult (§10)
// ---------------------------------------------------------------------------

export interface ReviewCheckResult {
  checkId: string;
  checkClass: ReviewCheckClass;
  required: boolean;
  status: ReviewCheckStatus;
  summary: string;
  evidenceRefs: ArtifactRef[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// ReviewFinding (§11)
// ---------------------------------------------------------------------------

export interface ReviewLocation {
  file?: string;
  lineStart?: number;
  lineEnd?: number;
  artifactId?: string;
  sectionIndex?: number;
  metricId?: string;
  findingId?: string;
}

export interface ReviewFinding {
  findingId: string;
  severity: ReviewSeverity;
  category: string;
  claim: string;
  evidenceRefs: ArtifactRef[];
  location?: ReviewLocation;
  expected?: string;
  actual?: string;
  reproductionSteps?: string[];
  suggestedAction: string;
  deterministic: boolean;
  confidence: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// ReviewDecisionArtifact (§12)
// ---------------------------------------------------------------------------

export interface ReviewDecisionArtifact {
  schemaVersion: "1.0";
  reviewId: string;
  reviewAttempt: number;
  reviewPackageId: string;
  reviewPackageContentHash: string;
  proposalId: string;
  proposalVersion: number;
  proposalContentHash: string;
  reviewer: {
    profile: ReviewProfile;
    runId: string;
    sessionId: string;
    model: string;
    reviewerVersion: string;
  };
  reviewMode: "NONE" | "DETERMINISTIC_ONLY" | "STANDARD" | "STRICT";
  gateDecisionRef: { artifactId: string; contentHash: string };
  verdict: ReviewVerdict;
  blockingFindings: ReviewFinding[];
  advisoryFindings: ReviewFinding[];
  deterministicChecks: ReviewCheckResult[];
  executionChecks: ReviewCheckResult[];
  semanticChecks: ReviewCheckResult[];
  reviewerTestManifestRef?: ArtifactRef;
  replayArtifactRef?: ArtifactRef;
  independentVerificationRef?: ArtifactRef;
  policySnapshotHash: string;
  confidence: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// ReviewSummary (§16) — what the main agent receives
// ---------------------------------------------------------------------------

export interface ReviewSummary {
  reviewId: string;
  proposalId: string;
  verdict: ReviewVerdict;
  blockerCount: number;
  highCount: number;
  advisoryCount: number;
  categories: string[];
  findingRefs: string[];
  displayedDirectly: true;
}

/** Derive EffectiveReviewStatus (UI) without mutating the original artifact. */
export type EffectiveReviewStatus =
  | "NOT_REVIEWED"
  | "REVIEWING"
  | "PASSED"
  | "CHANGES_REQUIRED"
  | "REJECTED"
  | "ABSTAINED";

// ---------------------------------------------------------------------------
// Review identity (idempotency) — §19
// ---------------------------------------------------------------------------

export function reviewKey(input: {
  proposalContentHash: string;
  gateDecisionHash: string;
  policySnapshotHash: string;
  reviewerVersion: string;
  reviewLevel: ReviewLevel;
}): string {
  return canonicalHash(input);
}
