import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPiSemanticReviewer } from "../../packages/coding-agent/examples/extensions/multimodal-artifact-poc/src/reviewer/adapters/pi-reviewer.ts";

interface Check { checkId: string; status: string; summary: string; evidenceRefIds: string[] }
interface Claim { findingId: string; claimTemplate: string; category: string; causalClaim: boolean; evidenceRefIds: string[] }
interface Scenario { id: string; defectRef?: string; objective: string; analysisType: string; methods: string[]; checks: Check[]; claims: Claim[]; discrepancyCodes: string[] }
interface Standards { positiveScenarios: Scenario[]; cleanScenarios: Scenario[] }

const root = resolve("evaluation/phase3-agent-evaluation");
const outputDir = resolve(root, "results/reviewer");
mkdirSync(outputDir, { recursive: true });
const standards = JSON.parse(readFileSync(resolve(root, "scenarios/reviewer.json"), "utf8")) as Standards;
const review = createPiSemanticReviewer({ provider: "openai", model: "gpt-5.6-luna", timeoutMs: 120_000 });
const records = [];

for (const [kind, scenarios] of [["positive", standards.positiveScenarios], ["clean", standards.cleanScenarios]] as const) {
  for (const scenario of scenarios) {
    const allowedRefs = [...new Set([...scenario.checks.flatMap((check) => check.evidenceRefIds), ...scenario.claims.flatMap((claim) => claim.evidenceRefIds)])];
    try {
      const findings = await review({
        objective: scenario.objective,
        analysisType: scenario.analysisType,
        methods: scenario.methods,
        assumptions: [],
        limitations: [],
        checkSummaries: scenario.checks,
        findingClaims: scenario.claims,
        discrepancyCodes: scenario.discrepancyCodes,
      }, allowedRefs);
      const high = findings.filter((finding) => finding.severity === "HIGH" || finding.severity === "BLOCKER");
      const detected = kind === "positive" && scenario.defectRef !== undefined
        ? high.some((finding) => finding.evidenceRefIds.includes(scenario.defectRef as string))
        : false;
      const falsePositive = kind === "clean" && high.length > 0;
      const record = { id: scenario.id, kind, status: kind === "positive" ? (detected ? "PASS" : "FAIL") : (falsePositive ? "FAIL" : "PASS"), detected, falsePositive, allowedRefs, findings };
      records.push(record);
      writeFileSync(resolve(outputDir, `${scenario.id}.json`), JSON.stringify(record, null, 2) + "\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const infra = /timed out|exited early|ENOENT|ECONN|401|403|429/u.test(message);
      const record = { id: scenario.id, kind, status: infra ? "INFRA_ERROR" : "ABSTAIN", error: message };
      records.push(record);
      writeFileSync(resolve(outputDir, `${scenario.id}.json`), JSON.stringify(record, null, 2) + "\n");
    }
  }
}
const positive = records.filter((record) => record.kind === "positive" && (record.status === "PASS" || record.status === "FAIL"));
const clean = records.filter((record) => record.kind === "clean" && (record.status === "PASS" || record.status === "FAIL"));
const metrics = {
  publicReviewerEntrypointStatus: "NOT_RUN",
  publicReviewerEntrypointReason: "Reviewer modules are not registered by the product extension public entrypoint.",
  semanticAdapterStatus: records.some((record) => record.status === "PASS" || record.status === "FAIL") ? "PASS" : records.some((record) => record.status === "INFRA_ERROR") ? "INFRA_ERROR" : "ABSTAIN",
  highSeverityDefectRecall: positive.length === 0 ? null : positive.filter((record) => record.status === "PASS").length / positive.length,
  positiveExecuted: positive.length,
  positiveTotal: standards.positiveScenarios.length,
  reviewerFalsePositiveRate: clean.length === 0 ? null : clean.filter((record) => record.status === "FAIL").length / clean.length,
  cleanExecuted: clean.length,
  cleanTotal: standards.cleanScenarios.length,
  records,
};
writeFileSync(resolve(outputDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
