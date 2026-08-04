import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { orchestrateDocumentAnalysis } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/orchestrator.ts";

interface ExpectedFact { label: string; aliases: string[]; value: string }
interface Scenario { id: string; document: string; question: string; facts: ExpectedFact[] }
interface Standards { attemptsPerScenario: number; scenarios: Scenario[] }

const root = resolve("evaluation/phase3-agent-evaluation");
const outputDir = resolve(root, "results/multimodal");
mkdirSync(outputDir, { recursive: true });
const standards = JSON.parse(readFileSync(resolve(root, "scenarios/multimodal.json"), "utf8")) as Standards;

function norm(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[,，\s]+/gu, "").trim();
}

function factMatch(expected: ExpectedFact, actual: { claim: string; value: string | number }): boolean {
  const claim = norm(actual.claim);
  return expected.aliases.some((alias) => claim.includes(norm(alias))) && norm(actual.value) === norm(expected.value);
}

const records = [];
let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
for (const scenario of standards.scenarios) {
  const documentText = readFileSync(resolve(root, "scenarios", scenario.document), "utf8");
  for (let attempt = 1; attempt <= standards.attemptsPerScenario; attempt++) {
    const startedAt = new Date().toISOString();
    try {
      const result = await orchestrateDocumentAnalysis({ documentId: scenario.id, documentText, question: scenario.question });
      const actual = result.merged.facts;
      const matches = scenario.facts.map((expected) => ({ expected, found: actual.some((fact) => factMatch(expected, fact)) }));
      const matchedActual = new Set<number>();
      for (const expected of scenario.facts) {
        const index = actual.findIndex((fact, candidateIndex) => !matchedActual.has(candidateIndex) && factMatch(expected, fact));
        if (index >= 0) matchedActual.add(index);
      }
      const tp = matches.filter((entry) => entry.found).length;
      const fp = actual.length - matchedActual.size;
      const fn = scenario.facts.length - tp;
      truePositive += tp;
      falsePositive += fp;
      falseNegative += fn;
      const pass = tp === scenario.facts.length && fp === 0 && result.merged.conflicts.length === 0;
      const record = { id: scenario.id, attempt, startedAt, status: pass ? "PASS" : "FAIL", tp, fp, fn, matches, result };
      records.push(record);
      writeFileSync(resolve(outputDir, `${scenario.id}-attempt-${attempt}.json`), JSON.stringify(record, null, 2) + "\n");
    } catch (error) {
      const record = { id: scenario.id, attempt, startedAt, status: "INFRA_ERROR", error: error instanceof Error ? error.message : String(error) };
      records.push(record);
      writeFileSync(resolve(outputDir, `${scenario.id}-attempt-${attempt}.json`), JSON.stringify(record, null, 2) + "\n");
    }
  }
}
const executed = records.filter((record) => record.status === "PASS" || record.status === "FAIL");
const byScenario = standards.scenarios.map((scenario) => {
  const attempts = records.filter((record) => record.id === scenario.id);
  return { id: scenario.id, passAt1: attempts[0]?.status === "PASS", passAt3: attempts.some((attempt) => attempt.status === "PASS"), attempts };
});
const precision = truePositive + falsePositive === 0 ? null : truePositive / (truePositive + falsePositive);
const recall = truePositive + falseNegative === 0 ? null : truePositive / (truePositive + falseNegative);
const metrics = {
  status: executed.length === 0 ? "INFRA_ERROR" : "PASS",
  passAt1: byScenario.filter((item) => item.passAt1).length / standards.scenarios.length,
  passAt3: byScenario.filter((item) => item.passAt3).length / standards.scenarios.length,
  structuredExtraction: { precision, recall, f1: precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall), truePositive, falsePositive, falseNegative },
  executedAttempts: executed.length,
  infraErrors: records.length - executed.length,
  byScenario,
};
writeFileSync(resolve(outputDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
