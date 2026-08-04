/**
 * Feature Snapshot utilities — reproducibility records for evaluation runs.
 * Every run must reference effectiveFeatureHash (see docs/FEATURE_FLAGS.md).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureResolver, FeatureSnapshot } from "./types.ts";

export function buildRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Pretty single-line summary of the effective feature set (startup log). */
export function featureSummaryLine(resolver: FeatureResolver): string {
  const snapshot = resolver.getEffectiveFeatureSnapshot();
  const on = snapshot.effectiveFeatures.join(", ");
  const off = snapshot.disabledFeatures.join(", ");
  return (
    `[features] profile=${snapshot.buildProfile} effHash=${snapshot.effectiveFeatureHash} ` +
    `enabled=[${on}] disabled=[${off}]` +
    (snapshot.unsafeAblations.length > 0 ? ` UNSAFE_ABLATIONS=[${snapshot.unsafeAblations.join(", ")}]` : "")
  );
}

/** Persist a snapshot as JSON (default: build/feature-snapshot.json). */
export function writeSnapshot(snapshot: FeatureSnapshot, filePath?: string): string {
  const out = filePath ?? join(buildRoot(), "build", "feature-snapshot.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return out;
}
