/**
 * Phase 5+6 tests — revision loop, frontend summary, feature gating helpers.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerStore } from "../../src/reviewer/store.ts";
import {
  MAX_REVISION_CYCLES,
  StoreRevisionTracker,
  RevisionLimitError,
  revisionDisposition,
} from "../../src/reviewer/revision-loop.ts";
import { effectiveStatus, toReviewSummary } from "../../src/reviewer/frontend.ts";
import type { ReviewDecisionArtifact } from "../../src/reviewer/contracts/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rev5-"));
}

function decision(verdict: ReviewDecisionArtifact["verdict"], version = 1): ReviewDecisionArtifact {
  return {
    schemaVersion: "1.0", reviewId: `r-${verdict}`, reviewAttempt: 1,
    reviewPackageId: "rp", reviewPackageContentHash: "h",
    proposalId: "pa", proposalVersion: version, proposalContentHash: "h",
    reviewer: { profile: "CODE", runId: "r", sessionId: "s", model: "m", reviewerVersion: "0.1.0" },
    verdict, blockingFindings: [], advisoryFindings: [],
    deterministicChecks: [], executionChecks: [], semanticChecks: [],
    policySnapshotHash: "pol", confidence: 1, createdAt: new Date().toISOString(),
  };
}

describe("revision disposition", () => {
  test("PASS -> continue (human decision follows)", () => {
    const d = revisionDisposition(decision("PASS"));
    assert.equal(d.action, "CONTINUE");
  });
  test("REJECT -> stop, no auto revision", () => {
    assert.equal(revisionDisposition(decision("REJECT")).action, "STOP");
  });
  test("ABSTAIN -> retry, not counted", () => {
    assert.equal(revisionDisposition(decision("ABSTAIN")).action, "RETRY");
  });
  test("CHANGES_REQUIRED -> revise to next version", () => {
    const d = revisionDisposition(decision("CHANGES_REQUIRED", 3));
    assert.equal(d.action, "REVISE");
    assert.equal(d.nextVersion, 4);
  });
});

describe("revision tracker", () => {
  test("first version has 0 cycles", async () => {
    const store = new ReviewerStore(tmp());
    const t = new StoreRevisionTracker(store);
    assert.equal(await t.cyclesFor("pa", 1), 0);
  });

  test("limit enforced after MAX cycles", async () => {
    const store = new ReviewerStore(tmp());
    const t = new StoreRevisionTracker(store);
    // simulate a supersede chain: v1 <- v2 <- v3 (v3 supersedes v2 supersedes v1)
    await store.writeImmutable("proposals/pa/v1/proposal.json", { proposalId: "pa", version: 1 });
    await store.writeImmutable("proposals/pa/v2/proposal.json", { proposalId: "pa", version: 2, supersedesProposalId: "pa", supersedesProposalVersion: 1 });
    await store.writeImmutable("proposals/pa/v3/proposal.json", { proposalId: "pa", version: 3, supersedesProposalId: "pa", supersedesProposalVersion: 2 });
    assert.equal(await t.cyclesFor("pa", 3), 2);
    await assert.rejects(() => t.register(decision("CHANGES_REQUIRED", 3)), RevisionLimitError);
  });

  test("register works within limit", async () => {
    const store = new ReviewerStore(tmp());
    const t = new StoreRevisionTracker(store);
    await store.writeImmutable("proposals/pa/v1/proposal.json", { proposalId: "pa", version: 1 });
    const next = await t.register(decision("CHANGES_REQUIRED", 1));
    assert.equal(next, 1); // one cycle consumed
  });
});

describe("frontend", () => {
  test("summary counts + categories", () => {
    const d: ReviewDecisionArtifact = {
      ...decision("CHANGES_REQUIRED"),
      blockingFindings: [
        { findingId: "b1", severity: "BLOCKER", category: "SECURITY", claim: "c", evidenceRefs: [], suggestedAction: "a", deterministic: true, confidence: 1, createdAt: "" },
        { findingId: "b2", severity: "HIGH", category: "SECURITY", claim: "c", evidenceRefs: [], suggestedAction: "a", deterministic: true, confidence: 1, createdAt: "" },
      ],
      advisoryFindings: [
        { findingId: "m1", severity: "MEDIUM", category: "TESTING", claim: "c", evidenceRefs: [], suggestedAction: "a", deterministic: true, confidence: 1, createdAt: "" },
      ],
    };
    const s = toReviewSummary(d);
    assert.equal(s.blockerCount, 1);
    assert.equal(s.highCount, 1);
    assert.equal(s.advisoryCount, 1);
    assert.deepEqual([...s.categories].sort(), ["SECURITY", "TESTING"]);
    assert.equal(s.displayedDirectly, true);
  });

  test("effective status mapping", () => {
    assert.equal(effectiveStatus("PASS"), "PASSED");
    assert.equal(effectiveStatus("ABSTAIN"), "ABSTAINED");
    assert.equal(effectiveStatus("NOT_REVIEWED"), "NOT_REVIEWED");
  });

  test("max revision constant", () => {
    assert.equal(MAX_REVISION_CYCLES, 2);
  });
});
