/**
 * Governance contract tests — TypeScript side.
 *
 * Verifies the 10 JSON Schemas under contracts/pipeline-governance/ are a
 * consistent single source of truth across languages:
 *   - all 10 schemas load;
 *   - $id values are unique;
 *   - every $ref resolves;
 *   - required / enum / const / additionalProperties are enforced;
 *   - the same fixtures validate identically in Python and TS;
 *   - canonical JSON + contentHash match the Python implementation.
 *
 * The validator here is a minimal JSON-Schema (draft-07 subset) reader used
 * ONLY for parity tests — it is not a production dependency.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTRACTS = join(import.meta.dirname, "..", "contracts", "pipeline-governance");
const NAMES = [
  "source-registration", "source-schema-profile", "schema-spec", "pipeline-spec",
  "pipeline-draft-artifact", "validation-issue", "pipeline-review-package",
  "approval-decision", "pipeline-amendment", "approved-pipeline-spec",
  "governance-event", "pipeline-run-state-snapshot",
  "governance-finding", "pipeline-context-package",
  "spark-runtime-summary", "flink-runtime-summary",
  "iceberg-commit-summary", "remediation-proposal",
  "watchdog-lease",
];

function loadSchema(name: string): any {
  return JSON.parse(readFileSync(join(CONTRACTS, `${name}.schema.json`), "utf8"));
}

// minimal draft-07 subset validator
function validate(schema: any, instance: any, errors: string[], path: string, store: Map<string, any>): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path}: schema false`);
    return;
  }
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, schema.$id ?? "", store);
    if (!target) {
      errors.push(`${path}: unresolvable $ref ${schema.$ref}`);
      return;
    }
    validate(target, instance, errors, path, store);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t: string) => {
      if (t === "object") return instance !== null && typeof instance === "object" && !Array.isArray(instance);
      if (t === "array") return Array.isArray(instance);
      if (t === "string") return typeof instance === "string";
      if (t === "integer") return Number.isInteger(instance);
      if (t === "number") return typeof instance === "number";
      if (t === "boolean") return typeof instance === "boolean";
      if (t === "null") return instance === null;
      return true;
    });
    if (!ok) {
      errors.push(`${path}: expected ${schema.type}, got ${typeof instance}`);
      return;
    }
  }
  if (schema.const !== undefined && instance !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(instance)) {
    errors.push(`${path}: value not in enum`);
  }
  if (schema.pattern && typeof instance === "string" && !new RegExp(schema.pattern).test(instance)) {
    errors.push(`${path}: pattern mismatch`);
  }
  if (schema.minLength !== undefined && typeof instance === "string" && instance.length < schema.minLength) {
    errors.push(`${path}: minLength`);
  }
  if (schema.minimum !== undefined && typeof instance === "number" && instance < schema.minimum) {
    errors.push(`${path}: below minimum`);
  }
  if (schema.required && typeof instance === "object" && instance !== null) {
    for (const r of schema.required) {
      if (!(r in instance)) errors.push(`${path}: missing required '${r}'`);
    }
  }
  if (schema.additionalProperties === false && typeof instance === "object" && instance !== null && !Array.isArray(instance)) {
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const k of Object.keys(instance)) {
      if (!allowed.has(k)) errors.push(`${path}: additional property '${k}'`);
    }
  }
  if (schema.properties && typeof instance === "object" && instance !== null && !Array.isArray(instance)) {
    for (const [k, sub] of Object.entries<any>(schema.properties)) {
      if (k in instance) validate(sub, instance[k], errors, `${path}.${k}`, store);
    }
  }
  if (schema.items && Array.isArray(instance)) {
    for (let i = 0; i < instance.length; i++) {
      validate(schema.items, instance[i], errors, `${path}[${i}]`, store);
    }
  }
}

function buildStore(): Map<string, any> {
  const store = new Map<string, any>();
  for (const n of NAMES) {
    const s = loadSchema(n);
    store.set(s.$id, s);
  }
  return store;
}

/** Resolve a $ref relative to the current schema's $id (same directory). */
function resolveRef(ref: string, currentId: string, store: Map<string, any>): any | undefined {
  if (store.has(ref)) return store.get(ref);
  const base = currentId.includes("/") ? currentId.slice(0, currentId.lastIndexOf("/") + 1) : "";
  return store.get(base + ref);
}

/** canonical JSON: UTF-8 (Unicode NOT escaped), keys sorted, no whitespace,
 *  arrays in order. Matches the Python sha256_canonical (json.dumps
 *  sort_keys=True, ensure_ascii=False, separators=(",",":")). */
function canonicalJson(obj: any): string {
  return JSON.stringify(sortKeys(obj)).replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)),
  );
}
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function contentHash(obj: any): string {
  return `sha256:${sha256Hex(canonicalJson(obj))}`;
}

