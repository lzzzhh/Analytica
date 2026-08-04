import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, "../..");
const source = join(repo, "evaluation/runs/2026-08-03T22-44-51-970Z-3ce87745f9/tool-calling");
const scores = JSON.parse(readFileSync(join(source, "scores.json"), "utf8"));
const cases = scores.casesDetail.map((score) => {
  const normalized = JSON.parse(readFileSync(join(source, "results-normalized", `${score.caseId}.json`), "utf8"));
  const durationMs = Date.parse(normalized.finishedAt) - Date.parse(normalized.startedAt);
  const raw = readFileSync(join(source, normalized.rawTrace), "utf8");
  return {
    caseId: score.caseId,
    scoreStatus: score.status,
    durationMs,
    timedOut: normalized.timedOut,
    callCount: normalized.toolCalls.length,
    toolErrors: normalized.toolCalls.filter((call) => call.isError).length,
    hasReviewerSpawnTimestamp: /REVIEWER_PROCESS_SPAWNED|reviewerSpawnedAt|reviewer_ready|reviewerReadyAt/.test(raw),
    hasObservedWrapperTimestamp: /observedAtNs/.test(raw),
    rawTrace: normalized.rawTrace,
  };
});

const normal = cases.filter((item) => item.toolErrors === 0 && item.callCount <= 1).slice(0, 10);
const used = new Set(normal.map((item) => item.caseId));
const rework = cases
  .filter((item) => !used.has(item.caseId) && (item.callCount > 1 || item.toolErrors > 0))
  .sort((a, b) => b.callCount - a.callCount)
  .slice(0, 5);
for (const item of rework) used.add(item.caseId);
const slowOrTimeout = cases
  .filter((item) => !used.has(item.caseId))
  .sort((a, b) => Number(b.timedOut) - Number(a.timedOut) || b.durationMs - a.durationMs)
  .slice(0, 5);
const sample = [...normal, ...rework, ...slowOrTimeout];
const result = {
  schemaVersion: "1.0",
  sourceRun: source,
  requestedComposition: { normal: 10, rework: 5, timeoutOrNearTimeout: 5 },
  actualComposition: { normal: normal.length, rework: rework.length, timeoutOrNearTimeout: slowOrTimeout.length },
  sample,
  observability: {
    mainAgentInferenceSeparatelyMeasurable: false,
    toolExecutionSeparatelyMeasurable: false,
    reviewerColdStartSeparatelyMeasurable: sample.some((item) => item.hasReviewerSpawnTimestamp),
    reviewerInferenceSeparatelyMeasurable: false,
    reworkInferenceSeparatelyMeasurable: false,
    totalTaskDurationAvailable: sample.every((item) => Number.isFinite(item.durationMs)),
  },
  status: "ABSTAIN",
  blocker: "Historical raw traces do not carry wrapper receive timestamps or Reviewer spawn/ready/request/completion timestamps, so the required latency waterfall cannot be reconstructed without conflating components.",
  mitigation: "Stages 1-3 use new wrapper-level monotonic timestamps; Stage 3 instruments Reviewer cold start and inference separately.",
};
const output = join(root, "stage0");
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "baseline-observability.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: result.status, sampleCount: sample.length, observability: result.observability })}\n`);
