import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve("evaluation/phase3-agent-evaluation/results/data-analysis/metrics.json");
const metrics = JSON.parse(readFileSync(path, "utf8")) as {
  records: Array<{ assertions: Array<{ name: string; pass: boolean }> }>;
  numericalCorrectness: number | null;
  correctNumericalAssertions?: number;
  totalNumericalAssertions?: number;
};
const numerical = metrics.records.flatMap((record) => record.assertions).filter((assertion) => /^(number|row|series):/u.test(assertion.name));
metrics.correctNumericalAssertions = numerical.filter((assertion) => assertion.pass).length;
metrics.totalNumericalAssertions = numerical.length;
metrics.numericalCorrectness = numerical.length === 0 ? null : metrics.correctNumericalAssertions / numerical.length;
writeFileSync(path, JSON.stringify(metrics, null, 2) + "\n");
process.stdout.write(JSON.stringify({ numericalCorrectness: metrics.numericalCorrectness, correctNumericalAssertions: metrics.correctNumericalAssertions, totalNumericalAssertions: metrics.totalNumericalAssertions }) + "\n");
