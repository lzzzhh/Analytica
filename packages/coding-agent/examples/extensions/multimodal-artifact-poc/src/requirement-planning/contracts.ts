/**
 * Requirement Planning — core contracts.
 *
 * Pure vocabulary: NO imports of lakehouse data tools, CDXR, document
 * parser, GatewayClient, Iceberg, FastAPI, or concrete business tables.
 * The core only knows abstract capabilities (CapabilityDescriptor).
 *
 * First version supports: requirement cards, ambiguity handling, explicit
 * assumptions, plan gate, deterministic validation, scheduling, bounded
 * replanning. No loops, no unbounded retries, no custom scripts, no
 * cross-day scheduling, no distributed tasks, no sub-agent plan mutation.
 */

// ---------------------------------------------------------------------------
// Mode / state
// ---------------------------------------------------------------------------

export type PlanningMode = "ANALYZE" | "CONTINUE" | "REPLAN";

export type PlanningState =
  | "DIRECT_EXECUTION"
  | "NEEDS_CLARIFICATION"
  | "READY_TO_PLAN"
  | "PLAN_READY"
  | "CANNOT_PLAN";

// ---------------------------------------------------------------------------
// Time range
// ---------------------------------------------------------------------------

export interface TimeRange {
  start?: string;
  end?: string;
  relative?: string;
  timezone?: string;
  source: "USER" | "DOMAIN_DEFAULT" | "SYSTEM_DEFAULT" | "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface Metric {
  name: string;
  definition?: string;
  source: "USER" | "DOMAIN_PACK" | "INFERRED";
  confirmed: boolean;
}

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

export type AssumptionSource = "USER" | "DOMAIN_DEFAULT" | "SYSTEM_DEFAULT";
export type AssumptionImpact = "LOW" | "MEDIUM" | "HIGH";

export interface Assumption {
  assumptionId: string;
  field: string;
  value: string;
  source: AssumptionSource;
  impact: AssumptionImpact;
  requiresConfirmation: boolean;
  visibleToUser: true;
}

// ---------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------

export type AmbiguityType =
  | "MISSING"
  | "MULTIPLE_INTERPRETATIONS"
  | "VAGUE_RANGE"
  | "UNKNOWN_METRIC"
  | "UNKNOWN_BASELINE"
  | "UNKNOWN_SUCCESS_CRITERIA"
  | "DOMAIN_AMBIGUITY";

export interface Ambiguity {
  ambiguityId: string;
  field: string;
  type: AmbiguityType;
  blocking: boolean;
  reason: string;
  candidateValues?: string[];
}

// ---------------------------------------------------------------------------
// Business requirement card
// ---------------------------------------------------------------------------

export type RequirementStatus =
  | "DRAFT"
  | "CLARIFYING"
  | "READY"
  | "PLANNED"
  | "REJECTED";

export interface BusinessRequirementCard {
  requestId: string;
  rawRequestSummary: string;
  domain: string;
  businessObjective: string;
  decisionToSupport: string;
  subject: string;
  scope: string;
  timeRange: TimeRange;
  metrics: Metric[];
  dimensions: string[];
  comparisonBaselines: string[];
  successCriteria: string[];
  outputRequirements: string[];
  constraints: string[];
  assumptions: Assumption[];
  ambiguities: Ambiguity[];
  confidence: number;
  status: RequirementStatus;
}

// ---------------------------------------------------------------------------
// Clarification
// ---------------------------------------------------------------------------

export type AnswerType =
  | "TEXT"
  | "SINGLE_CHOICE"
  | "MULTI_CHOICE"
  | "DATE_RANGE"
  | "NUMBER";

export type ClarificationPriority = 1 | 2 | 3 | 4 | 5;

export interface ClarificationQuestion {
  questionId: string;
  field: string;
  question: string;
  whyNeeded: string;
  blocking: boolean;
  priority: ClarificationPriority;
  answerType: AnswerType;
  options?: string[];
}

