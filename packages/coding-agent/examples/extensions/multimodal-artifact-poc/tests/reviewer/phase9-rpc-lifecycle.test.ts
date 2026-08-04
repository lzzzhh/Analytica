// 3. RPC subprocess lifecycle: timeout path must not leak the child
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSemanticReviewer, SemanticReviewError } from "/Users/zhanhuilin/Documents/pi/packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/reviewer/adapters/pi-reviewer.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rpc-leak-"));
}

describe("RPC subprocess lifecycle", () => {
  test("timeout kills the child (no leaked process)", async () => {
    const dir = tmp();
    // fake CLI that never replies (stdin stays open, no output)
    const fakeCli = join(dir, "hang.mjs");
    writeFileSync(fakeCli, `process.stdin.on("data", () => {});\nsetInterval(() => {}, 1000);\n`);
    const reviewer = createPiSemanticReviewer({ cliPath: fakeCli, timeoutMs: 2000 });
    const t0 = Date.now();
    await assert.rejects(
      () => reviewer({ objective: "x", diff: "y", fileContext: "z", testSummary: "t", staticSummary: "" }),
      SemanticReviewError,
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 20_000, `timed out in ${elapsed}ms, not hung`);
    // give the kill a moment, then assert no node process runs the fake cli
    await new Promise((r) => setTimeout(r, 500));
    const { execFileSync } = await import("node:child_process");
    const ps = execFileSync("ps", ["-axo", "pid,command"], { encoding: "utf8" });
    assert.ok(!ps.includes("hang.mjs"), "no leftover fake-CLI child process");
  });
});
