/**
 * Feature bindings — maps round4.data_analysis_* features to the data
 * analysis pipeline behavior. The core never reads process.env directly;
 * this module receives the effective feature snapshot from the resolver.
 */
import type { FeatureSnapshot } from "../features/types.ts";

export interface AnalysisFeatureFlags {
  taskGate: boolean;
  materialization: boolean;
  subagent: boolean;
  planGeneration: boolean;
  workspace: boolean;
  scriptExecution: boolean;
  retry: boolean;
  artifacts: boolean;
  findings: boolean;
  charting: boolean;
  frontendRender: boolean;
}

export function analysisFlags(snapshot: FeatureSnapshot): AnalysisFeatureFlags {
  const eff = new Set(snapshot.effectiveFeatures);
  return {
    taskGate: eff.has("round4.analysis_task_gate"),
    materialization: eff.has("round4.analysis_input_materialization"),
    subagent: eff.has("round4.analysis_subagent"),
    planGeneration: eff.has("round4.analysis_plan_generation"),
    workspace: eff.has("round4.analysis_workspace"),
    scriptExecution: eff.has("round4.analysis_script_execution"),
    retry: eff.has("round4.analysis_retry"),
    artifacts: eff.has("round4.analysis_artifacts"),
    findings: eff.has("round4.analysis_findings"),
    charting: eff.has("round4.analysis_charting"),
    frontendRender: eff.has("round4.analysis_frontend_render"),
  };
}

/**
 * Hard boundary (not an ablation): the tool may only be registered when the
 * frontend direct-render channel exists. When frontendRender is off there is
 * no fallback to model recitation.
 */
export function canRegisterDataAnalysisTool(flags: AnalysisFeatureFlags): boolean {
  return (
    flags.subagent &&
    flags.scriptExecution &&
    flags.artifacts &&
    flags.frontendRender
  );
}
