/**
 * TS unit tests for CDXR on-demand training assessment (default: tool OFF).
 *
 *   - assessTrainingData client method POSTs the structured request
 *   - result contract (status/findings/rawRowsReturned) maps through
 *   - assess_training_data is NOT registered by default
 *   - tool execution renders a bounded summary (no raw rows) and never throws
 *   - ordinary lakehouse tools are unaffected
 * Run: node --experimental-strip-types --test tests/
 */
// Feature env preamble (feature-driven registry): round2.lakehouse must be
// on for the 7 lakehouse tools to register; round3.cdxr_training stays off
// (default) so assess_training_data must NOT be registered.
import "./set-lakehouse-on.ts";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  GatewayClient,
  type TrainingAssessmentResult,
} from "../src/data-tools/client.ts";
import {
  ASSESS_TRAINING_DATA_TOOL,
  DATA_TOOLS,
  type TrainingAssessmentParams,
} from "../src/data-tools/tools.ts";

class MockTransport {
  routes = new Map<string, { status: number; body: unknown }>();
  install() {
    this._orig = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
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

function sampleResult(): TrainingAssessmentResult {
  return {
    assessmentId: "ast_abc123",
    datasetId: "dws.dws_sales_daily",
    snapshotId: 42,
    purpose: "model_training",
    status: "REVIEW",
    summary: "assessment ast_abc123: REVIEW — 2 finding(s)",
    checkedFields: ["orders", "revenue", "region"],
    ruleVersion: "cdxr-training.v1",
    checkedAt: "2026-08-01T10:00:00Z",
    rawRowsReturned: false,
    warnings: [],
    findings: [
      {
        code: "SAMPLE_SIZE",
        severity: "HIGH",
        field: null,
        message: "sample size below the configured minimum",
        observed: "row_count=4",
        expected: "row_count >= 1000",
      },
      {
        code: "FEATURE_MISSINGNESS",
        severity: "MEDIUM",
        field: "revenue",
        message: "feature missing rate exceeds the configured threshold",
        observed: "missing_rate=0.250",
      },
    ],
  };
}

const sampleParams: TrainingAssessmentParams = {
  datasetId: "dws.dws_sales_daily",
  targetField: "orders",
  featureFields: ["revenue", "region"],
  predictionTimeField: "event_date",
};

describe("assessTrainingData client method", () => {
  beforeEach(() => {
    mock.routes.set("/v1/cdxr/training-assessments", { status: 200, body: sampleResult() });
    mock.install();
  });
  afterEach(() => mock.restore());

  test("POSTs the structured request and maps the result contract", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      seenUrl = String(input);
      seenBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => sampleResult(),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    try {
      const c = new GatewayClient({ baseUrl: "http://test", clientId: "pi-7" });
      const res = await c.assessTrainingData({
        datasetId: "dws.dws_sales_daily",
        targetField: "orders",
        featureFields: ["revenue", "region"],
        predictionTimeField: "event_date",
        snapshotId: 42,
        sensitiveFieldPolicy: "review",
      });
      assert.equal(seenUrl, "http://test/v1/cdxr/training-assessments");
      assert.deepEqual(seenBody, {
        datasetId: "dws.dws_sales_daily",
        targetField: "orders",
        featureFields: ["revenue", "region"],
        predictionTimeField: "event_date",
        snapshotId: 42,
        sensitiveFieldPolicy: "review",
      });
      assert.equal(res.status, "REVIEW");
      assert.equal(res.rawRowsReturned, false);
      assert.equal(res.findings.length, 2);
      assert.equal(res.findings[0]!.code, "SAMPLE_SIZE");
      assert.equal(res.checkedFields.length, 3);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("gateway failure surfaces as GatewayUnavailableError", async () => {
    mock.restore();
    const c = new GatewayClient({ baseUrl: "http://down" });
    await assert.rejects(
      () => c.assessTrainingData({ datasetId: "x", targetField: "y", featureFields: ["z"] }),
      /gateway unavailable/i,
    );
  });
});

describe("assess_training_data tool (default: flag off)", () => {
  beforeEach(() => {
    process.env.LAKEHOUSE_GATEWAY_URL = "http://test";
  });
  afterEach(() => {
    delete process.env.LAKEHOUSE_GATEWAY_URL;
  });

  test("tool is exported and in DATA_TOOLS by default (everything-ON policy)", () => {
    assert.ok(ASSESS_TRAINING_DATA_TOOL.name, "assess_training_data");
    const names = DATA_TOOLS.map((t) => t.name);
    assert.ok(names.includes("assess_training_data"));
    assert.ok(names.includes("search_catalog"));
  });

  test("ordinary lakehouse tools are unaffected", () => {
    const names = DATA_TOOLS.map((t) => t.name);
    for (const expected of ["search_catalog", "inspect_dataset", "validate_query",
                            "execute_query", "get_data_quality", "explain_lineage",
                            "get_snapshot"]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });

  test("execute renders a bounded summary without raw rows", async () => {
    mock.routes.set("/v1/cdxr/training-assessments", { status: 200, body: sampleResult() });
    mock.install();
    try {
      const res = await ASSESS_TRAINING_DATA_TOOL.execute(
        "t1", sampleParams, undefined, undefined, {} as any);
      const text = res.content[0]!.text;
      assert.ok(text.includes("REVIEW"));
      assert.ok(text.includes("SAMPLE_SIZE"));
      assert.ok(text.includes("checkedFields=orders, revenue, region"));
      const details = res.details as any;
      assert.equal(details.rawRowsReturned, false);
      assert.ok(!JSON.stringify(details).includes('"rows"'));
    } finally {
      mock.restore();
    }
  });

  test("execute failure returns error content instead of throwing", async () => {
    mock.restore(); // no route -> fetch throws
    const res = await ASSESS_TRAINING_DATA_TOOL.execute(
      "t2", sampleParams, undefined, undefined, {} as any);
    assert.ok(res.content[0]!.text.startsWith("assess_training_data failed:"));
  });
});
