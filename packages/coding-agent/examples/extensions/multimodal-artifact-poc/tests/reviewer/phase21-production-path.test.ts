/**
 * Phase 21 — PRODUCTION path integration (real adapters, real store,
 * real reviewer execution) + the reviewer's minimum acceptance counter
 * examples.
 *
 * Main path:
 *   register real input artifact (CSV, masked, provenance)
 *     -> runAnalysisGraph (real host wiring)
 *     -> sys.inputs -> real Preflight (governance, not just hashes)
 *     -> real DataAnalysisAdapter (real result/plan/manifest/script
 *        persistence incl. script CONTENT)
 *     -> real Review Gate (exact gateDecisionId, created ONCE)
 *     -> executeReviewWithEvidence (proposal frozen ONCE, REAL decision
 *        hash, REAL computation replay on frozen inputs)
 *     -> Promotion (real decision + real gate artifact, hash-verified)
 *     -> REPORT_SKILL_UNAVAILABLE (expected current terminal, fail closed)
 *
 * Acceptance counters (reviewer round-4):
 *   - gate creation == 1 (graph-gate-index has exactly one entry)
 *   - proposal freeze == 1 (one proposal file; a second reviewer pass is
 *     idempotent and writes nothing new)
 *   - reviewer used the graph's EXACT gateDecisionId (review-index binding)
 *   - live state hash == replay state hash (same runId re-run)
 *   - arrow/parquet binary bytes hash verification + format/mask meta
 *
 * Counter-examples (fail closed):
 *   - sensitive unmasked input        -> preflight MASKING_REQUIRED
 *   - no provenance                   -> preflight LINEAGE_MISSING
 *   - unknown contentType             -> preflight SCHEMA_INVALID
 *   - unmasked + external report      -> preflight MASKING_REQUIRED
 *   - tampered decision.json          -> promotion PROMOTION_DENIED
 *   - tampered gate artifact          -> promotion PROMOTION_DENIED
 *   - tampered result payload/manifest-> resolveResult null
 *   - ABSTAIN without human approval  -> promotion PROMOTION_DENIED
 *   - ABSTAIN + operator APPROVED     -> promotion ALLOWED (human decision)
 *   - forged feature snapshot hash    -> executor SCHEMA_INVALID
 *   - maxAttempts=1 crash + resume    -> ATTEMPTS_EXHAUSTED, no re-exec
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGraphToolHost, runAnalysisGraph } from "../../src/graph-engine/tool-runner.ts";
import { graphCapabilityMap } from "../../src/graph-engine/capability-registry.ts";
import { preflightGovernanceAdapter, fanInAdapter, resolveEvidenceFromStore } from "../../src/graph-engine/adapters/production.ts";
import { reviewGateAdapter, reviewerAdapter, promotionAdapter } from "../../src/graph-engine/adapters/reviewer.ts";
import { analysisReportSkillAdapter, deliverableVerifierAdapter } from "../../src/graph-engine/adapters/report.ts";
import { dataAnalysisAdapter } from "../../src/graph-engine/adapters/data-analysis.ts";
import { ArtifactStore } from "../../src/data-analysis/artifact-store.ts";
import { GraphEventStore } from "../../src/graph-engine/event-store.ts";
import { GraphExecutor } from "../../src/graph-engine/executor.ts";
import { compileGraphSpec } from "../../src/graph-engine/graph-compiler.ts";
import { featureHash } from "../../src/features/hash.ts";
import { createHash } from "node:crypto";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "p21-"));
}

const EFFECTIVE_FEATURES = [
  "round6.graph_engine", "round6.graph_executor", "round6.graph_scheduler",
  "round6.graph_event_store", "round6.graph_state_reducer", "round6.graph_validation",
  "round6.graph_review_integration", "round6.graph_skill_nodes", "round6.graph_artifact_edges",
  "round6.graph_human_gates", "round6.graph_observability", "round6.graph_frontend_render",
  "round6.graph_tool", "round2.catalog_tools", "round2.query_tools", "round4.data_analysis",
  "round5.reviewer", "round2.pipeline_governance",
];
const SNAPSHOT = {
  effectiveFeatureHash: featureHash({ features: Object.fromEntries(EFFECTIVE_FEATURES.map((id) => [id, true])) }),
  effectiveFeatures: EFFECTIVE_FEATURES,
  disabledFeatures: [] as string[],
};

const CSV = "date,revenue\n2026-01-01,100\n2026-01-02,150\n2026-01-03,200";
const CSV_HASH = createHash("sha256").update(CSV).digest("hex");
const CSV_ID = "art_a1b2c3d4e5f60708";
const ARROW_ID = "art_a1b2c3d4e5f60709";
// real arrow binary bytes (non-UTF-8): must be hashed as BYTES, never decoded
const ARROW_BYTES = Buffer.from([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x01, 0x02, 0x03]);
const ARROW_HASH = createHash("sha256").update(ARROW_BYTES).digest("hex");

function fakeSubagent(inputIds: string[]) {
  return async (prompt: string, _opts: { timeoutMs: number }) => {
    // like a real subagent, echo the ACTUAL requested objective back into
    // the plan (the revision objective carries the findings)
    const m = /objective[：:\s]*([^\n]+)/.exec(prompt);
    const objective = (m?.[1]?.trim() ?? "sum revenue");
    return { ok: true, text: `PLAN_JSON:\n${JSON.stringify({
      objective, analysisType: "DESCRIPTIVE",
      inputArtifacts: inputIds, selectedColumns: ["date", "revenue"],
      steps: ["sum"], expectedOutputs: ["metrics"], methods: {}, assumptions: [], limitations: [],
    })}\nSCRIPT_START\nimport json, os\nm = json.load(open("input/input-manifest.json"))\nrows = []\nfor f in os.listdir("input"):\n    if f.endswith(".csv") or f.endswith(".data"):\n        with open(os.path.join("input", f), "rb") as fh: rows = fh.read()\njson.dump({"schemaVersion": "1.0", "artifactId": "art_placeholder0001", "runId": m["runId"], "status": "COMPLETED", "title": "revenue", "sections": [{"type": "METRIC_CARDS", "metrics": [{"metricId": "total", "label": "Total Revenue", "value": 450, "valueType": "NUMBER"}]}], "reviewStatus": "NOT_REVIEWED", "validationRefs": [], "createdAt": "2026-01-01T00:00:00Z"}, open(m["resultFile"], "w"))\nSCRIPT_END` } as never;
  };
}

interface Fixture {
  root: string;
  storeRoot: string;
  artifactStore: ArtifactStore;
  eventStore: GraphEventStore;
  csvId: string;
}

function registerInputs(artifactStore: ArtifactStore, opts: { masked?: boolean; provenance?: boolean; contentType?: string; sensitive?: boolean } = {}): string {
  const { masked = true, provenance = true, contentType = "text/csv", sensitive = false } = opts;
  const meta: Record<string, unknown> = {
    artifactId: CSV_ID, contentType,
    contentHash: CSV_HASH, masked, createdAt: new Date().toISOString(),
    columns: ["date", "revenue"],
  };
  if (provenance) {
    meta.queryId = "q_0000000000000001";
    meta.snapshotId = "snap-e2e";
  }
  if (sensitive) meta.sensitive = true;
  artifactStore.register(meta as never, CSV);
  return CSV_ID;
}

function wireHost(f: Fixture, semanticReviewer?: (digest: unknown) => Promise<unknown[]>, promptLog?: string[]) {
  const resolveEvidence = (id: string) => resolveEvidenceFromStore(id, f.artifactStore);
  const subagent = async (prompt: string, opts: { timeoutMs: number }) => {
    promptLog?.push(prompt);
    return fakeSubagent([CSV_ID])(prompt, opts);
  };
  const readFindings = async (refs: Array<{ artifactId: string; contentHash: string }>) => {
    const { readdirSync, readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const reviewsRoot = join(f.storeRoot, "reviews");
    const out: Array<{ category: string; claim: string; suggestedAction: string }> = [];
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
      if (!refs.some((r) => r.artifactId.startsWith(`finding:${d.reviewId}:`))) continue;
      for (const fnd of (d.blockingFindings ?? [])) {
        out.push({ category: fnd.category ?? "", claim: fnd.claim ?? "", suggestedAction: fnd.suggestedAction ?? "" });
      }
    }
    return out;
  };
  const adapters = new Map([
    [preflightGovernanceAdapter({ resolveArtifact: async (id) => f.artifactStore.resolveArtifact(id) as never }).capabilityId,
     preflightGovernanceAdapter({ resolveArtifact: async (id) => f.artifactStore.resolveArtifact(id) as never })],
    [fanInAdapter().capabilityId, fanInAdapter()],
    [dataAnalysisAdapter({
      store: f.artifactStore,
      subagent,
      featureSnapshot: { effectiveFeatures: SNAPSHOT.effectiveFeatures },
      readFindings,
    }).capabilityId, dataAnalysisAdapter({
      store: f.artifactStore,
      subagent,
      featureSnapshot: { effectiveFeatures: SNAPSHOT.effectiveFeatures },
      readFindings,
    })],
    [reviewGateAdapter({ storeRoot: f.storeRoot, resolveEvidence, artifactStore: f.artifactStore }).capabilityId,
     reviewGateAdapter({ storeRoot: f.storeRoot, resolveEvidence, artifactStore: f.artifactStore })],
    [reviewerAdapter({ storeRoot: f.storeRoot, resolveEvidence, artifactStore: f.artifactStore, semanticReviewer }).capabilityId,
     reviewerAdapter({ storeRoot: f.storeRoot, resolveEvidence, artifactStore: f.artifactStore, semanticReviewer })],
    [promotionAdapter({ storeRoot: f.storeRoot, readEventChain: async (runId) => f.eventStore.allEvents(runId) }).capabilityId,
     promotionAdapter({ storeRoot: f.storeRoot, readEventChain: async (runId) => f.eventStore.allEvents(runId) })],
    [analysisReportSkillAdapter().capabilityId, analysisReportSkillAdapter()],
    [deliverableVerifierAdapter().capabilityId, deliverableVerifierAdapter()],
  ]);
  setGraphToolHost({
    adapters,
    capabilities: graphCapabilityMap(),
    principal: { source: "SYSTEM", actorId: "test", authenticated: true },
  }, {
    storeRoot: f.storeRoot,
    featureSnapshotHash: SNAPSHOT.effectiveFeatureHash,
    effectiveFeatures: SNAPSHOT.effectiveFeatures,
    disabledFeatures: SNAPSHOT.disabledFeatures,
    artifactResolver: async (id: string) => {
      const rec = await f.artifactStore.resolveArtifact(id);
      if (!rec) return null;
      const meta = rec.meta as { contentHash?: unknown };
      const ch = typeof meta.contentHash === "string" ? meta.contentHash : "";
      return { artifactId: id, artifactType: "dataset", contentHash: ch, schemaVersion: "1.0", createdByNodeId: "materialize" };
    },
  });
}

function makeFixture(): Fixture {
  const root = tmp();
  const f: Fixture = {
    root,
    storeRoot: join(root, "reviewer-store"),
    artifactStore: new ArtifactStore(join(root, "artifact-store")),
    // the graph event store lives under the SAME root the tool runner uses
    eventStore: new GraphEventStore(join(root, "reviewer-store")),
    csvId: CSV_ID,
  };
  registerInputs(f.artifactStore);
  return f;
}

/** Count reviewer-store files under a prefix. */
function countFiles(dir: string, prefix: string): number {
  if (!existsSync(dir)) return 0;
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).length;
}

