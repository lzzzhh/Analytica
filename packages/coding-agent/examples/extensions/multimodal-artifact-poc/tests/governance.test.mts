/**
 * TS unit tests for CDXR governance (spec §13 TypeScript areas):
 *   - governance Gateway client methods
 *   - Pi governance tool schemas registered
 *   - profile → Evidence facts (kind=governance, metadata)
 *   - finding → Evidence facts
 *   - conflict merge: governance vs query → requires_verification
 *   - inferred must NOT override a governance fact
 *   - Gateway unavailable / not configured
 *   - empty findings → no facts
 *   - HIGH severity surfaced in the summary
 * Run: node --experimental-strip-types --test tests/
 */
// Feature env preamble (feature-driven registry): round2.lakehouse must be
// on for the 7 lakehouse tools to register; legacy governance stays off
// (default) so the legacy tools must NOT be registered.
import "./set-lakehouse-on.ts";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  GatewayClient,
  GatewayUnavailableError,
  type GovernanceFinding,
  type GovernanceProfile,
} from "../src/data-tools/client.ts";
import {
  governanceFindingsToFacts,
  governanceProfileSummary,
  governanceProfileToFacts,
} from "../src/data-tools/evidence-adapter.ts";
import { mergeEvidence, type EvidencePacket } from "../src/evidence.ts";
import {
  DATA_TOOLS,
  EXPLAIN_GOVERNANCE_EVIDENCE_TOOL,
  GET_GOVERNANCE_PROFILE_TOOL,
  GET_GOVERNANCE_REVIEW_STATUS_TOOL,
  INSPECT_GOVERNANCE_FINDING_TOOL,
  LIST_GOVERNANCE_FINDINGS_TOOL,
} from "../src/data-tools/tools.ts";

class MockTransport {
  routes = new Map<string, { status: number; body: unknown }>();

  install() {
    this._orig = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      for (const [key, route] of this.routes) {
        if (url.includes(key)) {
          return {
            ok: route.status >= 200 && route.status < 300,
            status: route.status,
            json: async () => route.body,
            text: async () => JSON.stringify(route.body),
          } as Response;
        }
      }
      throw new TypeError("Failed to fetch (mock)");
    }) as typeof fetch;
  }

  restore() {
    globalThis.fetch = this._orig!;
  }

  private _orig?: typeof fetch;
}

const mock = new MockTransport();

function sampleProfile(): GovernanceProfile {
  return {
    datasetId: "ads.model_metrics",
    snapshotId: "8123266417553960382",
    governanceScore: 90,
    status: "TRUSTED",
    openFindingCount: 1,
    highestSeverity: "MEDIUM",
    dimensionScores: { domain: 90 },
    qualityStatus: "PASS",
    qualityReference: "quality://ads.model_metrics?snapshot=8123266417553960382",
    lineageReference: "lineage://ads.model_metrics",
    findingIds: ["fnd_abc"],
    generatedAt: "2026-07-31T12:00:00Z",
  };
}

function sampleFinding(): GovernanceFinding {
  return {
    findingId: "fnd_abc",
    runId: "run_xyz",
    ruleId: "domain_field_check",
    datasetId: "ads.model_metrics",
    severity: "HIGH",
    confidence: 0.95,
    status: "OPEN",
    snapshotId: "8123266417553960382",
    reasonCodes: ["DOMAIN_FIELD"],
    qualityReference: "quality://ads.model_metrics",
    lineageReference: "lineage://ads.model_metrics",
    summary: "domain-specific fields present",
  };
}

function samplePacket(facts: any[]): EvidencePacket {
  return { producer: { tier: "standard", documentId: "d1", scope: "test" }, facts, inferences: [], unknowns: [], escalations: [] };
}

describe("governance Gateway client", () => {
  beforeEach(() => {
    mock.routes.clear();
    mock.routes.set("/v1/governance/cdxr/datasets/ads.model_metrics/profile", { status: 200, body: sampleProfile() });
    mock.routes.set("/v1/governance/cdxr/findings", { status: 200, body: { count: 1, findings: [sampleFinding()] } });
    mock.routes.set("/v1/governance/cdxr/findings/fnd_abc/evidence", {
      status: 200,
      body: { findingId: "fnd_abc", count: 1, evidence: [{ evidenceId: "evd_1", findingId: "fnd_abc", sourceType: "profile", sourceReference: "profile:ads.model_metrics", confidence: 0.95 }] },
    });
    mock.routes.set("/v1/governance/cdxr/review-queue", { status: 200, body: { count: 1, items: [{ findingId: "fnd_abc", datasetId: "ads.model_metrics", severity: "HIGH", confidence: 0.95 }] } });
    mock.install();
  });
  afterEach(() => mock.restore());

  test("client reads profile / findings / evidence / review queue", async () => {
    const c = new GatewayClient({ baseUrl: "http://test" });
    const p = await c.getGovernanceProfile("ads.model_metrics");
    assert.equal(p.governanceScore, 90);
    assert.equal(p.status, "TRUSTED");
    const f = await c.listGovernanceFindings({ datasetId: "ads.model_metrics" });
    assert.equal(f.count, 1);
    assert.equal(f.findings[0]!.ruleId, "domain_field_check");
    const ev = await c.getGovernanceEvidence("fnd_abc");
    assert.equal(ev.count, 1);
    const q = await c.getGovernanceReviewStatus();
    assert.equal(q.count, 1);
  });

  test("gateway unavailable surfaces for governance calls", async () => {
    mock.restore();
    const c = new GatewayClient({ baseUrl: "http://down" });
    await assert.rejects(() => c.getGovernanceProfile("x"), GatewayUnavailableError);
  });
});

