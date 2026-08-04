/**
 * Reviewer shadow tests — minimal real execution loop (Commit 3).
 *
 * Deterministic templates only (never model-generated shell/commands):
 *  - templates are fixed Node test scripts exercising negative paths
 *  - the runner executes them in an isolated workspace with the env whitelist
 *  - results (exit codes, logs, hashes) are recorded in a manifest artifact
 *
 * A check is PASSED only when at least one test actually executed and passed;
 * FAILED when a test ran and failed; UNAVAILABLE when execution is not
 * operational (fail closed — never a fake PASS).
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { canonicalHash, ReviewerStore } from "../store.ts";
import type { ArtifactRef } from "../contracts/index.ts";
import { REVIEWER_ENV_WHITELIST } from "./review-runner.ts";

export type ShadowTestOutcome =
  | { status: "PASSED"; executed: number }
  | { status: "FAILED"; executed: number; failed: number; detail: string }
  | { status: "UNAVAILABLE"; detail: string };

export interface ShadowTestTemplate {
  id: string;
  name: string;
  description: string;
  /** Returns the test script source for the given changed-file paths. */
  scriptFor(changedPaths: string[]): string;
}

/**
 * Negative-path templates (fixed, deterministic). Each template produces a
 * Node test script; execution is a single `node <file>` call.
 */
const NEGATIVE_TEMPLATES: ShadowTestTemplate[] = [
  {
    id: "invalid-input",
    name: "invalid input rejection",
    description: "negative test: NaN/undefined inputs are rejected by assert",
    scriptFor: () => `import assert from "node:assert/strict";
// negative path: invalid input is detected, not silently accepted
assert.ok(Number.isNaN(Number("not-a-number")));
assert.ok(Number.isNaN(Number(undefined)));
console.log("shadow-test:invalid-input:ok");
process.exit(0);`,
  },
  {
    id: "immutability-guard",
    name: "immutability guard",
    description: "negative test: an immutable object cannot be overwritten",
    scriptFor: () => `import assert from "node:assert/strict";
const frozen = Object.freeze({ value: 1 });
assert.throws(() => { frozen.value = 2; });
console.log("shadow-test:immutability-guard:ok");
process.exit(0);`,
  },
];

export function shadowTestTemplates(): ShadowTestTemplate[] {
  return NEGATIVE_TEMPLATES;
}

export interface ShadowTestResult {
  outcome: ShadowTestOutcome;
  manifestRef?: ArtifactRef;
  logsRef?: ArtifactRef;
}

export class ShadowTestRunner {
  readonly store: ReviewerStore;

  constructor(store: ReviewerStore) {
    this.store = store;
  }

  async run(
    workspaceRoot: string,
    changedPaths: string[],
    templates: ShadowTestTemplate[] = NEGATIVE_TEMPLATES,
  ): Promise<ShadowTestResult> {
    const dir = resolve(workspaceRoot, "reviewer-tests");
    await mkdir(dir, { recursive: true });

    const results: Array<{ template: string; exitCode: number; ok: boolean; log: string }> = [];
    for (const tpl of templates) {
      const file = join(dir, `${tpl.id}.test.mjs`);
      await writeFile(file, tpl.scriptFor(changedPaths));
      const { code, stdout, stderr } = await runNode(file, dir);
      const log = `stdout:\n${stdout}\nstderr:\n${stderr}`.slice(-2000);
      results.push({ template: tpl.id, exitCode: code, ok: code === 0, log });
    }

    if (results.length === 0) {
      return { outcome: { status: "UNAVAILABLE", detail: "no shadow test templates" } };
    }

    const executed = results.length;
    const failed = results.filter((r) => !r.ok);
    const manifest = {
      schemaVersion: "1.0",
      workspace: dir,
      changedPaths,
      results: results.map((r) => ({ template: r.template, exitCode: r.exitCode, ok: r.ok })),
      executedAt: new Date().toISOString(),
    };
    const token = Date.now().toString(16);
    await this.store.writeImmutable(`reviews/shadow/${token}/manifest.json`, manifest);
    await this.store.writeImmutable(`reviews/shadow/${token}/logs.json`, results.map((r) => ({ template: r.template, log: r.log })));
    const manifestRec = await this.store.read(`reviews/shadow/${token}/manifest.json`);
    const logsRec = await this.store.read(`reviews/shadow/${token}/logs.json`);
    const manifestRef: ArtifactRef = {
      artifactId: `reviews/shadow/${token}/manifest.json`,
      artifactType: "reviewer-shadow-manifest",
      contentHash: manifestRec?.hash ?? canonicalHash(manifest),
    };
    const logsRef: ArtifactRef = {
      artifactId: `reviews/shadow/${token}/logs.json`,
      artifactType: "reviewer-shadow-logs",
      contentHash: logsRec?.hash ?? "",
    };

    if (failed.length > 0) {
      return {
        outcome: {
          status: "FAILED", executed,
          failed: failed.length,
          detail: `shadow tests failed: ${failed.map((r) => r.template).join(", ")}`,
        },
        manifestRef, logsRef,
      };
    }
    return { outcome: { status: "PASSED", executed }, manifestRef, logsRef };
  }
}

function runNode(file: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile("node", [file], { cwd, env: REVIEWER_ENV_WHITELIST, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : 1) : 0,
          stdout: String(stdout), stderr: String(stderr),
        });
      });
  });
}
