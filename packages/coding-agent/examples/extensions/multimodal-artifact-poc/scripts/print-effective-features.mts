/**
 * Print the resolved feature state (human summary + machine-readable JSON).
 *
 * Usage:
 *   node --experimental-strip-types scripts/print-effective-features.mts [--json] [--write]
 *
 *   --json   print the full FeatureSnapshot as JSON on stdout
 *   --write  also persist build/feature-snapshot.json
 *
 * Feature state is NOT exposed as an agent-callable tool by default.
 */
import { createFeatureResolver } from "../src/features/resolver.ts";
import { featureSummaryLine, writeSnapshot } from "../src/features/snapshot.ts";

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const write = args.includes("--write");

  const resolver = createFeatureResolver();
  const snapshot = resolver.getEffectiveFeatureSnapshot();

  if (asJson) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.log(featureSummaryLine(resolver));
    const states = resolver.getStates();
    const rows = Object.values(states)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((s) => {
        const reason = s.effectiveEnabled ? "ON" : `OFF(${s.disabledReason})`;
        return `  ${s.id.padEnd(34)} build=${String(s.buildEnabled).padEnd(5)} runtime=${String(s.runtimeEnabled).padEnd(5)} -> ${reason}`;
      });
    // eslint-disable-next-line no-console
    console.log(rows.join("\n"));
    const warnings = resolver.getWarnings();
    if (warnings.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`warnings:\n  ${warnings.join("\n  ")}`);
    }
  }

  if (write) {
    const path = writeSnapshot(snapshot);
    // eslint-disable-next-line no-console
    console.log(`snapshot written to ${path}`);
  }
}

main();
