/**
 * Result sanitizer — builds the model-facing summary and guarantees that
 * numeric values never enter the main agent context.
 *
 * The full numeric payload lives only in the result artifact (details
 * channel). This module produces AnalysisAgentSummary (refs + status) and the
 * tool content text (status line only).
 */
import type {
  AnalysisAgentSummary,
  AnalysisResultArtifact,
  AnalysisResultStatus,
} from "./contracts.ts";
import { REVIEW_STATUS_NOT_REVIEWED } from "./contracts.ts";

export interface SummaryOptions {
  artifactId: string;
  runId: string;
  status: AnalysisResultStatus;
  title: string;
  availableViews: string[];
  findingRefs: string[];
  warningCodes: string[];
  dataInputRequired?: { missing: string[]; message: string };
}

export function buildAgentSummary(opts: SummaryOptions): AnalysisAgentSummary {
  return {
    artifactId: opts.artifactId,
    runId: opts.runId,
    status: opts.status,
    title: opts.title,
    availableViews: opts.availableViews,
    findingRefs: opts.findingRefs,
    warningCodes: opts.warningCodes,
    displayedDirectly: true,
    reviewStatus: REVIEW_STATUS_NOT_REVIEWED,
    dataInputRequired: opts.dataInputRequired,
  };
}

export function availableViewsOf(artifact: AnalysisResultArtifact): string[] {
  return artifact.sections.map((s) => s.type);
}

/**
 * Model-facing tool content. HARD BOUNDARY: no numbers, no rows, no series,
 * no test statistics, no p-values, no raw output.
 */
export function modelFacingContent(summary: AnalysisAgentSummary): string {
  if (summary.dataInputRequired) {
    return (
      `数据分析输入不足：缺少 ${summary.dataInputRequired.missing.join(", ")}。` +
      `请补充输入后重试。`
    );
  }
  const lines = [
    `数据分析已完成，结构化结果已由前端直接展示（displayedDirectly=true）。`,
    `artifactId=${summary.artifactId} runId=${summary.runId}`,
    `status=${summary.status} title=${summary.title}`,
    `views=${summary.availableViews.join(",")} reviewStatus=${summary.reviewStatus}`,
  ];
  if (summary.findingRefs.length > 0) {
    lines.push(`findings=${summary.findingRefs.join(",")}`);
  }
  if (summary.warningCodes.length > 0) {
    lines.push(`warnings=${summary.warningCodes.join(",")}`);
  }
  return lines.join("\n");
}
