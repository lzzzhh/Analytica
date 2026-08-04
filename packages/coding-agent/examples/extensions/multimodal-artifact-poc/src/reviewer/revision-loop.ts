/**
 * Revision loop (§18) — findings go back to the PROPOSER, who creates a new
 * version. The reviewer never modifies proposals.
 *
 * Rules:
 *  - CHANGES_REQUIRED findings return to the original proposer
 *  - a new proposal bumps the version and references the superseded one
 *  - each revision gets a NEW review package and a FRESH reviewer session
 *  - default max 2 automatic revision cycles; beyond that -> manual review
 *  - REJECT never enters the loop; ABSTAIN does not count as a revision
 */
import { canonicalHash, ReviewerStore } from "./store.ts";
import type { ReviewDecisionArtifact } from "./contracts/index.ts";

export const MAX_REVISION_CYCLES = 2;

export class RevisionLimitError extends Error {}

export interface RevisionTracker {
  /** Number of CHANGES_REQUIRED cycles already consumed for this proposal lineage. */
  cyclesFor(proposalId: string, proposalVersion: number): Promise<number>;
  /** Register a CHANGES_REQUIRED decision; returns the allowed next version. */
  register(decision: ReviewDecisionArtifact): Promise<number>;
}

export class StoreRevisionTracker implements RevisionTracker {
  readonly store: ReviewerStore;

  constructor(store: ReviewerStore) {
    this.store = store;
  }

  async cyclesFor(proposalId: string, proposalVersion: number): Promise<number> {
    let count = 0;
    // walk the supersede chain from the current version back through revisions
    let v = proposalVersion;
    const seen = new Set<string>();
    while (v >= 1) {
      const key = `proposals/${proposalId}/v${v}/proposal.json`;
      if (seen.has(key)) break;
      seen.add(key);
      const rec = await this.store.read<{ supersedesProposalId?: string; supersedesProposalVersion?: number }>(key);
      if (!rec) break;
      count += 1;
      if (rec.content.supersedesProposalId && rec.content.supersedesProposalVersion) {
        proposalId = rec.content.supersedesProposalId;
        v = rec.content.supersedesProposalVersion!;
      } else {
        break;
      }
    }
    return Math.max(0, count - 1); // first version is not a revision
  }

  async register(decision: ReviewDecisionArtifact): Promise<number> {
    if (decision.verdict !== "CHANGES_REQUIRED") {
      throw new Error("only CHANGES_REQUIRED registers a revision");
    }
    const cycles = await this.cyclesFor(decision.proposalId, decision.proposalVersion);
    const next = cycles + 1;
    if (next > MAX_REVISION_CYCLES) {
      throw new RevisionLimitError(
        `revision limit reached (${MAX_REVISION_CYCLES}): escalate to manual review`,
      );
    }
    await this.store.appendLedger({
      event: "REVISION_REGISTERED",
      proposalId: decision.proposalId,
      proposalVersion: decision.proposalVersion,
      reviewId: decision.reviewId,
      nextVersion: decision.proposalVersion + 1,
      cycle: next,
      at: new Date().toISOString(),
    });
    return next;
  }
}

/**
 * Determine the disposition after a review verdict (§18 rules 8-11).
 * Returns the next action for the proposer.
 */
export function revisionDisposition(decision: ReviewDecisionArtifact): {
  action: "REVISE" | "SUPERSEDED_ACCEPT" | "STOP" | "MANUAL_REVIEW" | "RETRY" | "CONTINUE";
  nextVersion?: number;
  reason: string;
} {
  switch (decision.verdict) {
    case "PASS":
      return { action: "CONTINUE", reason: "machine checks passed; human decision follows" };
    case "REJECT":
      return { action: "STOP", reason: "proposal rejected; no automatic revision" };
    case "ABSTAIN":
      return { action: "RETRY", reason: "required evidence/tool unavailable; retry allowed" };
    case "CHANGES_REQUIRED":
      return {
        action: "REVISE",
        nextVersion: decision.proposalVersion + 1,
        reason: `proposer must revise to v${decision.proposalVersion + 1} with a new review package`,
      };
    default:
      return { action: "MANUAL_REVIEW", reason: `unhandled verdict ${decision.verdict as string}` };
  }
}

/** Build the supersedes chain entry for the new proposal version. */
export function supersedesRef(decision: ReviewDecisionArtifact): {
  supersedesProposalId: string;
  supersedesProposalVersion: number;
} {
  return {
    supersedesProposalId: decision.proposalId,
    supersedesProposalVersion: decision.proposalVersion,
  };
}
