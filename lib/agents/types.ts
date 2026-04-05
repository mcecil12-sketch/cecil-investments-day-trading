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