export type AgentName = "pm" | "risk" | "ops" | "policynews" | "engineering" | "engineering-manager";

export type AgentPosture = "AGGRESSIVE" | "NORMAL" | "DEFENSIVE";

export type EventRisk = "LOW" | "MEDIUM" | "HIGH";

export type NewsState = "CALM" | "ACTIVE" | "HEADLINE_DRIVEN";

export type AllowedGrade = "A" | "B" | "C";

export type AgentBriefType = "MORNING" | "MIDDAY" | "EOD" | "INCIDENT" | "STATUS";

export type AgentIncidentSeverity = "LOW" | "MEDIUM" | "HIGH";

export type AgentIncidentCategory =
  | "SCORING"
  | "SCANNER"
  | "AUTO_ENTRY"
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