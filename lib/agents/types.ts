export type AgentName = "pm" | "risk" | "ops" | "policynews" | "engineering";

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

export type EngineeringTaskStatus = "OPEN" | "IN_PROGRESS" | "READY_FOR_REVIEW" | "DONE";

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
    dbOperationalOpenCount?: number;
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
  updatedBy: AgentName | "system";
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
  remediationStatus?: "none" | "attempted" | "succeeded" | "failed";
  successCriteria?: string;
  linkedTelemetrySnapshot?: Record<string, unknown>;
  remediationResultSummary?: string;
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