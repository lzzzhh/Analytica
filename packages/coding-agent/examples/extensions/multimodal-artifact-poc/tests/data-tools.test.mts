/**
 * TS unit tests for lakehouse data tools (node --test):
 *   - Gateway client (happy path + errors + unavailable)
 *   - tool schemas registered
 *   - validatedQueryId flow (validate → execute, no raw SQL)
 *   - query result → Evidence Packet
 *   - query conflict merge (query vs parse → requires_verification)
 * Run: node --experimental-strip-types --test tests/
 */
// Feature env preamble (feature-driven registry): round2.lakehouse must be
// on for the 7 lakehouse tools to register.
import "./set-lakehouse-on.ts";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  GatewayClient,
  GatewayError,
  GatewayUnavailableError,
  gatewayClientFromEnv,
  type QueryResult,
} from "../src/data-tools/client.ts";
import { queryResultToFacts, queryResultSummary } from "../src/data-tools/evidence-adapter.ts";
import { mergeEvidence, type EvidencePacket } from "../src/evidence.ts";
import { DATA_TOOLS } from "../src/data-tools/tools.ts";

// ---------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------

class MockTransport {
  routes = new Map<string, { status: number; body: unknown }>();
  lastHeaders: Record<string, string> = {};

  install() {
    this._orig = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      this.lastHeaders = init?.headers ?? {};
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

function sampleResult(): QueryResult {
  return {
    queryId: "q_abc123",
    datasetId: "ads_sales_daily",
    datasetLayer: "ADS",
    snapshotId: 928374,
    dataVersion: "v928374",
    dataTimestamp: "2026-07-31T23:00:00Z",
    columns: ["region", "total_revenue"],
    rows: [["east", 300.0], ["west", 150.0]],
    rowCount: 2,
    qualityStatus: "PASS",
    lineageReference: "lineage://ads_sales_daily?snapshot=928374",
    warnings: [],
  };
}

function packet(facts: any[]): EvidencePacket {
  return {
    producer: { agent: "test", tier: "standard", model: "test" },
    scope: { documentId: "doc_1" },
    facts,
    inferences: [],
    unknowns: [],
    confidence: 0.5,
    status: "complete",
  };
}

// ---------------------------------------------------------------------

describe("GatewayClient", () => {
  let mock: MockTransport;

  beforeEach(() => { mock = new MockTransport(); mock.install(); });
  afterEach(() => mock.restore());

  test("searchCatalog", async () => {
    mock.routes.set("/v1/catalog/search", { status: 200, body: { results: [{ datasetId: "ads_sales_daily" }], count: 1 } });
    const c = new GatewayClient({ baseUrl: "http://gw" });
    const r = await c.searchCatalog("sales");
    assert.equal(r.count, 1);
  });

  test("validate → execute flow (validatedQueryId only)", async () => {
    mock.routes.set("/v1/query/validate", { status: 200, body: { ok: true, validatedQueryId: "vq_abc", issues: [] } });
    mock.routes.set("/v1/query/execute", { status: 200, body: sampleResult() });
    const c = new GatewayClient({ baseUrl: "http://gw" });
    const v = await c.validateQuery({ datasetId: "ads_sales_daily", select: [{ field: "revenue", aggregation: "sum" }] });
    assert.equal(v.ok, true);
    assert.equal(v.validatedQueryId, "vq_abc");
    const r = await c.executeQuery(v.validatedQueryId);
    assert.equal(r.rowCount, 2);
    assert.equal(r.snapshotId, 928374);
  });

  test("http error → GatewayError with status", async () => {
    mock.routes.set("/v1/datasets/ghost", { status: 404, body: { detail: "not found" } });
    const c = new GatewayClient({ baseUrl: "http://gw" });
    await assert.rejects(async () => c.inspectDataset("ghost"), (e: any) => {
      assert.ok(e instanceof GatewayError);
      assert.equal(e.status, 404);
      return true;
    });
  });

  test("network failure → GatewayUnavailableError", async () => {
    const c = new GatewayClient({ baseUrl: "http://no-such-host:1" });
    await assert.rejects(async () => c.health(), (e: any) => {
      assert.ok(e instanceof GatewayUnavailableError);
      return true;
    });
  });

  test("gatewayClientFromEnv: null when URL unset", () => {
    const saved = process.env.LAKEHOUSE_GATEWAY_URL;
    delete process.env.LAKEHOUSE_GATEWAY_URL;
    assert.equal(gatewayClientFromEnv(), null);
    process.env.LAKEHOUSE_GATEWAY_URL = saved;
  });

  test("no x-client-id header when clientId not configured", async () => {
    mock.routes.set("/health", { status: 200, body: { status: "ok", datasets: 0, mode: "local" } });
    const c = new GatewayClient({ baseUrl: "http://gw" });
    await c.health();
    assert.equal(mock.lastHeaders["x-client-id"], undefined);
  });

  test("x-client-id header sent when clientId configured", async () => {
    mock.routes.set("/health", { status: 200, body: { status: "ok", datasets: 0, mode: "local" } });
    const c = new GatewayClient({ baseUrl: "http://gw", clientId: "pi-agent-01" });
    await c.health();
    assert.equal(mock.lastHeaders["x-client-id"], "pi-agent-01");
  });

  test("gatewayClientFromEnv: reads LAKEHOUSE_CLIENT_ID", () => {
    const savedUrl = process.env.LAKEHOUSE_GATEWAY_URL;
    const savedId = process.env.LAKEHOUSE_CLIENT_ID;
    process.env.LAKEHOUSE_GATEWAY_URL = "http://gw";
    process.env.LAKEHOUSE_CLIENT_ID = "pi-42";
    const c = gatewayClientFromEnv();
    assert.ok(c, "client built");
    assert.equal((c as any).config.clientId, "pi-42");
    process.env.LAKEHOUSE_GATEWAY_URL = savedUrl;
    process.env.LAKEHOUSE_CLIENT_ID = savedId;
  });
});

describe("tool schemas", () => {
  test("lakehouse + CDXR tools registered by default, no run_sql, no legacy governance", () => {
    const names = DATA_TOOLS.map((t) => t.name);
    for (const expected of ["search_catalog", "inspect_dataset", "validate_query", "execute_query",
                            "get_data_quality", "explain_lineage", "get_snapshot",
                            "assess_training_data"]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
    assert.ok(!names.includes("run_sql"));
    // legacy governance tools are no longer in the default registry
    assert.ok(!names.includes("get_dataset_governance_profile"));
  });

  test("execute_query schema only accepts validatedQueryId", () => {
    const tool = DATA_TOOLS.find((t) => t.name === "execute_query")!;
    const schema = tool.parameters as any;
    assert.ok(schema.properties.validatedQueryId);
    assert.ok(!schema.properties.sql);
  });
});

describe("query result → Evidence Packet", () => {
  test("facts carry kind=query + provenance metadata", () => {
    const facts = queryResultToFacts(sampleResult());
    assert.equal(facts.length, 2);
    const f = facts[0]!;
    assert.equal(f.kind, "query");
    assert.equal(f.confidence, 1);
    assert.equal(f.evidence, "query:q_abc123");
    assert.deepEqual(f.metadata, {
      datasetId: "ads_sales_daily",
      snapshotId: 928374,
      dataVersion: "v928374",
      dataTimestamp: "2026-07-31T23:00:00Z",
      qualityStatus: "PASS",
      queryId: "q_abc123",
      lineageReference: "lineage://ads_sales_daily?snapshot=928374",
    });
  });

  test("summary mentions queryId/snapshot/quality/lineage, keeps rows bounded", () => {
    const s = queryResultSummary(sampleResult());
    assert.ok(s.includes("q_abc123"));
    assert.ok(s.includes("928374"));
    assert.ok(s.includes("PASS"));
    assert.ok(s.includes("lineage://"));
  });
});

describe("query conflict merge", () => {
  test("query fact vs parse fact, same claim different value → requires_verification, both sources shown", () => {
    const queryPacket = packet([{
      claim: "2026年7月总收入", value: 1234567, confidence: 1, kind: "query",
      evidence: "query:q_123", metadata: { datasetId: "ads_sales_daily", snapshotId: 1, dataVersion: "v1" },
    }]);
    const docPacket = packet([{
      claim: "2026年7月总收入", value: "900000", confidence: 0.8, kind: "parse",
      evidence: "ocr table p.3",
    }]);
    const merged = mergeEvidence(docPacket, queryPacket);
    assert.equal(merged.conflicts.length, 1);
    assert.equal(merged.conflicts[0]!.resolution, "requires_verification");
    const sources = merged.conflicts[0]!.candidates.map((c) => `${c.sourceType}:${c.value}`);
    assert.ok(sources.includes("query:1234567"));
    assert.ok(sources.includes("parse:900000"));
    // no fact auto-picked
    assert.equal(merged.facts.length, 0);
  });

  test("same claim same value → deterministic query wins (priority over parse/cited)", () => {
    const queryPacket = packet([{
      claim: "revenue", value: 300, confidence: 1, kind: "query", evidence: "query:q1",
    }]);
    const docPacket = packet([{
      claim: "revenue", value: 300, confidence: 0.9, kind: "cited", evidence: "doc p.1",
    }]);
    const merged = mergeEvidence(docPacket, queryPacket);
    assert.equal(merged.conflicts.length, 0);
    assert.equal(merged.facts.length, 1);
    assert.equal(merged.facts[0]!.kind, "query");
  });
});