export interface ClarificationAnswer {
  questionId: string;
  field?: string;
  value: string | string[];
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type SideEffect = "NONE" | "READ" | "WRITE";
export type CostClass = "LOW" | "MEDIUM" | "HIGH";

export interface CapabilityDescriptor {
  id: string;
  available: boolean;
  provider: string;
  inputKinds: string[];
  outputKinds: string[];
  sideEffect: SideEffect;
  costClass: CostClass;
  supportsParallel: boolean;
  featureId: string;
}

// ---------------------------------------------------------------------------
// Task plan
// ---------------------------------------------------------------------------

export type TaskType =
  | "DISCOVER"
  | "EXTRACT"
  | "QUERY"
  | "VALIDATE"
  | "COMPARE"
  | "ASSESS"
  | "ANALYZE"
  | "SYNTHESIZE"
  | "CLARIFY";

export type FailureAction = "STOP" | "SKIP" | "ASK_USER" | "REPLAN" | "RETRY";

export interface FailurePolicy {
  action: FailureAction;
  maxRetries: number;
}

export type StructuredCondition =
  | "ALWAYS"
  | "ON_TASK_SUCCESS"
  | "ON_TASK_FAILURE"
  | "ON_RESULT_EMPTY"
  | "ON_EVIDENCE_CONFLICT"
  | "ON_REASON_CODE";

export interface ActivationCondition {
  condition: StructuredCondition;
  taskId?: string;
  reasonCode?: string;
}

export interface Task {
  taskId: string;
  title: string;
  objective: string;
  taskType: TaskType;
  capability: string;
  dependsOn: string[];
  inputs: string[];
  expectedOutputs: string[];
  preconditions: string[];
  successCriteria: string[];
  failurePolicy: FailurePolicy;
  evidenceRequired: boolean;
  parallelizable: boolean;
  optional: boolean;
  activationCondition: ActivationCondition;
}

export interface PlanBudget {
  maxTasks: number;
  maxToolCalls: number;
  maxSubagents: number;
  maxReplans: number;
}

export interface ReplanPolicy {
  maxReplans: number;
  allowedReasonCodes: string[];
}

export interface TaskPlan {
  planId: string;
  version: number;
  requestId: string;
  goal: string;
  requirementVersion: string;
  tasks: Task[];
  budget: PlanBudget;
  replanPolicy: ReplanPolicy;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Plan gate
// ---------------------------------------------------------------------------

export type PlanGateMode = "DIRECT" | "LIGHTWEIGHT" | "FORMAL";

export interface PlanGateResult {
  mode: PlanGateMode;
  score: number;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationIssueCode =
  | "DUPLICATE_TASK_ID"
  | "MISSING_DEPENDENCY"
  | "CYCLIC_DEPENDENCY"
  | "CAPABILITY_UNAVAILABLE"
  | "INPUT_UNAVAILABLE"
  | "TASK_LIMIT_EXCEEDED"
  | "INVALID_CONDITION"
  | "INVALID_FAILURE_POLICY"
  | "GOAL_CHANGED"
  | "NO_FINAL_OUTPUT";

export interface ValidationIssue {
  code: ValidationIssueCode;
  message: string;
  taskId?: string;
}

export interface PlanValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  warnings: string[];
  missingCapabilities: string[];
  cycle?: string[];
  normalizedPlan?: TaskPlan;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface PlanSchedule {
  readyTaskIds: string[];
  blockedTaskIds: string[];
  executionWaves: string[][];
  parallelGroups: string[][];
}

// ---------------------------------------------------------------------------
// Replanning
// ---------------------------------------------------------------------------

export type TaskFeedbackStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "EMPTY"
  | "BLOCKED"
  | "SKIPPED";

export type ReplanReasonCode =
  | "EMPTY_RESULT"
  | "MISSING_CAPABILITY"
  | "PRECONDITION_FAILED"
  | "CONFLICTING_EVIDENCE"
  | "DATASET_NOT_FOUND"
  | "FIELD_NOT_FOUND"
  | "USER_REQUIREMENT_CHANGED"
  | "TOOL_UNAVAILABLE";

export interface TaskExecutionFeedback {
  taskId: string;
  status: TaskFeedbackStatus;
  reasonCode?: ReplanReasonCode;
  summary?: string;
  evidenceReferences?: string[];
  producedOutputs?: string[];
}

export interface ReplanRecord {
  previousPlanId: string;
  previousVersion: number;
  newPlanId: string;
  newVersion: number;
  reasonCode: ReplanReasonCode;
  preservedTasks: string[];
  removedTasks: string[];
  addedTasks: string[];
  changedTasks: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Advisor
// ---------------------------------------------------------------------------

export type AdvisorReasonCode =
  | "OBJECTIVE_CLARIFIED"
  | "SUBJECT_KNOWN"
  | "SUBJECT_UNKNOWN"
  | "METRICS_KNOWN"
  | "METRICS_UNKNOWN"
  | "TIME_UNKNOWN"
  | "DOMAIN_SIGNAL"
  | "NO_DOMAIN_SIGNAL"
  | "ADVISOR_OUTPUT_INVALID";

export interface AdvisorFieldConclusion {
  field: string;
  value: string;
  reasonCode: AdvisorReasonCode;
}

export interface AdvisorCandidateTask {
  title: string;
  objective: string;
  taskType: TaskType;
  capability: string;
  dependsOn: string[];
  optional: boolean;
}

export interface AdvisorOutput {
  businessObjective: string;
  decisionToSupport: string;
  subject: string;
  scope: string;
  domain: string;
  conclusions: AdvisorFieldConclusion[];
  ambiguities: Omit<Ambiguity, "ambiguityId" | "blocking" | "reason">[] &
    Array<{
      field: string;
      type: AmbiguityType;
      reason: string;
      blocking?: boolean;
      candidateValues?: string[];
    }>;
  assumptions: Array<Omit<Assumption, "assumptionId" | "visibleToUser">>;
  clarificationQuestions: Array<{
    field: string;
    question: string;
    whyNeeded: string;
    answerType: AnswerType;
    options?: string[];
  }>;
  candidateTasks: AdvisorCandidateTask[];
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Decision log
// ---------------------------------------------------------------------------

export interface RequirementPlanningDecisionLog {
  requestId: string;
  mode: PlanningMode;
  requirementVersion: string;
  planVersion: number | null;
  modelId: string;
  domainPack: string;
  featureSnapshotHash: string;
  planGateMode: PlanGateMode | null;
  ambiguityCount: number;
  blockingAmbiguityCount: number;
  clarificationQuestionCount: number;
  assumptionCount: number;
  taskCount: number;
  missingCapabilities: string[];
  replanCount: number;
  reasonCodes: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Tool I/O
// ---------------------------------------------------------------------------

export interface PrepareBusinessTaskRequest {
  mode: PlanningMode;
  request?: string;
  domainHint?: string;
  conversationSummary?: string;
  previousState?: BusinessPlanningState;
  answers?: ClarificationAnswer[];
  taskFeedback?: TaskExecutionFeedback[];
  constraints?: {
    maxQuestions?: number;
    maxTasks?: number;
    maxReplans?: number;
    maxToolCalls?: number;
    maxSubagents?: number;
  };
}

export interface BusinessPlanningState {
  requestId: string;
  requirement: BusinessRequirementCard;
  plan?: TaskPlan;
  validation?: PlanValidationResult;
  schedule?: PlanSchedule;
  replanCount: number;
  answeredQuestionIds: string[];
}

export interface PrepareBusinessTaskResult {
  requestId: string;
  state: PlanningState;
  requirement: BusinessRequirementCard;
  clarificationQuestions: ClarificationQuestion[];
  planGate: PlanGateResult;
  taskPlan?: TaskPlan;
  validation?: PlanValidationResult;
  schedule?: PlanSchedule;
  replan?: ReplanRecord;
  availableCapabilities: string[];
  missingCapabilities: string[];
  featureSnapshotHash: string;
  warnings: string[];
  decisionLog: RequirementPlanningDecisionLog;
}

/** Default constraint limits (spec §5). */
export const DEFAULT_CONSTRAINTS = {
  maxQuestions: 3,
  maxTasks: 12,
  maxReplans: 1,
  maxToolCalls: 20,
  maxSubagents: 4,
} as const;

/** Deterministic input rejection: executable content must never reach the core. */
export const FORBIDDEN_INPUT_PATTERNS: RegExp[] = [
  /\bselect\b[\s\S]{0,40}\bfrom\b/i, // raw SQL (select ... from)
  /\binsert\s+into\b/i,
  /\bupdate\s+\w+\s+set\b/i,
  /\bdelete\s+from\b/i,
  /\bdrop\s+table\b/i,
  /\bexec\s*\(/i,
  /\beval\s*\(/i,
  /\bpython\b[\s\S]{0,20}\bimport\b/i,
  /=>\s*[{[]/, // JS arrow with body
  /;\s*\)?\s*[{]/, // statement blocks
  /`[^`]{20,}`/, // long backtick strings (likely code)
  // file path + execution intent (e.g. "读取 /tmp/run.py 并执行")
  /\b(?:[\w./-]*\/)?[\w-]+\.(?:py|js|ts|sh|bash|mjs|mts)\b[\s\S]{0,40}(?:执行|运行|跑一下|run|exec(?:ute)?\b|source\b)/i,
  /\b(?:读取|打开|read|load|open)\b[\s\S]{0,30}(?:并\s*)?(?:执行|运行|run|exec(?:ute)?\b)/i,
];