describe("governance tool schemas", () => {
  test("legacy governance tools are NOT part of the default registry", () => {
    // CDXR is on-demand training assessment now; the legacy governance plane
    // stays available as code + client methods, but the agent no longer sees
    // it by default (see ASSESS_TRAINING_DATA_TOOL / CDXR_TRAINING_TOOL_ENABLED).
    const names = DATA_TOOLS.map((t) => t.name);
    for (const legacy of ["get_dataset_governance_profile", "list_governance_findings",
                          "inspect_governance_finding", "explain_governance_evidence",
                          "get_governance_review_status"]) {
      assert.ok(!names.includes(legacy), `legacy tool ${legacy} must not be registered by default`);
    }
    assert.equal(DATA_TOOLS.length, 9); // 7 lakehouse + assess_training_data + materialize_query (everything-ON policy)
  });

  test("tools are read-only (no write surface)", () => {
    for (const tool of [GET_GOVERNANCE_PROFILE_TOOL, LIST_GOVERNANCE_FINDINGS_TOOL,
                        INSPECT_GOVERNANCE_FINDING_TOOL, EXPLAIN_GOVERNANCE_EVIDENCE_TOOL,
                        GET_GOVERNANCE_REVIEW_STATUS_TOOL]) {
      const desc = tool.description.toLowerCase();
      // positive write claims ("can create/update/...") — "cannot close" is fine
      assert.ok(!/\b(can|may|allows?)\b[^.]*\b(create|update|delete|waive|close)\b/.test(desc),
                `${tool.name} looks writable`);
    }
  });
});

describe("governance → evidence", () => {
  test("profile → facts with governance kind + metadata", () => {
    const facts = governanceProfileToFacts(sampleProfile());
    assert.ok(facts.length >= 2);
    const status = facts.find((f) => f.claim.endsWith("governance status"))!;
    assert.equal(status.kind, "governance");
    assert.equal(status.value, "TRUSTED");
    assert.equal(status.confidence, 1);
    assert.equal(status.metadata?.governanceScore, 90);
    assert.equal(status.metadata?.qualityReference, "quality://ads.model_metrics?snapshot=8123266417553960382");
    assert.equal(status.metadata?.lineageReference, "lineage://ads.model_metrics");
  });

  test("finding → facts with findingId/ruleId/severity/reviewStatus", () => {
    const facts = governanceFindingsToFacts([sampleFinding()]);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.kind, "governance");
    assert.equal(facts[0]!.metadata?.findingId, "fnd_abc");
    assert.equal(facts[0]!.metadata?.ruleId, "domain_field_check");
    assert.equal(facts[0]!.metadata?.severity, "HIGH");
    assert.equal(facts[0]!.metadata?.reviewStatus, "OPEN");
    assert.equal(facts[0]!.evidence, "governance:fnd_abc");
  });

  test("empty findings → no facts", () => {
    assert.equal(governanceFindingsToFacts([]).length, 0);
  });

  test("HIGH severity surfaced in profile summary", () => {
    const p: GovernanceProfile = { ...sampleProfile(), status: "UNTRUSTED", governanceScore: 40, highestSeverity: "HIGH" };
    const s = governanceProfileSummary(p);
    assert.ok(/UNTRUSTED/.test(s));
    assert.ok(/highest=HIGH/.test(s));
    assert.ok(/openFindings=1/.test(s));
  });
});

describe("governance conflict merge", () => {
  test("governance vs query conflict → requires_verification, never auto-pick", () => {
    const gov = samplePacket([
      { claim: "ads.model_metrics fit for analysis", value: "BLOCK", evidence: "governance:fnd_1", confidence: 0.95, kind: "governance", metadata: { datasetId: "ads.model_metrics", findingId: "fnd_1", severity: "CRITICAL", reviewStatus: "OPEN" } },
    ]);
    const query = samplePacket([
      { claim: "ads.model_metrics fit for analysis", value: "yes", evidence: "query:q_1", confidence: 1, kind: "query", metadata: { datasetId: "ads.model_metrics", queryId: "q_1" } },
    ]);
    const merged = mergeEvidence(query, gov);
    assert.equal(merged.conflicts.length, 1);
    const conflict = merged.conflicts[0]!;
    assert.equal(conflict.resolution, "requires_verification");
    const kinds = conflict.candidates.map((c) => c.sourceType);
    assert.ok(kinds.includes("query") && kinds.includes("governance"));
  });

  test("inferred must NOT override a governance fact", () => {
    const gov = samplePacket([
      { claim: "model_metrics status", value: "UNTRUSTED", evidence: "governance:fnd_1", confidence: 1, kind: "governance", metadata: { datasetId: "ads.model_metrics", severity: "HIGH", reviewStatus: "OPEN" } },
    ]);
    const model = samplePacket([
      { claim: "model_metrics status", value: "TRUSTED", evidence: undefined, confidence: 0.6, kind: "inferred" },
    ]);
    const merged = mergeEvidence(model, gov);
    // conflicting values → not resolved; governance fact must survive as a candidate
    assert.equal(merged.conflicts.length, 1);
    assert.ok(merged.conflicts[0]!.candidates.some((c) => c.sourceType === "governance" && c.value === "UNTRUSTED"));
    assert.ok(!merged.facts.some((f) => f.value === "TRUSTED"));
  });

  test("consistent claims keep the highest-priority source (governance over inferred)", () => {
    const gov = samplePacket([
      { claim: "score", value: 40, evidence: "governance:fnd_1", confidence: 1, kind: "governance" },
    ]);
    const model = samplePacket([
      { claim: "score", value: 40, evidence: undefined, confidence: 0.5, kind: "inferred" },
    ]);
    const merged = mergeEvidence(model, gov);
    assert.equal(merged.conflicts.length, 0);
    assert.equal(merged.facts[0]!.kind, "governance");
  });
});
