/**
 * Feature bindings for Requirement Planning (Round-4 feature ids).
 *
 * The core itself never reads features; this module is the single place
 * mapping feature ids to plugin behavior switches, consumed by the tool
 * adapter and the extension entry point.
 */

export const ROUND4_FEATURES = {
  parent: "round4.requirement_planning",
  skill: "round4.requirement_skill",
  advisor: "round4.planning_advisor",
  ambiguity: "round4.ambiguity_detection",
  clarification: "round4.clarification",
  assumptions: "round4.assumption_management",
  planGate: "round4.plan_gate",
  taskPlan: "round4.task_plan_generation",
  validation: "round4.plan_validation",
  scheduler: "round4.dependency_scheduler",
  parallel: "round4.parallel_scheduling",
  replanning: "round4.dynamic_replanning",
  domainPack: "round4.domain_pack",
} as const;

export type Round4FeatureId = (typeof ROUND4_FEATURES)[keyof typeof ROUND4_FEATURES];

/** Env names (build/runtime) for the generator + resolver. */
export const ROUND4_BUILD_ENV: Record<Round4FeatureId, string> = {
  "round4.requirement_planning": "BUILD_REQUIREMENT_PLANNING",
  "round4.requirement_skill": "BUILD_REQUIREMENT_SKILL",
  "round4.planning_advisor": "BUILD_PLANNING_ADVISOR",
  "round4.ambiguity_detection": "BUILD_AMBIGUITY_DETECTION",
  "round4.clarification": "BUILD_REQUIREMENT_CLARIFICATION",
  "round4.assumption_management": "BUILD_ASSUMPTION_MANAGEMENT",
  "round4.plan_gate": "BUILD_PLAN_GATE",
  "round4.task_plan_generation": "BUILD_TASK_PLAN_GENERATION",
  "round4.plan_validation": "BUILD_PLAN_VALIDATION",
  "round4.dependency_scheduler": "BUILD_DEPENDENCY_SCHEDULER",
  "round4.parallel_scheduling": "BUILD_PARALLEL_SCHEDULING",
  "round4.dynamic_replanning": "BUILD_DYNAMIC_REPLANNING",
  "round4.domain_pack": "BUILD_REQUIREMENT_DOMAIN_PACK",
};

export const ROUND4_RUNTIME_ENV: Record<Round4FeatureId, string> = {
  "round4.requirement_planning": "ENABLE_REQUIREMENT_PLANNING",
  "round4.requirement_skill": "ENABLE_REQUIREMENT_SKILL",
  "round4.planning_advisor": "ENABLE_PLANNING_ADVISOR",
  "round4.ambiguity_detection": "ENABLE_AMBIGUITY_DETECTION",
  "round4.clarification": "ENABLE_REQUIREMENT_CLARIFICATION",
  "round4.assumption_management": "ENABLE_ASSUMPTION_MANAGEMENT",
  "round4.plan_gate": "ENABLE_PLAN_GATE",
  "round4.task_plan_generation": "ENABLE_TASK_PLAN_GENERATION",
  "round4.plan_validation": "ENABLE_PLAN_VALIDATION",
  "round4.dependency_scheduler": "ENABLE_DEPENDENCY_SCHEDULER",
  "round4.parallel_scheduling": "ENABLE_PARALLEL_SCHEDULING",
  "round4.dynamic_replanning": "ENABLE_DYNAMIC_REPLANNING",
  "round4.domain_pack": "ENABLE_REQUIREMENT_DOMAIN_PACK",
};

/** Defaults: all round-4 features OFF at runtime (spec §16). */
export const ROUND4_RUNTIME_DEFAULTS: Record<Round4FeatureId, boolean> = {
  "round4.requirement_planning": false,
  "round4.requirement_skill": false,
  "round4.planning_advisor": false,
  "round4.ambiguity_detection": false,
  "round4.clarification": false,
  "round4.assumption_management": false,
  "round4.plan_gate": false,
  "round4.task_plan_generation": false,
  "round4.plan_validation": false,
  "round4.dependency_scheduler": false,
  "round4.parallel_scheduling": false,
  "round4.dynamic_replanning": false,
  "round4.domain_pack": false,
};
