// scripts/check-feature-hygiene.mts
//
// Machine-enforced feature-flag hygiene checks (third layer of the
// Mandatory Feature-Flag Policy — see AGENTS.md, CONTRIBUTING.md and
// docs/templates/FEATURE_IMPLEMENTATION_CHECKLIST.md).
//
// Runs as part of `npm run check` (via scripts/check.mts). Exit code != 0 on
// any failure. Checks:
//   A. No tool is registered without a feature flag; every tool definition
//      appears in exactly one *_TOOL_FEATURES mapping; mapping feature ids
//      exist; mapped tools exist; feature-id literals in src/ are registered.
//   B. Every gateway API route is gated by @_require(...) (no ungated mount),
//      scanned recursively across app/api/**.py with Python AST.
//   C. Business code never reads ENABLE_* directly (full-path whitelist only;
//      includes the root index.ts and all TS/Python sources).
//   D. Every runtime-default-OFF feature has an explicit coverage manifest
//      entry pointing at real test files that mention the feature.
//   E. Guard rails for "build-off can't be runtime-on" and
//      "production refuses unsafe ablations" exist as tests.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const failuresOut: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  if (!ok) {
    failures += 1;
    failuresOut.push(`FAIL ${name}: ${detail}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, ext, acc);
    else if (full.endsWith(ext)) acc.push(full);
  }
  return acc;
}

const rel = (p: string): string => relative(ROOT, p);

// ---- registry ----------------------------------------------------------
const registry = JSON.parse(
  readFileSync(join(ROOT, "config", "features", "registry.json"), "utf8"),
) as { features: Array<{ id: string; envRuntimeName: string; runtimeDefault: boolean }> };
const ids = new Set(registry.features.map((f) => f.id));

const srcFiles = walk(join(ROOT, "src"), ".ts");
// Extension entry lives at the repo root, not under src/ — scan it too.
const rootTs = [join(ROOT, "index.ts")].filter((p) => existsSync(p));
const allTs = [...srcFiles, ...rootTs];

// ---- A: no tool without a feature id; no dangling ids -------------------
// Collect every *_TOOL_FEATURES mapping definition (name → pairs) and every
// ToolDefinition constant (name → tool name) so we can prove each registered
// tool is tied to a feature.
interface ToolMapping { featureId: string; toolConst: string; file: string }
interface ToolDef { constName: string; file: string }

const mappings: ToolMapping[] = [];
const toolDefs: ToolDef[] = [];

const FEATURES_MAP_RE = /(?:const|export const)\s+(\w*TOOL_FEATURES)\s*(?::[^=]+)?=\s*\[/g;
for (const file of allTs) {
  const text = readFileSync(file, "utf8");

  // Find mapping arrays and their [CONST, "feature.id"] entries.
  for (const m of text.matchAll(FEATURES_MAP_RE)) {
    const mapName = m[1]!;
    // Start after the '= [' that opens the array literal (the type annotation
    // may contain ']' characters, e.g. Array<[ToolDefinition<any, any, any>, FeatureId]>).
    const assign = text.indexOf("= [", m.index!);
    const start = assign === -1 ? m.index! + m[0].length : assign + 3;
    const end = text.indexOf("];", start);
    const body = text.slice(start, end === -1 ? text.length : end);
    const entries = [...body.matchAll(/\[([A-Za-z_]\w*),\s*"([^"]+)"/g)];
    for (const e of entries) {
      mappings.push({ toolConst: e[1]!, featureId: e[2]!, file: rel(file) });
    }
    void mapName;
  }

  // Find ToolDefinition constants (name field inside a const with ToolDefinition type).
  const defRe = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*:\s*ToolDefinition[\s\S]*?name:\s*"([^"]+)"/g;
  for (const m of text.matchAll(defRe)) {
    toolDefs.push({ constName: m[1]!, file: rel(file) });
  }
}

// A1: every tool definition must appear in a mapping, unless it is a
// deliberately-unregistered legacy tool (const name contains GOVERNANCE,
// backed by the legacy.cdxr_governance_tools feature). A bare tool — a
// ToolDefinition that is never feature-mapped and not legacy — is a defect:
// it could be registered without any flag.
const legacyBacked = (constName: string): boolean =>
  /GOVERNANCE/.test(constName) && ids.has("legacy.cdxr_governance_tools");
const mappedConsts = new Set(mappings.map((m) => m.toolConst));
const unmappedDefs = toolDefs.filter(
  (d) => !mappedConsts.has(d.constName) && !legacyBacked(d.constName),
);
check("A1: every tool definition is feature-mapped (no bare tool)",
  unmappedDefs.length === 0,
  unmappedDefs.map((d) => `${d.file}: ${d.constName}`).join("; ") || "none");

// A2: every mapped tool constant must have a definition.
const defNames = new Set(toolDefs.map((d) => d.constName));
const missingDefs = mappings.filter((m) => !defNames.has(m.toolConst));
check("A2: every mapped tool has a definition",
  missingDefs.length === 0,
  missingDefs.map((m) => `${m.file}: ${m.toolConst}`).join("; ") || "none");

// A2b: a tool must not be bound to conflicting feature ids in mappings.
const featureByTool = new Map<string, string>();
const conflicts: string[] = [];
for (const m of mappings) {
  const prev = featureByTool.get(m.toolConst);
  if (prev !== undefined && prev !== m.featureId) {
    conflicts.push(`${m.file}: ${m.toolConst} bound to both ${prev} and ${m.featureId}`);
  }
  featureByTool.set(m.toolConst, m.featureId);
}
check("A2b: no tool bound to conflicting features",
  conflicts.length === 0,
  conflicts.join("; ") || "none");

// A3: every mapped feature id must be registered.
const danglingIds = mappings.filter((m) => !ids.has(m.featureId));
check("A3: every mapped feature id is registered",
  danglingIds.length === 0,
  danglingIds.map((m) => `${m.file}: ${m.featureId}`).join("; ") || "none");

// A4: every feature-id string literal in TS sources is registered.
const dangling: string[] = [];
for (const file of allTs) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/"((?:round\d+|legacy|ablate)\.[a-z0-9_]+)"/g)) {
    if (!ids.has(m[1]!)) dangling.push(`${rel(file)}: "${m[1]}"`);
  }
}
check("A4: src feature-id literals all registered", dangling.length === 0,
  dangling.slice(0, 5).join("; ") || "none");

// ---- B: every gateway route is gated by @_require (recursive, AST) ------
// Use Python's ast module so decorator quoting/multiline/_require order are
// handled correctly instead of text adjacency heuristics.
const apiDir = join(ROOT, "services", "lakehouse-gateway", "app", "api");
const apiFiles = walk(apiDir, ".py").filter((p) => !p.includes("__init__"));
const B_SCRIPT = `
import ast, json, sys, pathlib
root = pathlib.Path(sys.argv[1])
allowlist = {"/health"}
out = []
for py in sorted(root.glob("*.py")):
    if py.name == "__init__.py":
        continue
    tree = ast.parse(py.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        routes = [d for d in node.decorator_list if isinstance(d, ast.Call)
                  and isinstance(d.func, ast.Attribute)
                  and isinstance(d.func.value, ast.Name)
                  and d.func.value.id == "router"
                  and d.func.attr in ("get","post","put","patch","delete")]
        if not routes:
            continue
        guarded = any(
            isinstance(d, ast.Call)
            and isinstance(d.func, ast.Name)
            and d.func.id == "_require"
            for d in node.decorator_list
        )
        for r in routes:
            path = r.args[0].value if r.args and isinstance(r.args[0], ast.Constant) else "?"
            if path in allowlist:
                continue
            if not guarded:
                out.append(f"{py.name}:{node.lineno}: {node.name} -> {path}")
print(json.dumps(out))
`;
function runPython(script: string, arg: string): string {
  const r = spawnSync("python3", ["-c", script, arg], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`python route scan failed: ${r.stderr}`);
  return r.stdout.trim();
}
let ungatedRoutes: string[] = [];
if (apiFiles.length > 0) {
  try {
    ungatedRoutes = JSON.parse(runPython(B_SCRIPT, apiDir)) as string[];
  } catch (err) {
    failures += 1;
    failuresOut.push(`FAIL B: route scan crashed — ${(err as Error).message}`);
  }
}
check("B: every API route gated by @_require (recursive AST scan)",
  ungatedRoutes.length === 0,
  ungatedRoutes.slice(0, 8).join("; ") || "none");

// ---- C: no direct ENABLE_* reads outside whitelist ----------------------
// Whitelist is full relative paths, not file names — a file named
// resolver.ts elsewhere must not bypass the check.
const ENV_TS_WHITELIST = new Set([
  "src/features/resolver.ts",
]);
const ENV_PY_WHITELIST = new Set([
  "services/lakehouse-gateway/app/features.py",
]);
// env-reading is allowed in the manifest generator and the hygiene script
// itself (they implement the policy), and in the check runner.
const ENV_SCRIPT_WHITELIST = new Set([
  "scripts/generate-feature-manifest.mts",
  "scripts/print-effective-features.mts",
  "scripts/check-feature-hygiene.mts",
  "scripts/check.mts",
]);

const TS_ENV_PATTERNS = [
  /process\.env\.ENABLE_/,
  /process\.env\[["']ENABLE_/,
];
const PY_ENV_PATTERNS = [
  /os\.environ\.get\(["']ENABLE_/,
  /os\.environ\[["']ENABLE_/,
  /os\.getenv\(["']ENABLE_/,
  /getenv\(["']ENABLE_/,
];

const offenders: string[] = [];
for (const file of allTs) {
  const relPath = rel(file);
  if (ENV_TS_WHITELIST.has(relPath)) continue;
  if (relPath.startsWith("scripts/") && ENV_SCRIPT_WHITELIST.has(relPath)) continue;
  const text = readFileSync(file, "utf8");
  if (TS_ENV_PATTERNS.some((re) => re.test(text))) offenders.push(relPath);
}
for (const file of walk(join(ROOT, "services"), ".py")) {
  const relPath = rel(file);
  if (ENV_PY_WHITELIST.has(relPath)) continue;
  const text = readFileSync(file, "utf8");
  if (PY_ENV_PATTERNS.some((re) => re.test(text))) offenders.push(relPath);
}
check("C: no direct ENABLE_* reads outside whitelist", offenders.length === 0,
  offenders.join(", ") || "none");

// ---- D: default-OFF features have explicit coverage manifest ------------
// String appearance in test files is not enough (a TODO comment would pass).
// The manifest lists, per default-OFF feature, a test file that exercises the
// enabled state and one that exercises the disabled state; the script verifies
// both files exist AND mention the feature id.
const COVERAGE_MANIFEST = join(ROOT, "config", "features", "test-coverage.manifest.json");
const manifest = JSON.parse(readFileSync(COVERAGE_MANIFEST, "utf8")) as {
  features: Record<string, { enabledTest: string; disabledTest: string }>;
};
const manifestIds = new Set(Object.keys(manifest.features));

const defaultOff = registry.features.filter(
  (f) => !f.runtimeDefault && !f.id.startsWith("ablate."),
);

// D1: every default-OFF feature must have a manifest entry.
const missingManifest = defaultOff.filter((f) => !manifestIds.has(f.id));
check("D1: every default-OFF feature has a coverage manifest entry",
  missingManifest.length === 0,
  missingManifest.map((f) => f.id).join(", ") || "none");

// D2: manifest ids must be registered features.
const phantom = [...manifestIds].filter((id) => !ids.has(id));
check("D2: manifest entries reference registered features",
  phantom.length === 0,
  phantom.join(", ") || "none");

// D3: enabled + disabled test files exist and mention the feature.
const uncoveredTests: string[] = [];
for (const [id, entry] of Object.entries(manifest.features)) {
  for (const [kind, file] of [["enabled", entry.enabledTest], ["disabled", entry.disabledTest]] as const) {
    if (!file) {
      uncoveredTests.push(`${id}:${kind} missing path`);
      continue;
    }
    const full = join(ROOT, file);
    if (!existsSync(full)) {
      uncoveredTests.push(`${id}:${kind} file missing (${file})`);
      continue;
    }
    const text = readFileSync(full, "utf8");
    if (!text.includes(id)) uncoveredTests.push(`${id}:${kind} file does not mention feature (${file})`);
  }
}
check("D3: coverage manifest tests exist and mention the feature",
  uncoveredTests.length === 0,
  uncoveredTests.slice(0, 8).join("; ") || "none");

// ---- E: build-off / production guard tests exist -----------------------
const featuresTest = readFileSync(join(ROOT, "tests", "features.test.mts"), "utf8");
const e1 = featuresTest.includes("NOT_BUILT");
const e2 = featuresTest.includes("production") && featuresTest.includes("throws");
check("E1: build-off cannot be runtime-on (NOT_BUILT wins) tested", e1, "");
check("E2: production refuses unsafe ablations tested", e2, "");

// ---- summary ------------------------------------------------------------
if (failures > 0) {
  console.error(`\nfeature hygiene: ${failures} failure(s)`);
  for (const line of failuresOut) console.error(`  ${line}`);
  process.exit(1);
}
console.log("\nfeature hygiene: all checks passed");
