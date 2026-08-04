// scripts/check.mts
//
// Aggregated check runner: runs the type check AND the feature-flag hygiene
// check unconditionally, then exits non-zero if either failed.
//
// This exists because `tsgo --noEmit && hygiene` short-circuits: when the
// type check fails (e.g. pre-existing errors in the repo), the hygiene
// machine check never runs, so its guarantees silently stop applying.
//
// Run: npm run check
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSGO = join(ROOT, "..", "..", "..", "..", "..", "node_modules", ".bin", "tsgo");

let failed = false;

function run(label: string, cmd: string, args: string[]): void {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
  if (r.status !== 0) {
    failed = true;
    console.error(`FAIL ${label} (exit ${r.status})`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// 1. Type check (never skipped; pre-existing errors stay visible).
run("tsgo --noEmit", TSGO, ["--noEmit"]);

// 2. Feature-flag hygiene machine check (always runs regardless of #1).
run("feature hygiene", process.execPath, [
  "--experimental-strip-types",
  join(ROOT, "scripts", "check-feature-hygiene.mts"),
]);

if (failed) {
  console.error("\ncheck: FAILED (see failures above)");
  process.exit(1);
}
console.log("\ncheck: all checks passed");