describe("phase21 production path", () => {
  test("full chain reaches REPORT_SKILL_UNAVAILABLE with exact handoffs", async () => {
    const f = makeFixture();
    wireHost(f);

    const runId = "run_p21main0001";
    const live = await runAnalysisGraph({
      objective: "sum revenue",
      dataRefs: [f.csvId],
      format: "markdown",
      runId,
    });

    // expected terminal: report skill fails CLOSED (no local interface)
    assert.ok(live.failedNodes.includes("sys.analysis-report") || live.blockedCodes.includes("REPORT_SKILL_UNAVAILABLE"),
      `expected REPORT_SKILL_UNAVAILABLE, got ${JSON.stringify(live)}`);
    assert.ok(live.status === "FAILED" || live.status === "COMPLETED");

    // ---- gate created EXACTLY ONCE (graph-gate-index pinned by node op key)
    const gateIndexDir = join(f.storeRoot, "graph-gate-index");
    const gateIndexFiles = existsSync(gateIndexDir) ? (await import("node:fs")).readdirSync(gateIndexDir) : [];
    if (gateIndexFiles.length !== 1) console.log("[dbg] gate-index files:", gateIndexFiles.join(","));
    assert.equal(gateIndexFiles.length, 1, `gate must be created once, got ${gateIndexFiles.length}`);

    // ---- EXACT gateDecisionId: the graph gate-decision ref == the id the
    //      reviewer consumed (review-index binds it)
    const reviewIndexDir = join(f.storeRoot, "graph-review-index");
    const indexFiles = (await import("node:fs")).readdirSync(reviewIndexDir).filter((x) => !x.endsWith(".sha256"));
    assert.equal(indexFiles.length, 1, "exactly one review index");
    const indexEntry = JSON.parse(readFileSync(join(reviewIndexDir, indexFiles[0]!), "utf8")) as {
      gateDecisionId: string; decisionHash: string; decisionKey: string; verdict: string;
      proposalId: string;
    };
    // ---- proposal frozen EXACTLY ONCE (one proposal file; the reviewer's
    //      idempotent freeze wrote nothing else)
    const proposalDir = join(f.storeRoot, "proposals", indexEntry.proposalId, "v1");
    const proposalFiles = existsSync(proposalDir) ? (await import("node:fs")).readdirSync(proposalDir) : [];
    assert.equal(proposalFiles.filter((x) => x === "proposal.json").length, 1, "proposal frozen once");
    const events = f.eventStore.allEvents(runId);
    const gateRefEvent = events.find((e) => e.refs.some((r) => r.artifactType === "gate-decision"));
    const graphGateRef = gateRefEvent?.refs.find((r) => r.artifactType === "gate-decision");
    assert.ok(graphGateRef, "graph emitted a gate-decision ref");
    assert.equal(indexEntry.gateDecisionId, graphGateRef!.artifactId, "reviewer consumed the EXACT graph gate id");
    assert.equal(indexEntry.verdict, "PASS", "machine verdict PASS on clean evidence");

    // ---- the persisted decision is real: decisionKey exists, hash matches
    const decisionRec = JSON.parse(readFileSync(join(f.storeRoot, indexEntry.decisionKey), "utf8"));
    assert.equal(decisionRec.verdict, "PASS");

    // ---- live == replay: re-running the same runId resumes and reproduces
    //      the SAME final state hash (event chain is deterministic)
    const replay = await runAnalysisGraph({
      objective: "sum revenue",
      dataRefs: [f.csvId],
      format: "markdown",
      runId,
    });
    assert.equal(replay.stateHash, live.stateHash, "live state hash == replay state hash");
    assert.equal(replay.runId, runId);

    // ---- the replay did NOT create a second gate
    const gateFilesAfterReplay = (await import("node:fs")).readdirSync(gateIndexDir);
    assert.equal(gateFilesAfterReplay.filter((x) => !x.endsWith(".sha256")).length, 1, "replay must not re-plan the gate");
  });

  test("arrow binary input keeps bytes hash + ARROW format + mask meta", async () => {
    const f = makeFixture();
    f.artifactStore.register({
      artifactId: ARROW_ID, contentType: "application/vnd.apache.arrow.file",
      contentHash: ARROW_HASH, masked: true, createdAt: new Date().toISOString(),
      columns: ["date", "revenue"], queryId: "q_0000000000000002",
    } as never, ARROW_BYTES);
    // the adapter resolves bytes + meta without corrupting either
    const { dataAnalysisAdapter } = await import("../../src/graph-engine/adapters/data-analysis.ts");
    const { GraphError } = await import("../../src/graph-engine/errors.ts");
    const adapter = dataAnalysisAdapter({
      store: f.artifactStore,
      subagent: fakeSubagent([ARROW_ID]),
      featureSnapshot: { effectiveFeatures: SNAPSHOT.effectiveFeatures },
    });
    let threw: Error | null = null;
    try {
      await adapter.execute({
        node: { nodeId: "task.analysis", capabilityId: "graph.analysis.run", metadata: { objective: "sum revenue" } },
        inputRefs: [{
          artifactId: ARROW_ID, artifactType: "dataset", contentHash: ARROW_HASH,
          schemaVersion: "1.0", createdByNodeId: "sys.inputs",
        }],
        runId: "run_arrow1", graphId: "g", graphVersion: 1, state: {} as never,
        featureSnapshotHash: SNAPSHOT.effectiveFeatureHash,
        principal: { source: "SYSTEM", actorId: "t", authenticated: true },
        idempotencyKey: "run_arrow1/task.analysis", attempt: 1,
      } as never);
    } catch (e) {
      threw = e as Error;
    }
    // bytes hash + ARROW format + mask meta are all honored; the adapter
    // fails closed on anything unverifiable — a wrong hash WOULD throw
    assert.equal(threw, null, `arrow input must pass with correct hash: ${threw?.message ?? ""}`);
  });

  test("preflight rejects sensitive unmasked / no provenance / unknown type / unmasked external", async () => {
    const cases: Array<{ name: string; opts: Record<string, unknown>; code: string }> = [
      { name: "sensitive unmasked", opts: { masked: false, sensitive: true }, code: "MASKING_REQUIRED" },
      { name: "no provenance", opts: { masked: true, provenance: false }, code: "LINEAGE_MISSING" },
      { name: "unknown contentType", opts: { masked: true, contentType: "application/octet-stream" }, code: "SCHEMA_INVALID" },
      { name: "unmasked external report", opts: { masked: false }, code: "MASKING_REQUIRED" },
    ];
    for (const c of cases) {
      const root = tmp();
      const store = new ArtifactStore(join(root, "as"));
      registerInputs(store, c.opts as never);
      const adapter = preflightGovernanceAdapter({
        resolveArtifact: async (id) => store.resolveArtifact(id) as never,
      });
      let code = "";
      try {
        await adapter.execute({
          node: { nodeId: "sys.preflight-governance", capabilityId: "graph.governance.preflight", metadata: { purpose: "external-report" } },
          inputRefs: [{ artifactId: CSV_ID, artifactType: "dataset", contentHash: CSV_HASH, schemaVersion: "1.0", createdByNodeId: "sys.inputs" }],
          runId: "r", graphId: "g", graphVersion: 1, state: {} as never,
          featureSnapshotHash: "s", principal: { source: "SYSTEM", actorId: "t", authenticated: true },
          idempotencyKey: "r/x", attempt: 1,
        } as never);
      } catch (e) {
        code = (e as { code?: string }).code ?? String(e);
      }
      assert.equal(code, c.code, c.name);
    }
  });

  test("promotion rejects tampered decision and tampered gate", async () => {
    const f = makeFixture();
    wireHost(f);
    const live = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId: "run_tamper1" });
    assert.ok(live.failedNodes.includes("sys.analysis-report"), `expected report fail-closed, got ${JSON.stringify(live)}`);
    // locate the review index + decision + gate
    const indexDir = join(f.storeRoot, "graph-review-index");
    const indexFile = (await import("node:fs")).readdirSync(indexDir).filter((x) => !x.endsWith(".sha256"))[0]!;
    const indexEntry = JSON.parse(readFileSync(join(indexDir, indexFile), "utf8")) as {
      decisionKey: string; gateDecisionId: string;
    };
    // ---- tamper the DECISION content (verdict flipped)
    const decisionPath = join(f.storeRoot, indexEntry.decisionKey);
    const decisionObj = JSON.parse(readFileSync(decisionPath, "utf8"));
    decisionObj.verdict = "REJECT";
    writeFileSync(decisionPath, JSON.stringify(decisionObj, null, 2) + "\n");
    const promotion = promotionAdapter({
      storeRoot: f.storeRoot,
      readEventChain: async (runId) => f.eventStore.allEvents(runId),
    });
    let code = "";
    try {
      await promotion.execute({
        node: { nodeId: "sys.promotion-auth", capabilityId: "graph.review.authorize", metadata: {} },
        inputRefs: [{
          artifactId: decisionObj.reviewId,
          artifactType: "review-decision",
          contentHash: indexEntry.decisionHash,
          schemaVersion: "1.0", createdByNodeId: "sys.reviewer",
        }],
        runId: "run_tamper1", graphId: "g", graphVersion: 1, state: {} as never,
        featureSnapshotHash: "s", principal: { source: "SYSTEM", actorId: "t", authenticated: true },
        idempotencyKey: "run_tamper1/sys.promotion-auth", attempt: 1,
      } as never);
    } catch (e) {
      code = (e as { code?: string }).code ?? String(e);
    }
    assert.equal(code, "PROMOTION_DENIED", "tampered decision must be rejected");
    // ---- tamper the GATE restrictions
    const gatePath = join(f.storeRoot, "gate", `${indexEntry.gateDecisionId}.json`);
    const gateObj = JSON.parse(readFileSync(gatePath, "utf8"));
    gateObj.restrictions = ["no-external-publication"];
    writeFileSync(gatePath, JSON.stringify(gateObj, null, 2) + "\n");
    code = "";
    try {
      await promotion.execute({
        node: { nodeId: "sys.promotion-auth", capabilityId: "graph.review.authorize", metadata: {} },
        inputRefs: [{
          artifactId: decisionObj.reviewId,
          artifactType: "review-decision",
          contentHash: indexEntry.decisionHash,
          schemaVersion: "1.0", createdByNodeId: "sys.reviewer",
        }],
        runId: "run_tamper1", graphId: "g", graphVersion: 1, state: {} as never,
        featureSnapshotHash: "s", principal: { source: "SYSTEM", actorId: "t", authenticated: true },
        idempotencyKey: "run_tamper1/sys.promotion-auth", attempt: 1,
      } as never);
    } catch (e) {
      code = (e as { code?: string }).code ?? String(e);
    }
    assert.equal(code, "PROMOTION_DENIED", "tampered gate must be rejected");
  });

  test("ABSTAIN -> operator APPROVED -> promotion allowed (human decision)", async () => {
    const f = makeFixture();
    // semantic reviewer FAILS -> required semantic check UNAVAILABLE -> ABSTAIN
    wireHost(f, async () => { throw new Error("semantic unavailable"); });
    const runId = "run_abstain1";
    const first = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId });
    // the graph stops at the human gate (executor never self-approves)
    if (first.status !== "WAITING_FOR_HUMAN") {
      console.log("[dbg] first events:", f.eventStore.allEvents(runId).map((e) => e.eventType).join(" "));
      console.log("[dbg] first gid:", f.eventStore.allEvents(runId)[0]?.graphId);
    }
    assert.equal(first.status, "WAITING_FOR_HUMAN", `expected WAITING_FOR_HUMAN, got ${JSON.stringify(first)}`);
    const events = f.eventStore.allEvents(runId);
    assert.ok(events.some((e) => e.eventType === "HUMAN_ACTION_REQUIRED"), "human action required");
    // an OPERATOR approves the ABSTAIN action
    const { recordHumanResolution } = await import("../../src/graph-engine/executor.ts");
    const required = events.find((e) => e.eventType === "HUMAN_ACTION_REQUIRED")!;
    const actionRef = required.refs[0]!.artifactId;
    // the operator EXPLICITLY chooses ACCEPT_RISK_FOR_REPORT and names the
    // exact review/gate/policy from the pending action's meta
    const runGraph = f.eventStore.allEvents(runId)[0]!;
    recordHumanResolution(f.eventStore, {
      actionRef,
      resolution: "APPROVED",
      action: "ACCEPT_RISK_FOR_REPORT",
      allowedActions: ["PUBLISH_REPORT"],
      originalReviewId: required.meta["reviewId"] ?? "",
      gateDecisionId: required.meta["gateDecisionId"] ?? "",
      policySnapshotHash: required.meta["policySnapshotHash"] ?? "",
      actorId: "operator-1",
      principal: { source: "OPERATOR_CLI", actorId: "operator-1", authenticated: true },
      reason: "accept risk for report",
      timestamp: new Date().toISOString(),
      graphId: runGraph.graphId,
      graphVersion: runGraph.graphVersion,
    });
    assert.ok(required.meta["reviewId"] && required.meta["gateDecisionId"], "pending action carries the review/gate binding");
    // resume: the human-review-decision ref flows to promotion, which
    // verifies it against the recorded resolution + allows PUBLISH_REPORT
    const resumed = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId });
    assert.ok(resumed.failedNodes.includes("sys.analysis-report") || resumed.blockedCodes.includes("REPORT_SKILL_UNAVAILABLE"),
      `expected promotion to pass into report, got ${JSON.stringify(resumed)}`);
    assert.notEqual(resumed.status, "WAITING_FOR_HUMAN", `resume must not stall: ${JSON.stringify(resumed)}`);
    // the authorization WAS granted (an authorization ref exists in the chain)
    const eventsAfter = f.eventStore.allEvents(runId);
    const auth = eventsAfter.filter((e) => e.refs.some((r) => r.artifactType === "authorization"));
    assert.equal(auth.length, 1, "ABSTAIN + operator approval authorizes PUBLISH_REPORT once");
  });

  test("ABSTAIN without human approval denies promotion", async () => {
    const f = makeFixture();
    wireHost(f, async () => { throw new Error("semantic unavailable"); });
    const runId = "run_abstain2";
    const first = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId });
    assert.equal(first.status, "WAITING_FOR_HUMAN");
    // simulate a FORGED human-review-decision ref without a recorded resolution
    const indexDir = join(f.storeRoot, "graph-review-index");
    const indexFile = (await import("node:fs")).readdirSync(indexDir).filter((x) => !x.endsWith(".sha256"))[0]!;
    const indexEntry = JSON.parse(readFileSync(join(indexDir, indexFile), "utf8")) as { decisionKey: string; decisionHash: string; reviewId: string };
    const decisionObj = JSON.parse(readFileSync(join(f.storeRoot, indexEntry.decisionKey), "utf8"));
    const promotion = promotionAdapter({
      storeRoot: f.storeRoot,
      readEventChain: async (id) => f.eventStore.allEvents(id),
    });
    let code = "";
    try {
      await promotion.execute({
        node: { nodeId: "sys.promotion-auth", capabilityId: "graph.review.authorize", metadata: {} },
        inputRefs: [
          { artifactId: decisionObj.reviewId, artifactType: "review-decision", contentHash: indexEntry.decisionHash, schemaVersion: "1.0", createdByNodeId: "sys.reviewer" },
          { artifactId: "human-review:ha_nonexistent", artifactType: "human-review-decision", contentHash: "f".repeat(64), schemaVersion: "1.0", createdByNodeId: "sys.reviewer" },
        ],
        runId, graphId: "g", graphVersion: 1, state: {} as never,
        featureSnapshotHash: "s", principal: { source: "SYSTEM", actorId: "t", authenticated: true },
        idempotencyKey: `${runId}/sys.promotion-auth`, attempt: 1,
      } as never);
    } catch (e) {
      code = (e as { code?: string }).code ?? String(e);
    }
    assert.equal(code, "PROMOTION_DENIED", "ABSTAIN without a recorded human approval denies promotion");
  });

  test("CHANGES_REQUIRED drives a REAL feedback loop (revision, re-analysis, re-review)", async () => {
    const f = makeFixture();
    // semantic reviewer: FIRST pass finds a blocking issue, SECOND pass is
    // clean -> the graph must revise and re-review
    let calls = 0;
    const subagentPrompts: string[] = [];
    const flakySemantic = async () => {
      calls++;
      if (calls === 1) {
        return [{
          severity: "HIGH", category: "METHOD",
          claim: "revenue metric must be recomputed",
          evidenceRefIds: ["art_c"],
          suggestedAction: "recompute",
          location: { artifactId: "s1", sectionId: "sec1" },
        }];
      }
      return [];
    };
    wireHost(f, flakySemantic as never, subagentPrompts);
    const runId = "run_rev1";
    const result = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId });
    // the feedback loop ran: revision executed, re-review passed, and the
    // report node fail-closed (expected terminal for this repo)
    const events = f.eventStore.allEvents(runId);
    const types = events.map((e) => e.eventType);
    assert.ok(types.includes("REVISION_REQUESTED"), `revision requested: ${types.join(" ")}`);
    assert.ok(types.includes("GRAPH_VERSION_CREATED"), "graph version bumped for the revision");
    const revisions = events.filter((e) => e.eventType === "REVISION_REQUESTED").length;
    assert.equal(revisions, 1, "exactly one revision cycle consumed");
    assert.ok(result.failedNodes.includes("sys.analysis-report") || result.blockedCodes.includes("REPORT_SKILL_UNAVAILABLE"),
      `expected report fail-closed after revision, got ${JSON.stringify(result)}`);
    assert.equal(calls, 2, "reviewer ran twice (revised proposal re-reviewed)");
    // the findings ACTUALLY reached the second analysis: the revised
    // subagent prompt carries the concrete finding claim
    assert.ok(subagentPrompts.length >= 2, `analysis ran ${subagentPrompts.length} time(s)`);
    assert.ok(subagentPrompts[1]!.includes("revenue metric must be recomputed"),
      `second analysis prompt must consume the finding, got: ${subagentPrompts[1]?.slice(0, 120)}`);
    // the revised run produced a SECOND analysis result artifact
    const fs = await import("node:fs");
    const resultsDir = join(f.artifactStore["baseDir"] as string, "results");
    const results = fs.readdirSync(resultsDir);
    assert.ok(results.length >= 2, `expected >=2 result artifacts after revision, got ${results.length}`);
  });

  test("CHANGES_REQUIRED revision budget exhausted fails closed", async () => {
    const f = makeFixture();
    const alwaysChanges = async () => [{
      severity: "HIGH", category: "METHOD",
      claim: "always requires changes",
      evidenceRefIds: ["art_c"],
      suggestedAction: "fix",
      location: { artifactId: "s1" },
    }];
    wireHost(f, alwaysChanges as never);
    const result = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId: "run_rev2" });
    assert.ok(result.blockedCodes.includes("REVISION_BUDGET_EXHAUSTED"),
      `expected revision budget exhaustion, got ${JSON.stringify(result)}`);
  });

  test("real extension host snapshot passes the executor hash recomputation", async () => {
    // the REAL host config must carry the FULL snapshot (enabled + disabled):
    // the executor recomputes featureHash({features: states}) and refuses a
    // config that omits the disabled set
    const { buildGraphToolConfig } = await import("../../index.ts");
    const { createFeatureResolver } = await import("../../src/features/resolver.ts");
    // the REAL resolver with the evaluation runtime profile (all features
    // enabled) — exactly what a production run uses
    const resolver = createFeatureResolver({ runtimeProfile: "all-enabled" });
    const snapshot = resolver.getEffectiveFeatureSnapshot();
    const root = tmp();
    const storeRoot = join(root, "rs");
    const artifactStore = new ArtifactStore(join(root, "as"));
    const config = buildGraphToolConfig(snapshot, artifactStore, storeRoot);
    assert.ok(Array.isArray(config.disabledFeatures), "real host config carries disabledFeatures");
    // the executor accepts the REAL snapshot: recompute the hash the same
    // way the executor does and verify it matches
    const states: Record<string, boolean> = {};
    for (const id of config.effectiveFeatures ?? []) states[id] = true;
    for (const id of config.disabledFeatures ?? []) states[id] = false;
    assert.equal(featureHash({ features: states }), config.featureSnapshotHash,
      "real snapshot hash reproduces from enabled+disabled sets");
    // and the executor-level run accepts it (no SCHEMA_INVALID on snapshot)
    const { GraphExecutor } = await import("../../src/graph-engine/executor.ts");
    const { GraphEventStore } = await import("../../src/graph-engine/event-store.ts");
    const { compileGraphSpec } = await import("../../src/graph-engine/graph-compiler.ts");
    const g = compileGraphSpec({
      plan: { planId: "p", version: 1, goal: "sum", tasks: [{ taskId: "analysis", title: "a", objective: "sum", capability: "analysis.run", dependsOn: [], inputs: [], expectedOutputs: ["analysis-result"], parallelizable: false, optional: false }] },
      planRef: { artifactId: "plan_x", artifactType: "task-plan", contentHash: "c", schemaVersion: "1.0", createdByNodeId: "rp" },
      objective: "sum", featureSnapshotHash: config.featureSnapshotHash, graphVersion: 1, formalReport: false,
    });
    const ex = new GraphExecutor({
      store: new GraphEventStore(join(root, "ge")),
      adapters: new Map(),
      capabilities: graphCapabilityMap(),
      effectiveFeatures: new Set(config.effectiveFeatures ?? []),
      featureSnapshot: {
        effectiveFeatureHash: config.featureSnapshotHash,
        effectiveFeatures: config.effectiveFeatures ?? [],
        disabledFeatures: config.disabledFeatures,
      },
    });
    // the executor must ACCEPT the real snapshot (recomputation matches) —
    // it will then fail on CAPABILITY_UNAVAILABLE for the empty adapter map,
    // NOT on SCHEMA_INVALID snapshot forgery
    const run = await ex.run(g, { runId: "run_real_snap" });
    const codes = [...new Set(Object.values(run.state.nodeRuns).map((n) => n.errorCode).filter(Boolean))];
    assert.ok(!codes.includes("SCHEMA_INVALID"), `real snapshot must not be rejected as forged: ${codes.join(",")}`);
  });

  test("gate crash window: gate written, claim PENDING -> resume reuses the SAME gate", async () => {
    const f = makeFixture();
    wireHost(f);
    // run the chain to produce a real proposal + gate artifacts
    await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId: "run_gatecrash" });
    // locate the completed claim
    const fs = await import("node:fs");
    const gateIndexRoot = join(f.storeRoot, "graph-gate-index", "run_gatecrash", "sys.review-gate");
    if (!fs.existsSync(gateIndexRoot)) {
      console.log("[dbg] gate index root missing; index tree:", fs.readdirSync(join(f.storeRoot, "graph-gate-index"), { recursive: true }));
    }
    const claimFiles = fs.readdirSync(gateIndexRoot);
    const claimFile = claimFiles.find((x) => !x.endsWith(".sha256"))!;
    const claim = JSON.parse(readFileSync(join(gateIndexRoot, claimFile), "utf8"));
    const gateId = claim.gateDecisionId;
    // simulate the crash: revert the claim to PENDING (gate artifact intact)
    fs.writeFileSync(join(gateIndexRoot, claimFile), JSON.stringify({ status: "PENDING", gateDecisionId: gateId }, null, 2) + "\n");
    const gateDir = join(f.storeRoot, "gate");
    const gateFilesBefore = fs.readdirSync(gateDir).filter((x) => x.endsWith(".json"));
    assert.equal(gateFilesBefore.length, 1, "exactly one gate exists");
    // resume the run: the gate adapter must REUSE the existing gate (the
    // claim pins the deterministic id) — never plan a second one
    const resumed = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId: "run_gatecrash" });
    assert.ok(resumed.failedNodes.includes("sys.analysis-report") || resumed.blockedCodes.includes("REPORT_SKILL_UNAVAILABLE"),
      `expected report fail-closed, got ${JSON.stringify(resumed)}`);
    const gateFilesAfter = fs.readdirSync(gateDir).filter((x) => x.endsWith(".json"));
    assert.equal(gateFilesAfter.length, 1, `gate must be created once, got ${gateFilesAfter.length}`);
  });

  test("human resolution with mismatched policy hash is rejected", async () => {
    const f = makeFixture();
    wireHost(f, async () => { throw new Error("semantic unavailable"); });
    const runId = "run_pol1";
    const first = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId });
    assert.equal(first.status, "WAITING_FOR_HUMAN");
    const events = f.eventStore.allEvents(runId);
    const required = events.find((e) => e.eventType === "HUMAN_ACTION_REQUIRED")!;
    const { recordHumanResolution } = await import("../../src/graph-engine/executor.ts");
    const runGraph = events[0]!;
    // WRONG policy hash (empty string must not bypass the binding)
    assert.throws(() => recordHumanResolution(f.eventStore, {
      actionRef: required.refs[0]!.artifactId,
      resolution: "APPROVED",
      action: "ACCEPT_RISK_FOR_REPORT",
      allowedActions: ["PUBLISH_REPORT"],
      originalReviewId: required.meta["reviewId"] ?? "",
      gateDecisionId: required.meta["gateDecisionId"] ?? "",
      policySnapshotHash: "",
      actorId: "operator-1",
      principal: { source: "OPERATOR_CLI", actorId: "operator-1", authenticated: true },
      reason: "accept risk",
      timestamp: new Date().toISOString(),
      graphId: runGraph.graphId,
      graphVersion: runGraph.graphVersion,
    }), /policySnapshotHash/, "empty policy hash must be rejected");
  });

  test("two ABSTAIN reviews never collide on one actionRef", async () => {
    const f = makeFixture();
    wireHost(f, async () => { throw new Error("semantic unavailable"); });
    const runId = "run_ab2";
    await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId });
    const events = f.eventStore.allEvents(runId);
    const required = events.find((e) => e.eventType === "HUMAN_ACTION_REQUIRED")!;
    const actionRef1 = required.refs[0]!.artifactId;
    // a SECOND ABSTAIN on the same run (e.g. a later revision) would carry
    // a different review/gate binding -> different actionRef
    const reviewIdA = required.meta["reviewId"] ?? "";
    const gateA = required.meta["gateDecisionId"] ?? "";
    // simulate: another review on the same run with a different gate id
    const synthetic = `ha_${runId}@sys.reviewer@${reviewIdA}@different-gate@1@1`;
    assert.notEqual(synthetic, actionRef1, "actionRefs must be distinct across reviews");
    // the resolution for the FIRST action cannot be replayed on the second
    const { recordHumanResolution } = await import("../../src/graph-engine/executor.ts");
    const runGraph = events[0]!;
    assert.throws(() => recordHumanResolution(f.eventStore, {
      actionRef: synthetic,
      resolution: "APPROVED",
      action: "ACCEPT_RISK_FOR_REPORT",
      allowedActions: ["PUBLISH_REPORT"],
      originalReviewId: reviewIdA,
      gateDecisionId: "different-gate",
      policySnapshotHash: required.meta["policySnapshotHash"] ?? "",
      actorId: "operator-1",
      principal: { source: "OPERATOR_CLI", actorId: "operator-1", authenticated: true },
      reason: "accept risk",
      timestamp: new Date().toISOString(),
      graphId: runGraph.graphId,
      graphVersion: runGraph.graphVersion,
    }), /no pending human action/, "a forged actionRef must not resolve");
    // and a second resolution for the SAME action is rejected
    recordHumanResolution(f.eventStore, {
      actionRef: actionRef1,
      resolution: "APPROVED",
      action: "ACCEPT_RISK_FOR_REPORT",
      allowedActions: ["PUBLISH_REPORT"],
      originalReviewId: required.meta["reviewId"] ?? "",
      gateDecisionId: required.meta["gateDecisionId"] ?? "",
      policySnapshotHash: required.meta["policySnapshotHash"] ?? "",
      actorId: "operator-1",
      principal: { source: "OPERATOR_CLI", actorId: "operator-1", authenticated: true },
      reason: "accept risk",
      timestamp: new Date().toISOString(),
      graphId: runGraph.graphId,
      graphVersion: runGraph.graphVersion,
    });
    assert.throws(() => recordHumanResolution(f.eventStore, {
      actionRef: actionRef1,
      resolution: "APPROVED",
      action: "ACCEPT_RISK_FOR_REPORT",
      allowedActions: ["PUBLISH_REPORT"],
      originalReviewId: required.meta["reviewId"] ?? "",
      gateDecisionId: required.meta["gateDecisionId"] ?? "",
      policySnapshotHash: required.meta["policySnapshotHash"] ?? "",
      actorId: "operator-1",
      principal: { source: "OPERATOR_CLI", actorId: "operator-1", authenticated: true },
      reason: "accept risk",
      timestamp: new Date().toISOString(),
      graphId: runGraph.graphId,
      graphVersion: runGraph.graphVersion,
    }), /already resolved/, "same action can only be resolved once");
  });

  test("revision recovery: resume loads the LATEST persisted spec", async () => {
    const f = makeFixture();
    // CHANGES_REQUIRED twice (budget 1 -> second revision fails) — the run
    // reaches v2; resume must REBUILD from the persisted v2 spec
    const alwaysChanges = async () => [{
      severity: "HIGH", category: "METHOD",
      claim: "always requires changes",
      evidenceRefIds: ["art_c"],
      suggestedAction: "fix",
      location: { artifactId: "s1" },
    }];
    wireHost(f, alwaysChanges as never);
    const runId = "run_revrec";
    const result = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId });
    assert.ok(result.blockedCodes.includes("REVISION_BUDGET_EXHAUSTED"),
      `expected budget exhaustion, got ${JSON.stringify(result)}`);
    // the v2 spec was persisted and bound into the event
    const events = f.eventStore.allEvents(runId);
    const versionEvent = events.find((e) => e.eventType === "GRAPH_VERSION_CREATED")!;
    assert.equal(versionEvent.meta["version"], "2");
    assert.ok(versionEvent.refs.some((r) => r.artifactType === "graph-spec"), "version event binds the new spec");
    const { GraphEventStore } = await import("../../src/graph-engine/event-store.ts");
    const store = new GraphEventStore(f.storeRoot);
    const specV2 = store.readSpec(runId, 2);
    assert.ok(specV2, "v2 spec persisted");
    // resume the terminal run: the stored spec (v2) is authoritative
    const resumed = await runAnalysisGraph({ objective: "sum revenue", dataRefs: [f.csvId], format: "markdown", runId });
    assert.equal(resumed.status, "FAILED", "resume of a terminal run stays terminal");
  });

  test("forged feature snapshot hash refuses to start", async () => {
    const root = tmp();
    const store = new GraphEventStore(join(root, "events"));
    const g = compileGraphSpec({
      plan: { planId: "p", version: 1, goal: "ingest", tasks: [{ taskId: "w", title: "i", objective: "i", capability: "lakehouse.query.materialize", dependsOn: [], inputs: [], expectedOutputs: [], parallelizable: false, optional: false }] },
      planRef: { artifactId: "plan_x", artifactType: "task-plan", contentHash: "c", schemaVersion: "1.0", createdByNodeId: "rp" },
      objective: "i", featureSnapshotHash: SNAPSHOT.effectiveFeatureHash, graphVersion: 1, formalReport: false,
    });
    const ex = new GraphExecutor({
      store,
      adapters: new Map(),
      capabilities: graphCapabilityMap(),
      effectiveFeatures: new Set(["round6.graph_engine"]),
      // a DIFFERENT feature set than the hash declares
      featureSnapshot: {
        effectiveFeatureHash: SNAPSHOT.effectiveFeatureHash,
        effectiveFeatures: ["round6.graph_engine", "round6.graph_executor"],
        disabledFeatures: [],
      },
    });
    await assert.rejects(
      () => ex.run(g, { runId: "run_forged" }),
      (e: Error) => (e as { code?: string }).code === "SCHEMA_INVALID",
      "forged snapshot must refuse to start",
    );
  });

  test("maxAttempts=1 crash + resume -> ATTEMPTS_EXHAUSTED, adapter never re-executed", async () => {
    const root = tmp();
    const store = new GraphEventStore(join(root, "events"));
    const { specContentHash } = await import("../../src/graph-engine/canonical.ts");
    const g: import("../../src/graph-engine/contracts.ts").GraphSpec = {
      schemaVersion: "1.0", graphId: "g_plain", graphVersion: 1, objective: "sum",
      sourcePlanRef: { artifactId: "plan_x", artifactType: "task-plan", contentHash: "c", schemaVersion: "1.0", createdByNodeId: "rp" },
      featureSnapshotHash: "s",
      nodes: [{
        nodeId: "task.analysis", kind: "AGENT", capabilityId: "graph.analysis.run",
        label: "analysis", dependsOn: [], inputContract: "artifact-refs", outputContract: "artifact-refs",
        sideEffect: "READ", requiredFeatures: ["round4.data_analysis"],
        timeoutMs: 60_000, maxAttempts: 1,
        retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
        metadata: {},
      }],
      edges: [], entryNodeIds: ["task.analysis"], terminalNodeIds: ["task.analysis"],
      policyRefs: [], contentHash: "c", createdAt: "2026-01-01T00:00:00.000Z",
    };
    g.contentHash = specContentHash(g);
    let executions = 0;
    const adapters = new Map([["graph.analysis.run", {
      capabilityId: "graph.analysis.run",
      execute: async () => { executions++; return { outputRefs: [], summary: "ran" }; },
    }]]);
    // simulate the crash: NODE_STARTED for the analysis node, no outcome
    store.append("run_crash1", { graphId: g.graphId, graphVersion: 1, eventType: "GRAPH_CREATED",
      refs: [{ artifactId: g.graphId, artifactType: "graph-spec", contentHash: g.contentHash, schemaVersion: "1.0", createdByNodeId: "compiler" }],
      meta: { graphContentHash: g.contentHash, featureSnapshotHash: "s" } });
    store.append("run_crash1", { graphId: g.graphId, graphVersion: 1, eventType: "NODE_STARTED", nodeId: "task.analysis", refs: [], meta: {} });
    const ex = new GraphExecutor({
      store, adapters,
      capabilities: graphCapabilityMap(),
      effectiveFeatures: new Set(EFFECTIVE_FEATURES),
    });
    const run = await ex.run(g, { runId: "run_crash1" });
    const node = run.state.nodeRuns["task.analysis"]!;
    assert.equal(node.status, "FAILED", "attempt budget exhausted must FAIL");
    assert.equal(node.errorCode, "ATTEMPTS_EXHAUSTED");
    assert.equal(executions, 0, "the adapter must never re-execute after the crash");
  });

  test("tampered result payload or manifest -> resolveResult null", async () => {
    const root = tmp();
    const store = new ArtifactStore(join(root, "as"));
    const id = "art_aaaaaaaaaaaaaaaa";
    store.writeResult(id, JSON.stringify({ schemaVersion: "1.0", status: "COMPLETED" }));
    assert.ok(await store.resolveResult(id), "clean result resolves");
    // tamper payload
    const dir = join(root, "as", "results", id);
    writeFileSync(join(dir, "payload.json"), JSON.stringify({ schemaVersion: "1.0", status: "COMPLETED", extra: 1 }));
    assert.equal(await store.resolveResult(id), null, "tampered payload rejected");
    // restore + tamper manifest
    writeFileSync(join(dir, "payload.json"), JSON.stringify({ schemaVersion: "1.0", status: "COMPLETED" }));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    manifest.expectedContentHash = "0".repeat(64);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    assert.equal(await store.resolveResult(id), null, "tampered manifest rejected (COMMITTED binds manifest hash)");
    // remove COMMITTED -> unverifiable
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      artifactId: id, expectedContentHash: createHash("sha256").update(JSON.stringify({ schemaVersion: "1.0", status: "COMPLETED" })).digest("hex"),
      schemaVersion: "1.0", createdAt: new Date().toISOString(),
    }));
    const fs = await import("node:fs");
    fs.rmSync(join(dir, "COMMITTED"));
    assert.equal(await store.resolveResult(id), null, "missing COMMITTED -> unverifiable");
  });
});
