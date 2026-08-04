/**
 * Feature resolver — computes effective feature states from:
 *   build manifest (generated, immutable) × runtime config (env > config
 *   file > runtime profile > registry defaults).
 *
 * effectiveEnabled = buildEnabled AND runtimeEnabled AND parentEnabled AND
 * dependenciesEnabled. Runtime can never enable something the build manifest
 * excluded.
 *
 * Env vars are ONLY read in this module (and the manifest generator). No
 * scattered process.env reads elsewhere — see docs/FEATURE_FLAGS.md.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_FEATURE_MANIFEST } from "../generated/build-features.ts";
import { featureHash } from "./hash.ts";
import { loadFeatureRegistry } from "./registry.ts";
import type {
  BuildFeatureManifest,
  DisabledReason,
  FeatureDefinition,
  FeatureId,
  FeatureRegistry,
  FeatureResolver,
  FeatureSnapshot,
  FeatureState,
  RuntimeConfigInput,
} from "./types.ts";

/** ruleVersion reported in snapshots — must match cdxr-engine ASSESSMENT_RULE_VERSION */
export const CDXR_RULE_VERSION = "cdxr-training.v1";

/** Legacy env aliases honored centrally (never read outside this module). */
const ENV_ALIASES: Record<string, FeatureId[]> = {
  ENABLE_CDXR_TRAINING_TOOL: ["round3.cdxr_training"],
  ENABLE_LEGACY_CDXR_GOVERNANCE: ["legacy.cdxr_governance_cli", "legacy.cdxr_governance_tools"],
};

const UNSAFE_MASTER_BUILD_ENV = "BUILD_UNSAFE_EVALUATION_ABLATIONS";
const EVALUATION_MODE_ENV = "EVALUATION_MODE";
const APP_ENV_VAR = "APP_ENV";
const STRICT_ENV = "FEATURE_CONFIG_STRICT";
const RUNTIME_PROFILE_ENV = "FEATURE_RUNTIME_PROFILE";
const RUNTIME_CONFIG_PATH_ENV = "FEATURE_RUNTIME_CONFIG_PATH";

function configDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "features");
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) throw new Error(`feature config file not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

interface ResolverConfig {
  registry: FeatureRegistry;
  buildManifest: BuildFeatureManifest;
  runtime: RuntimeResolved;
}

interface RuntimeResolved {
  runtimeProfile: string | null;
  runtimeEnabled: Record<FeatureId, boolean>;
  experimentId: string | null;
  warnings: string[];
  configErrors: string[];
}

function resolveRuntimeSettings(
  registry: FeatureRegistry,
  input: RuntimeConfigInput | undefined,
  env: NodeJS.ProcessEnv,
): RuntimeResolved {
  const warnings: string[] = [];
  const configErrors: string[] = [];
  const defs = new Map(registry.features.map((f) => [f.id, f]));

  // base = registry runtimeDefaults
  const enabled: Record<FeatureId, boolean> = {};
  for (const f of registry.features) enabled[f.id] = f.runtimeDefault;

  // 1) runtime profile (lowest explicit layer)
  const profileEnv = env[RUNTIME_PROFILE_ENV];
  const fileRaw = env[RUNTIME_CONFIG_PATH_ENV] ? readJsonFile(env[RUNTIME_CONFIG_PATH_ENV]!) : null;
  const file = (fileRaw ?? {}) as Record<string, unknown>;
  const fileFeatures = (file.features ?? {}) as Record<string, unknown>;
  const fileProfileName = typeof file.runtimeProfile === "string" ? file.runtimeProfile : null;
  const profileName = input?.runtimeProfile ?? fileProfileName ?? profileEnv ?? null;
  const experimentId =
    input?.experimentId ?? (typeof file.experimentId === "string" ? file.experimentId : null) ??
    env.FEATURE_EXPERIMENT_ID ?? null;

  if (profileName !== null) {
    const profile = readJsonFile(join(configDir(), "runtime-profiles", `${profileName}.json`)) as {
      features?: Record<string, unknown>;
    };
    for (const [id, value] of Object.entries(profile.features ?? {})) {
      if (!defs.has(id)) {
        configErrors.push(`runtime profile '${profileName}' references unknown feature '${id}'`);
        continue;
      }
      const b = parseBool(typeof value === "boolean" ? String(value) : undefined);
      if (b !== undefined) enabled[id] = b;
    }
  }

  // 2) explicit runtime config file (overrides profile)
  for (const [id, value] of Object.entries(fileFeatures)) {
    if (typeof id !== "string") continue;
    if (!defs.has(id)) {
      configErrors.push(`runtime config references unknown feature '${id}'`);
      continue;
    }
    const b = parseBool(typeof value === "boolean" ? String(value) : undefined);
    if (b !== undefined) enabled[id] = b;
  }

  // 3) explicit input (tests / scripts / experiment drivers)
  for (const [id, value] of Object.entries(input?.features ?? {})) {
    if (!defs.has(id)) {
      configErrors.push(`runtime input references unknown feature '${id}'`);
      continue;
    }
    if (typeof value === "boolean") enabled[id] = value;
  }

  // 4) env overrides (highest priority) — canonical names + aliases
  for (const f of registry.features) {
    const direct = parseBool(env[f.envRuntimeName]);
    if (direct !== undefined) enabled[f.id] = direct;
  }
  for (const [envName, ids] of Object.entries(ENV_ALIASES)) {
    const v = parseBool(env[envName]);
    if (v !== undefined) for (const id of ids) enabled[id] = v;
  }

  return { runtimeProfile: profileName, runtimeEnabled: enabled, experimentId, warnings, configErrors };
}

class FeatureResolverImpl implements FeatureResolver {
  readonly registry: FeatureRegistry;
  readonly buildManifest: BuildFeatureManifest;
  readonly runtime: RuntimeResolved;
  private readonly states: Map<FeatureId, FeatureState>;
  private readonly defs: Map<FeatureId, FeatureDefinition>;
  private readonly evalMode: boolean;
  private readonly strict: boolean;
  readonly warnings: string[];

  constructor(registry: FeatureRegistry, buildManifest: BuildFeatureManifest, runtime: RuntimeResolved, env: NodeJS.ProcessEnv) {
    this.registry = registry;
    this.buildManifest = buildManifest;
    this.runtime = runtime;
    this.defs = new Map(registry.features.map((f) => [f.id, f]));
    this.strict = parseBool(env[STRICT_ENV]) ?? false;
    this.evalMode = parseBool(env[EVALUATION_MODE_ENV]) ?? false;
    this.warnings = [...runtime.warnings];

    if (this.strict && runtime.configErrors.length > 0) {
      throw new Error(
        `FEATURE_CONFIG_STRICT: invalid feature configuration — ${runtime.configErrors.join("; ")}`,
      );
    }
    for (const err of runtime.configErrors) this.warnings.push(err);

    this.assertNoUnsafeInProduction(env);
    this.states = this.computeStates(env);
  }

  private assertNoUnsafeInProduction(env: NodeJS.ProcessEnv): void {
    const appEnv = env[APP_ENV_VAR];
    if (appEnv === "production") {
      const builtUnsafe = this.registry.features.filter(
        (f) => f.safetyClass === "unsafe" && this.buildManifest.buildEnabled[f.id],
      );
      const requestedUnsafe = this.registry.features.filter(
        (f) => f.safetyClass === "unsafe" && this.runtime.runtimeEnabled[f.id],
      );
      if (builtUnsafe.length > 0 || requestedUnsafe.length > 0) {
        const offenders = [...builtUnsafe, ...requestedUnsafe].map((f) => f.id).join(", ");
        throw new Error(
          `APP_ENV=production with unsafe ablation(s) configured (${offenders}) — refusing to start. ` +
            `Unsafe ablations require BUILD_UNSAFE_EVALUATION_ABLATIONS=true, EVALUATION_MODE=true and APP_ENV != production.`,
        );
      }
    }
  }

  private computeStates(env: NodeJS.ProcessEnv): Map<FeatureId, FeatureState> {
    const states = new Map<FeatureId, FeatureState>();
    const effective = new Map<FeatureId, boolean>();
    const requestedUnsafe: string[] = [];

    for (const f of this.registry.features) {
      const buildEnabled = Boolean(this.buildManifest.buildEnabled[f.id]);
      const requested = this.runtime.runtimeEnabled[f.id] ?? f.runtimeDefault;

      // unsafe features: effective only under EVALUATION_MODE; silent-disable never happens.
      let runtimeEnabled = requested;
      let runtimeNote: string | null = null;
      if (f.safetyClass === "unsafe") {
        if (requested && !this.evalMode) {
          runtimeEnabled = false;
          runtimeNote = "unsafe ablation requested but EVALUATION_MODE is not true — ineffective";
          this.warnings.push(
            `${f.id}: ${runtimeNote}. Set EVALUATION_MODE=true (and APP_ENV != production) to enable.`,
          );
        }
        if (requested) requestedUnsafe.push(f.id);
      }

      let reason: DisabledReason | null = null;
      if (!buildEnabled) reason = "NOT_BUILT";
      else if (!runtimeEnabled) reason = "RUNTIME_DISABLED";
      else {
        const parentOk = f.parent === null ? true : this.effectiveOf(states, effective, f.parent);
        if (!parentOk) {
          reason = "PARENT_DISABLED";
        } else {
          const depOk = f.dependencies.every((d) => this.effectiveOf(states, effective, d));
          if (!depOk) reason = "DEPENDENCY_DISABLED";
        }
      }
      const isEffective = reason === null;
      effective.set(f.id, isEffective);
      states.set(f.id, {
        id: f.id,
        buildEnabled,
        runtimeEnabled,
        effectiveEnabled: isEffective,
        disabledReason: reason,
        parent: f.parent,
        dependencies: [...f.dependencies],
      });
    }

    for (const id of requestedUnsafe) {
      if (env[UNSAFE_MASTER_BUILD_ENV] !== "true") {
        // also verified at manifest generation; keep the runtime guard visible
        this.warnings.push(`${id}: build manifest does not include unsafe ablations — not effective.`);
      } else if (this.evalMode) {
        this.warnings.push(
          `UNSAFE ABLATION ENABLED: ${id} (build: BUILD_UNSAFE_EVALUATION_ABLATIONS=true, ` +
            `runtime: EVALUATION_MODE=true). Results must be marked unsafeAblation=true.`,
        );
      }
    }
    return states;
  }

  private effectiveOf(
    states: Map<FeatureId, FeatureState>,
    effective: Map<FeatureId, boolean>,
    id: FeatureId,
  ): boolean {
    const cached = effective.get(id);
    if (cached !== undefined) return cached;
    const f = this.defs.get(id);
    if (!f) return false;
    const buildEnabled = Boolean(this.buildManifest.buildEnabled[id]);
    const runtimeEnabled = this.runtime.runtimeEnabled[id] ?? false;
    if (!buildEnabled || !runtimeEnabled) {
      effective.set(id, false);
      return false;
    }
    const parentOk = f.parent === null ? true : this.effectiveOf(states, effective, f.parent);
    if (!parentOk) {
      effective.set(id, false);
      return false;
    }
    const depOk = f.dependencies.every((d) => this.effectiveOf(states, effective, d));
    effective.set(id, depOk);
    return depOk;
  }

  isBuilt(id: FeatureId): boolean {
    const f = this.defs.get(id);
    return f !== undefined && Boolean(this.buildManifest.buildEnabled[id]);
  }

  isRuntimeEnabled(id: FeatureId): boolean {
    const s = this.states.get(id);
    return s !== undefined && s.runtimeEnabled;
  }

  isEffective(id: FeatureId): boolean {
    return this.states.get(id)?.effectiveEnabled ?? false;
  }

  requireFeature(id: FeatureId): void {
    const s = this.states.get(id);
    if (!s || !s.effectiveEnabled) {
      throw new Error(`feature '${id}' is not effective (${s?.disabledReason ?? "UNKNOWN"}).`);
    }
  }

  getFeatureState(id: FeatureId): FeatureState {
    const s = this.states.get(id);
    if (!s) throw new Error(`unknown feature id '${id}'`);
    return s;
  }

  getStates(): Record<FeatureId, FeatureState> {
    const out: Record<FeatureId, FeatureState> = {};
    for (const [id, s] of this.states) out[id] = { ...s };
    return out;
  }

  getBuildManifest(): BuildFeatureManifest {
    return this.buildManifest;
  }

  getRuntimeProfile(): string | null {
    return this.runtime.runtimeProfile;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  getEffectiveFeatureSnapshot(opts: RuntimeConfigInput = {}): FeatureSnapshot {
    const states = this.getStates();
    const effectiveFeatures = Object.keys(states)
      .filter((id) => states[id]!.effectiveEnabled)
      .sort();
    const disabledFeatures = Object.keys(states)
      .filter((id) => !states[id]!.effectiveEnabled)
      .sort();
    const unsafeAblations = Object.keys(states)
      .filter((id) => states[id]!.effectiveEnabled && this.defs.get(id)!.safetyClass === "unsafe")
      .sort();

    const effectiveStates: Record<string, boolean> = {};
    for (const id of Object.keys(states).sort()) effectiveStates[id] = states[id]!.effectiveEnabled;

    const runtimeHash = featureHash({
      profile: this.runtime.runtimeProfile,
      features: { ...this.runtime.runtimeEnabled },
    });
    const effectiveHash = featureHash({ features: effectiveStates });

    return {
      experimentId: opts.experimentId ?? this.runtime.experimentId,
      commitSha: getCommitSha(),
      buildProfile: this.buildManifest.buildProfile,
      buildFeatureHash: this.buildManifest.buildFeatureHash,
      runtimeProfile: this.runtime.runtimeProfile,
      runtimeFeatureHash: runtimeHash,
      effectiveFeatureHash: effectiveHash,
      effectiveFeatures,
      disabledFeatures,
      unsafeAblations,
      modelId: opts.modelId ?? process.env.MODEL_ID ?? null,
      promptVersion: opts.promptVersion ?? process.env.PROMPT_VERSION ?? null,
      datasetSnapshot: opts.datasetSnapshot ?? process.env.DATASET_SNAPSHOT ?? null,
      randomSeed: opts.randomSeed ?? process.env.RANDOM_SEED ?? null,
      ruleVersion: opts.ruleVersion ?? process.env.FEATURE_RULE_VERSION ?? CDXR_RULE_VERSION,
      generatedAt: new Date().toISOString(),
    };
  }
}

export function getCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch {
    return "unknown";
  }
}

/** Build a resolver from the current environment (startup semantics). */
export function createFeatureResolver(
  input?: RuntimeConfigInput,
  registry: FeatureRegistry = loadFeatureRegistry(),
  buildManifest: BuildFeatureManifest = BUILD_FEATURE_MANIFEST,
): FeatureResolver {
  const runtime = resolveRuntimeSettings(registry, input, process.env);
  return new FeatureResolverImpl(registry, buildManifest, runtime, process.env);
}

let defaultResolver: FeatureResolver | null = null;

/** Process-wide resolver, built once at first use (env is read at startup). */
export function getDefaultFeatureResolver(): FeatureResolver {
  if (defaultResolver === null) {
    defaultResolver = createFeatureResolver();
  }
  return defaultResolver;
}

/** Test/script hook: replace the process-wide resolver (never used in prod code paths). */
export function _setDefaultFeatureResolver(resolver: FeatureResolver | null): void {
  defaultResolver = resolver;
}
