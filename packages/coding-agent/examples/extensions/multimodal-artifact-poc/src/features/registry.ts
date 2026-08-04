/**
 * Feature registry loader — the single authority for feature definitions.
 * The registry JSON lives at config/features/registry.json; both TypeScript
 * and Python resolve the same file. No defaults are duplicated in code.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureDefinition, FeatureRegistry, FeatureId } from "./types.ts";

function registryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "features", "registry.json");
}

export function loadFeatureRegistry(filePath: string = registryPath()): FeatureRegistry {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as FeatureRegistry;
  if (!parsed.registryVersion || !Array.isArray(parsed.features)) {
    throw new Error(`feature registry ${filePath} is malformed (registryVersion/features required)`);
  }
  validateRegistry(parsed);
  return parsed;
}

export function validateRegistry(registry: FeatureRegistry): void {
  const ids = new Set(registry.features.map((f) => f.id));
  for (const f of registry.features) {
    if (f.parent !== null && !ids.has(f.parent)) {
      throw new Error(`feature ${f.id}: parent '${f.parent}' is not defined in the registry`);
    }
    for (const dep of f.dependencies) {
      if (!ids.has(dep)) {
        throw new Error(`feature ${f.id}: dependency '${dep}' is not defined in the registry`);
      }
    }
    if (f.safetyClass !== "safe" && f.safetyClass !== "unsafe") {
      throw new Error(`feature ${f.id}: invalid safetyClass '${f.safetyClass}'`);
    }
  }
}

export function byId(registry: FeatureRegistry): Map<FeatureId, FeatureDefinition> {
  return new Map(registry.features.map((f) => [f.id, f]));
}

export function assertFeatureId(registry: FeatureRegistry, id: FeatureId): void {
  if (!byId(registry).has(id)) {
    throw new Error(`unknown feature id '${id}' — registry.json is the single source of truth`);
  }
}
