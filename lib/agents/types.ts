export type AgentName = "pm" | "risk" | "ops" | "policynews" | "engineering" | "engineering-manager";

export type AgentPosture = "AGGRESSIVE" | "NORMAL" | "DEFENSIVE";

export type EventRisk = "LOW" | "MEDIUM" | "HIGH";

export type NewsState = "CALM" | "ACTIVE" | "HEADLINE_DRIVEN";

export type AllowedGrade = "A" | "B" | "C";

export type AgentBriefType = "MORNING" | "MIDDAY" | "EOD" | "INCIDENT" | "STATUS";

export type AgentIncidentSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type AgentIncidentCategory =
  | "SCORING"
  | "SCANNER"
  | "AUTO_ENTRY"
  | "FUNNEL_BLOCK"
  | "TRADES"
  | "BROKER_SYNC"
  | "NEWS"
  | "ENGINEERING"
  | "UNKNOWN";

export type AgentIncidentStatus = "OPEN" | "MONITORING" | "RESOLVED";

export type AgentActionStatus = "PROPOSED" | "APPLIED" | "SKIPPED" | "FAILED";

export type EngineeringTaskStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "READY_FOR_EXECUTION"
  | "READY_FOR_PUSH"
  | "READY_FOR_REVIEW"
  | "DONE"
  | "BLOCKED"
  | "FAILED";

export type EngineeringExecutionStatus = "PENDING" | "READY" | "BLOCKED" | "EXECUTED" | "FAILED";

export type BacklogItemStatus = "OPEN" | "READY" | "IN_PROGRESS" | "REVIEW" | "DONE";
export type BacklogItemType = "BUG" | "FEATURE" | "OPTIMIZATION" | "TECH_DEBT";
export type BacklogItemPriority = "HIGH" | "MEDIUM" | "LOW";

export interface FreezeWindow {
  start: string;
  end: string;
  reason: string;
}

export interface AgentState {
  asOf: string;
  posture: AgentPosture;
  eventRisk: EventRisk;
  newsState: NewsState;
  allowedGrades: AllowedGrade[];
  minScoreAdjustment: number;
  maxEntriesOverride: number | null;
  freezeWindows: FreezeWindow[];
  activeRestrictions: string[];
  activeIncidentCount: number;
  telemetry?: {
    readinessReady?: boolean;
    readinessReasons?: string[];
    brokerPositionsCount?: number;
    dbOpenTradesCount?: number;
    dbAutoOpenTradesCount?: number;
    dbActualOperationalCount?: number;
    dbOperationalOpenCount?: number;
    mismatchNote?: string | null;
    recentSignalsPending?: number;
    recentSignalsScored?: number;
    recentZeroScores?: number;
    scannerStale?: boolean;
    scoringStale?: boolean;
    autoEntryDisabled?: boolean;
    openTradeMismatch?: boolean;
  };
  latestBriefId?: string | null;
  latestEngineeringTaskId?: string | null;
  latestEngineeringTaskTitle?: string | null;
  remediationSummary?: string;
  lastRemediationAt?: string | null;
  openIncidentCategories?: AgentIncidentCategory[];
  openEngineeringTaskCount?: number;
  openExecutionReadyCount?: number;
  blockedTaskCount?: number;
  openBacklogCount?: number;
  inProgressBacklogCount?: number;
  nextBacklogTitles?: string[];
  latestExecutionTaskTitle?: string | null;
  latestExecutionStatus?: EngineeringTaskStatus | null;
  updatedBy: AgentName | "system";
}

export interface PatchPlan {
  mode: "PLACEHOLDER" | "FILE_WRITE" | "GITHUB_COMMIT";
  targetFiles: string[];
  proposedChangesSummary: string;
}

export interface ValidationPlan {
  buildRequired: boolean;
  testCommands: string[];
  smokeChecks: string[];
}

export interface CommitPlan {
  commitMessage: string;
  targetBranch: "main";
  pushDirect: boolean;
}