// shared fixtures (must match the Python side)
const FIXTURES: Record<string, { valid: any; invalid: any }> = {
  "approval-decision": {
    valid: {
      approvalId: "a1", reviewId: "r1", reviewContentHash: "sha256:" + "0".repeat(64),
      decision: "APPROVE", approverSource: "OPERATOR_CLI", osActor: "u@h",
      comment: "", decidedAt: "2026-08-02T00:00:00Z",
    },
    invalid: {
      approvalId: "a2", reviewId: "r1", reviewContentHash: "sha256:" + "0".repeat(64),
      decision: "APPROVE", approverSource: "AGENT", osActor: "u@h",
      comment: "", decidedAt: "2026-08-02T00:00:00Z",
    },
  },
  "pipeline-draft-artifact": {
    valid: {
      artifactId: "d1", specVersion: 1, executable: false, compiledPreview: "x",
      contentHash: "sha256:" + "0".repeat(64),
      compiler: "DETERMINISTIC_PYICEBERG_COMPILER", compiledAt: "2026-08-02T00:00:00Z",
    },
    invalid: {
      artifactId: "d2", specVersion: 1, executable: true, compiledPreview: "x",
      contentHash: "sha256:" + "0".repeat(64),
      compiler: "DETERMINISTIC_PYICEBERG_COMPILER", compiledAt: "2026-08-02T00:00:00Z",
    },
  },
};

describe("contracts cross-language parity", () => {
  const store = buildStore();

  test("all 10 schemas load and $id unique", () => {
    const ids = new Set<string>();
    for (const n of NAMES) {
      const s = loadSchema(n);
      assert.ok(s.$id, `${n}: missing $id`);
      assert.ok(!ids.has(s.$id), `${n}: duplicate $id ${s.$id}`);
      ids.add(s.$id);
    }
    assert.equal(ids.size, NAMES.length);
  });

  test("every $ref resolves", () => {
    for (const n of NAMES) {
      const raw = readFileSync(join(CONTRACTS, `${n}.schema.json`), "utf8");
      const refs = [...raw.matchAll(/"\$ref":\s*"([^"]+)"/g)].map((m) => m[1]);
      const currentId = loadSchema(n).$id;
      for (const r of refs) {
        assert.ok(resolveRef(r, currentId, store) !== undefined, `${n}: unresolvable $ref ${r}`);
      }
    }
  });

  test("required/enum/const/additionalProperties enforced (TS)", () => {
    const validateTs = (name: string, inst: any): string[] => {
      const errs: string[] = [];
      validate(loadSchema(name), inst, errs, "$", store);
      return errs;
    };
    // approval-decision: AGENT source rejected
    assert.equal(validateTs("approval-decision", FIXTURES["approval-decision"].valid).length, 0);
    assert.ok(validateTs("approval-decision", FIXTURES["approval-decision"].invalid).length > 0);
    // draft: executable must be false
    assert.equal(validateTs("pipeline-draft-artifact", FIXTURES["pipeline-draft-artifact"].valid).length, 0);
    assert.ok(validateTs("pipeline-draft-artifact", FIXTURES["pipeline-draft-artifact"].invalid).length > 0);
    // schema-spec: missing createdAt
    const badSchema = { specId: "s", version: 1, targetDataset: "dwd.x", businessGranularity: "row",
      fieldMappings: [], types: {}, timeFields: [], partitioning: [],
      compatibilityStrategy: "ADDITIVE", sensitiveFields: [], assumptions: [], risks: [] };
    assert.ok(validateTs("schema-spec", badSchema).length > 0);
    // additionalProperties
    const extra = { ...FIXTURES["approval-decision"].valid, surprise: true };
    assert.ok(validateTs("approval-decision", extra).length > 0);
  });

  test("TS and Python agree on fixtures", () => {
    const pyProbe = `
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.contracts import is_valid_contract
fixtures = json.loads(sys.stdin.read())
out = {}
for name, pair in fixtures.items():
    out[f"{name}:valid"] = is_valid_contract(name, pair["valid"])
    out[f"{name}:invalid"] = is_valid_contract(name, pair["invalid"])
print(json.dumps(out))
`;
    const pyOut = JSON.parse(
      execFileSync("python3", ["-c", pyProbe], {
        cwd: join(import.meta.dirname, ".."), encoding: "utf8",
        input: JSON.stringify(FIXTURES),
      }).trim().split("\n").pop()!,
    );
    const validateTs = (name: string, inst: any): string[] => {
      const errs: string[] = [];
      validate(loadSchema(name), inst, errs, "$", store);
      return errs;
    };
    for (const [key, expected] of Object.entries(pyOut)) {
      const [name, kind] = key.split(":");
      const inst = FIXTURES[name][kind];
      const tsValid = validateTs(name, inst).length === 0;
      assert.equal(tsValid, expected, `${key}: TS=${tsValid} PY=${expected} mismatch`);
    }
  });

  test("canonical JSON + contentHash match Python", () => {
    const sample = {
      specId: "s1", version: 1, targetDataset: "dwd.贷款明细", businessGranularity: "row",
      primaryKey: ["id"], fieldMappings: [{ sourceField: "id", targetField: "id", targetType: "string" }],
      types: {}, timeFields: [], partitioning: [], compatibilityStrategy: "ADDITIVE",
      sensitiveFields: [], assumptions: ["中文假设"], risks: [], createdAt: "2026-08-02T00:00:00Z",
      nested: { b: [1, 2, 3], a: { z: "末", y: "中" } },
    };
    const tsHash = contentHash(sample);
    const pyHash = execFileSync("python3", ["-c", `
import sys, json
sys.path.insert(0, ".")
from pipelines.governance.contracts import sha256_canonical
sample = json.loads(sys.stdin.read())
print(sha256_canonical(sample))
`], { cwd: join(import.meta.dirname, ".."), encoding: "utf8", input: JSON.stringify(sample) }).trim();
    assert.equal(tsHash, pyHash, "canonical hash must match across languages (incl. Unicode)");
  });
});
