/**
 * Phase 0 tests — contracts + canonical hash + deterministic reducer.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalHash, canonicalJson, reviewKey } from "../../src/reviewer/contracts/index.ts";
import { reduceReason, reduceReviewDecision } from "../../src/reviewer/decision-reducer.ts";
import type { ReviewCheckResult, ReviewFinding } from "../../src/reviewer/contracts/index.ts";

function check(partial: Partial<ReviewCheckResult>): ReviewCheckResult {
  return {
    checkId: "c", checkClass: "INTEGRITY", required: true, status: "PASSED",
    summary: "", evidenceRefs: [], startedAt: "", completedAt: "", durationMs: 0,
    ...partial,
  };
}

function finding(severity: ReviewFinding["severity"]): ReviewFinding {
  return {
    findingId: "f", severity, category: "x", claim: "c", evidenceRefs: [],
    suggestedAction: "a", deterministic: true, confidence: 0.9, createdAt: "",
  };
}

describe("canonical hashing", () => {
  test("field order independent", () => {
    const a = canonicalHash({ a: 1, b: { c: [1, 2], d: "x" } });
    const b = canonicalHash({ b: { d: "x", c: [1, 2] }, a: 1 });
    assert.equal(a, b);
  });

  test("content change changes hash", () => {
    assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
  });

  test("array order matters", () => {
    assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  });

  test("undefined fields omitted", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  });
});

describe("reviewKey idempotency", () => {
  const base = {
    proposalContentHash: "p", policySnapshotHash: "pol",
    reviewerVersion: "0.1.0", reviewLevel: "STANDARD" as const,
  };
  test("same inputs same key", () => {
    assert.equal(reviewKey(base), reviewKey({ ...base }));
  });
  test("policy change new key", () => {
    assert.notEqual(reviewKey(base), reviewKey({ ...base, policySnapshotHash: "pol2" }));
  });
});

describe("decision reducer", () => {
  test("all pass -> PASS", () => {
    assert.equal(reduceReviewDecision({ checks: [check({})], findings: [] }), "PASS");
  });

  test("integrity failure -> REJECT", () => {
    const r = reduceReviewDecision({
      checks: [check({ status: "FAILED", checkClass: "INTEGRITY" })],
      findings: [],
    });
    assert.equal(r, "REJECT");
  });

  test("required unavailable -> ABSTAIN", () => {
    const r = reduceReviewDecision({
      checks: [check({ status: "UNAVAILABLE" })], findings: [],
    });
    assert.equal(r, "ABSTAIN");
  });

  test("required failed -> CHANGES_REQUIRED", () => {
    const r = reduceReviewDecision({
      checks: [check({ status: "FAILED", checkClass: "TESTING" })], findings: [],
    });
    assert.equal(r, "CHANGES_REQUIRED");
  });

  test("blocker finding -> CHANGES_REQUIRED", () => {
    const r = reduceReviewDecision({
      checks: [check({})], findings: [finding("BLOCKER")],
    });
    assert.equal(r, "CHANGES_REQUIRED");
  });

  test("high finding -> CHANGES_REQUIRED", () => {
    const r = reduceReviewDecision({
      checks: [check({})], findings: [finding("HIGH")],
    });
    assert.equal(r, "CHANGES_REQUIRED");
  });

  test("medium/low findings can coexist with PASS", () => {
    const r = reduceReviewDecision({
      checks: [check({})], findings: [finding("MEDIUM"), finding("LOW")],
    });
    assert.equal(r, "PASS");
  });

  test("integrity beats unavailable", () => {
    const r = reduceReviewDecision({
      checks: [check({ status: "FAILED", checkClass: "INTEGRITY" }),
                check({ status: "UNAVAILABLE", checkId: "u" })],
      findings: [],
    });
    assert.equal(r, "REJECT");
  });

  test("advisory check failure does not block PASS", () => {
    const r = reduceReviewDecision({
      checks: [check({ required: false, status: "FAILED" })], findings: [],
    });
    assert.equal(r, "PASS");
  });

  test("reduceReason breakdown", () => {
    const r = reduceReason({ checks: [check({ status: "FAILED", checkClass: "TESTING" })], findings: [] });
    assert.equal(r.verdict, "CHANGES_REQUIRED");
    assert.ok(r.reasons.length >= 1);
  });
});