export interface AgentBrief {
  id: string;
  agent: AgentName;
  briefType: AgentBriefType;
  createdAt: string;
  etDate?: string;
  title: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface AgentIncident {
  id: string;
  createdAt: string;
  updatedAt: string;
  etDate?: string;
  severity: AgentIncidentSeverity;
  source: AgentName;
  category: AgentIncidentCategory;
  status: AgentIncidentStatus;
  title: string;
  summary: string;
  notes?: string[];
}

export interface AgentAction {
  id: string;
  createdAt: string;
  etDate?: string;
  agent: AgentName;
  actionType: string;
  status: AgentActionStatus;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface EngineeringTask {
  id: string;
  createdAt: string;
  updatedAt: string;
  etDate?: string;
  status: EngineeringTaskStatus;
  title: string;
  summary: string;
  likelyFiles: string[];
  copilotPrompt: string;
  smokeTestBlock: string;
  gitBlock: string;
  incidentId?: string | null;
  incidentCategory?: AgentIncidentCategory;
  likelyRootCause?: string;
  recommendedNextAction?: string;
  remediationAttempted?: boolean;
  remediationStatus?: "none" | "attempted" | "succeeded" | "failed" | "completed";
  successCriteria?: string;
  linkedTelemetrySnapshot?: Record<string, unknown>;
  remediationResultSummary?: string;
  backlogItemId?: string | null;
  patchPlan?: PatchPlan;
  validationPlan?: ValidationPlan;
  commitPlan?: CommitPlan;
  executionStatus?: EngineeringExecutionStatus;
  executionError?: string | null;
  commitSha?: string | null;
  commitUrl?: string | null;
  notes?: string[];
}

export interface BacklogItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: BacklogItemStatus;
  type: BacklogItemType;
  priority: BacklogItemPriority;
  title: string;
  summary: string;
  likelyFiles?: string[];
  copilotPrompt?: string;
  smokeTestBlock?: string;
  gitBlock?: string;
  linkedIncidentId?: string | null;
  assignedAgent?: "engineering" | "engineering-manager" | "ops" | "pm" | null;
  notes?: string[];
}

export interface AgentRunnerResult {
  agent: AgentName;
  state: AgentState;
  briefId?: string | null;
  actionId?: string | null;
  incidentId?: string | null;
  engineeringTaskId?: string | null;
  summary: string;
}

// ─── Phase 3: Intelligent Execution Layer ───────────────────────────────────

export type TaskPriorityBucket = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type MarketBias = "LONG" | "SHORT" | "MIXED" | "RISK_OFF";
export type ImpactStatus = "IMPROVED" | "NEUTRAL" | "DEGRADED" | "INCONCLUSIVE";

/** Scoring dimensions for task prioritization. All values 0–10. */
export interface TaskPriorityDimensions {
  tradingImpact: number;
  reliabilityImpact: number;
  throughputImpact: number;
  riskImpact: number;
  learningValue: number;
  growthValue: number;
  /** Lower complexity is better; raw value is inverted in scoring. */
  complexity: number;
  /** 10 = fully reversible, 0 = irreversible. */
  reversibility: number;
  urgency: number;
}

export interface ScoredTask {
  taskId: string;
  title: string;
  dimensions: TaskPriorityDimensions;
  priorityScore: number;
  priorityBucket: TaskPriorityBucket;
  rationale: string;
  scoredAt: string;
}

/** Structured brief from the News / Policy Strategist. */
export interface StrategistBrief {
  id: string;
  createdAt: string;
  marketBias: MarketBias;
  /** 0–1 */
  confidence: number;
  eventRiskLevel: EventRisk;
  exposureGuidance: string;
  rationale: string;
  recommendedFocusAreas: string[];
}

/** Snapshot of key trading metrics at a point in time. */
export interface TradingMetricsSnapshot {
  qualificationRate: number;
  avgAiScore: number;
  scoredCount: number;
  qualifiedCount: number;
  winRate: number;
  avgR: number;
  totalTrades: number;
  protectedTradeRate: number;
  deepLossRate: number;
  longWinRate: number;
  shortWinRate: number;
  capturedAt: string;
}

/** Persisted record of before/after metrics for one agent execution. */
export interface ExecutionImpactRecord {
  id: string;
  executionId: string;
  taskId: string;
  agent: AgentName;
  commitSha: string | null;
  baselineMetrics: TradingMetricsSnapshot | null;
  postMetrics: TradingMetricsSnapshot | null;
  executionImpactScore: number | null;
  impactStatus: ImpactStatus;
  notes: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface LossPattern {
  side?: string;
  tier?: string;
  timeOfDay?: string;
  avgR: number;
  count: number;
  description: string;
}

/** Translated learning signals derived from recent closed-trade data. */
export interface PerformanceLearningSignals {
  computedAt: string;
  tradePeriodDays: number;
  totalTrades: number;
  winRate: number;
  avgR: number;
  longWinRate: number;
  shortWinRate: number;
  deepLossCount: number;
  deepLossRate: number;
  losingPatterns: LossPattern[];
  winningPatterns: LossPattern[];
  longVsShortImbalance: string;
  weakSetupClasses: string[];
  recommendedCorrections: string[];
  growthOpportunities: string[];
}

/** Result from pre-commit validation checks. */
export interface ValidationOutcome {
  taskId: string;
  passed: boolean;
  failureReason: string | null;
  smokeCheckResults: Record<string, "pass" | "fail" | "skip">;
  validatedAt: string;
}

/** Summary produced by the Engineering Manager orchestration pass. */
export interface EngineeringManagerBrief {
  id: string;
  createdAt: string;
  scoredTasks: ScoredTask[];
  selectedTaskId: string | null;
  selectedTaskTitle: string | null;
  rationale: string;
  strategistBias: MarketBias;
  learningSignalsSummary: string;
}

// ─── Phase 4: Adaptive Guardrails & True Execution Autonomy ─────────────────

export type AdaptiveActionType =
  | "reduce_max_open_positions"
  | "reduce_max_entries_per_day"
  | "raise_min_score_threshold"
  | "increase_cooldown_after_loss"
  | "suppress_side"
  | "suppress_mode";

export type AdaptiveActionStatus = "ACTIVE" | "EXPIRED" | "ROLLED_BACK";

export interface AdaptiveGuardrailAction {
  id: string;
  actionType: AdaptiveActionType;
  reason: string;
  triggerPattern?: string;
  appliedAt: string;
  expiresAt: string;
  status?: AdaptiveActionStatus;
  previousValue: number | string | boolean | null;
  appliedValue: number | string | boolean;
  rolledBack?: boolean;
  rolledBackAt?: string | null;
  rollbackReason?: string | null;
  source?: string;
}

export interface AdaptiveGuardrailState {
  actions: AdaptiveGuardrailAction[];
  lastEvaluatedAt: string | null;
  evaluationSource: string | null;
}

export type ExecutionPhase =
  | "SELECT_TASK"
  | "CLAIM_TASK"
  | "GENERATE_PATCH_PLAN"
  | "APPLY_PATCH"
  | "COMMIT_PUSH"
  | "VERIFY"
  | "RESOLVE_OR_FAIL";

export type ExecutionPhaseStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface ExecutionPhaseResult {
  phase: ExecutionPhase;
  status: ExecutionPhaseStatus;
  durationMs?: number;
  detail?: string;
}

export interface ExecutionStateMachineResult {
  executionStatus: "COMPLETED" | "FAILED" | "DRY_RUN" | "NO_TASK" | "BYPASSED_CRITICAL";
  selectedSource: "critical-task-queue" | "engineering-backlog" | "none";
  selectedTaskId: string | null;
  selectedTaskTitle: string | null;
  executionPhases: ExecutionPhaseResult[];
  patchApplied: boolean;
  commitSha?: string | null;
  branchName?: string | null;
  verification: {
    buildOk: boolean;
    smokeOk: boolean;
    details: Record<string, unknown>;
  };
  resolution: {
    resolved: boolean;
    reason?: string;
  };
  failure?: {
    phase: string;
    reason: string;
  };
  dryRun?: boolean;
}

export interface PatchPlanDetail {
  summary: string;
  filesToModify: string[];
  expectedDiffType: "code_change" | "config_change" | "ops_only";
  validationSteps: string[];
  rollbackNotes: string;
}

export interface GitHubWriteCapability {
  writeEnabled: boolean;
  reason?: string;
}

export interface StructuredVerificationResult {
  gateResult: {
    passed: boolean;
    buildOk: boolean;
    smokeOk: boolean;
    failureReason: string | null;
  };
  probeResults: Array<{
    route: string;
    ok: boolean;
    status: number | null;
    reason: string | null;
  }>;
  taskSpecificResults: Array<{
    target: string;
    ok: boolean;
    detail: string | null;
    requestedMethod?: string;
    finalMethod?: string;
    retriedAfter405?: boolean;
    authHeaderUsed?: string | null;
    status?: number | null;
  }>;
  overall: boolean;
  verifiedAt: string;
}

export interface ActionableBacklogTask {
  id: string;
  title: string;
  category: string;
  priorityBucket: TaskPriorityBucket;
  executionReady: boolean;
  patchStrategy: "code_change" | "config_change" | "ops_only";
  targetFiles: string[];
  smokeTargets: string[];
  successCriteria: string[];
}