/**
 * Incident-to-Task Bridge
 *
 * Maps funnel-health incidents (PROTECTION_MISSING, UNDERUTILIZED_FUNNEL, etc.)
 * to execution-ready ManualActionTasks with appropriate default hints.
 *
 * This bridges the gap between incident detection and agent execution:
 * - funnel-health detects incidents
 * - CriticalTask queue handles protection incidents (broker actions)
 * - ManualActionTask queue handles engineering/ops work
 *
 * This module creates ManualActionTasks from funnel incidents so that
 * executionReadyCount properly reflects available work.
 */

import {
  createManualActionTask,
  findDuplicateManualTask,
  type ManualActionTaskInput,
  type ManualActionPriority,
  type ManualActionTaskType,
} from "@/lib/agents/manual-action-queue";

// ─── Incident Code to Task Mapping ──────────────────────────────────

interface IncidentTaskDefaults {
  priority: ManualActionPriority;
  taskType: ManualActionTaskType;
  /** Default fileHints for code-patching tasks */
  fileHints?: string[];
  /** Default routeHints for operational tasks */
  routeHints?: string[];
  /** Whether task should be execution-ready by default */
  executionReady: boolean;
  /** Title template (use {code} and {context} placeholders) */
  titleTemplate: string;
  /** Description template */
  descriptionTemplate: string;
}

/**
 * Default configurations for each incident code.
 * OPS/SELF_HEAL tasks get routeHints, code-patching tasks get fileHints.
 * 
 * IMPORTANT: All CRITICAL/HIGH incidents MUST have either fileHints or routeHints
 * to ensure they become execution-ready and don't get blocked by no_file_hints.
 */
const INCIDENT_DEFAULTS: Record<string, IncidentTaskDefaults> = {
  // ─── CRITICAL: Protection issues requiring immediate broker action ────

  PROTECTION_MISSING: {
    priority: "CRITICAL",
    taskType: "OPS",
    fileHints: [
      "app/api/trades/protection-audit/route.ts",
      "app/api/auto-entry/execute/route.ts",
      "lib/risk/protection-integrity.ts",
      "lib/risk/stop-verification.ts",
    ],
    routeHints: [
      "/api/trades/protection-audit?enforce=1",
      "/api/trades?view=operational",
      "/api/broker/positions",
    ],
    executionReady: true,
    titleTemplate: "Fix missing stop protection",
    descriptionTemplate:
      "Critical: Open trade(s) missing stop-loss protection. " +
      "Audit protection integrity and apply stops via broker API. " +
      "Context: {context}",
  },

  MISSING_STOP: {
    priority: "CRITICAL",
    taskType: "OPS",
    fileHints: [
      "app/api/trades/protection-audit/route.ts",
      "lib/risk/protection-integrity.ts",
      "lib/risk/stop-verification.ts",
      "lib/autoManage/stopSync.ts",
    ],
    routeHints: [
      "/api/trades/protection-audit?enforce=1",
      "/api/broker/positions",
    ],
    executionReady: true,
    titleTemplate: "Repair missing stop order",
    descriptionTemplate:
      "Critical: Trade has no active stop-loss order at broker. " +
      "Run protection audit and/or manually create stop. " +
      "Context: {context}",
  },

  MISSING_STOP_AT_ENTRY: {
    priority: "CRITICAL",
    taskType: "OPS",
    fileHints: [
      "app/api/auto-entry/execute/route.ts",
      "lib/risk/stop-verification.ts",
      "lib/risk/protection-integrity.ts",
    ],
    routeHints: [
      "/api/trades/protection-audit?enforce=1",
      "/api/broker/positions",
    ],
    executionReady: true,
    titleTemplate: "Entry created without stop protection",
    descriptionTemplate:
      "Critical: Auto-entry executed but stop verification failed. " +
      "Trade is marked ERROR and requires immediate protection. " +
      "Context: {context}",
  },

  STOP_EXPIRED: {
    priority: "CRITICAL",
    taskType: "OPS",
    fileHints: [
      "app/api/trades/protection-audit/route.ts",
      "lib/risk/protection-integrity.ts",
      "lib/autoManage/stopSync.ts",
    ],
    routeHints: [
      "/api/trades/protection-audit?enforce=1",
    ],
    executionReady: true,
    titleTemplate: "Repair expired stop order",
    descriptionTemplate:
      "Critical: Stop order expired (likely DAY TIF). " +
      "Create new GTC stop immediately. Context: {context}",
  },

  STOP_CANCELED: {
    priority: "CRITICAL",
    taskType: "OPS",
    fileHints: [
      "app/api/trades/protection-audit/route.ts",
      "lib/risk/protection-integrity.ts",
    ],
    routeHints: [
      "/api/trades/protection-audit?enforce=1",
    ],
    executionReady: true,
    titleTemplate: "Repair canceled stop order",
    descriptionTemplate:
      "Critical: Stop order was canceled. " +
      "Create new stop immediately. Context: {context}",
  },

  BROKER_DB_MISMATCH: {
    priority: "CRITICAL",
    taskType: "OPS",
    fileHints: [
      "app/api/trades/protection-audit/route.ts",
      "lib/risk/protection-integrity.ts",
      "lib/trades/operational.ts",
    ],
    routeHints: [
      "/api/trades/protection-audit",
      "/api/broker/positions",
      "/api/trades?view=operational",
    ],
    executionReady: true,
    titleTemplate: "Fix broker/DB position mismatch",
    descriptionTemplate:
      "Critical: Database shows open trade but broker has no position, or vice versa. " +
      "Reconcile trade state with broker truth. Context: {context}",
  },

  EMERGENCY_FLATTEN: {
    priority: "CRITICAL",
    taskType: "OPS",
    fileHints: [
      "lib/risk/stop-verification.ts",
      "app/api/trades/protection-audit/route.ts",
    ],
    routeHints: [
      "/api/trades?view=operational",
      "/api/broker/positions",
    ],
    executionReady: true,
    titleTemplate: "Position flattened due to protection failure",
    descriptionTemplate:
      "Critical: Position was emergency-flattened due to inability to establish stop protection. " +
      "Review incident and understand root cause. Context: {context}",
  },

  // ─── HIGH: Funnel and flow issues ─────────────────────────────────

  UNDERUTILIZED_FUNNEL: {
    priority: "HIGH",
    taskType: "SELF_HEAL",
    fileHints: [
      "app/api/funnel-health/route.ts",
      "app/api/readiness/route.ts",
      "app/api/auto-entry/seed-from-signals/route.ts",
      "lib/autoEntry/guardrails.ts",
    ],
    routeHints: [
      "/api/funnel-health",
      "/api/readiness",
      "/api/auto-entry/seed-from-signals",
    ],
    executionReady: true,
    titleTemplate: "Investigate underutilized funnel",
    descriptionTemplate:
      "High candidate count but low seeding. Check scoring thresholds, " +
      "capacity constraints, and guardrail settings. Context: {context}",
  },

  QUALIFIED_NOT_SEEDED: {
    priority: "HIGH",
    taskType: "SELF_HEAL",
    fileHints: [
      "app/api/auto-entry/seed-from-signals/route.ts",
      "lib/autoEntry/guardrails.ts",
      "lib/autoEntry/guardrailsStore.ts",
    ],
    routeHints: [
      "/api/auto-entry/seed-from-signals",
      "/api/funnel-health",
      "/api/readiness",
    ],
    executionReady: true,
    titleTemplate: "Fix qualified signals not seeding",
    descriptionTemplate:
      "Qualified signals exist but none seeded. Check seeding logic " +
      "and capacity constraints. Context: {context}",
  },

  SEED_NOT_EXECUTED: {
    priority: "MEDIUM",
    taskType: "OPS",
    fileHints: [
      "app/api/auto-entry/execute/route.ts",
      "lib/autoEntry/guardrails.ts",
    ],
    routeHints: [
      "/api/auto-entry/execute",
      "/api/trades?status=AUTO_PENDING",
      "/api/funnel-health",
    ],
    executionReady: true,
    titleTemplate: "Investigate seeded trades not executed",
    descriptionTemplate:
      "Trades seeded but not executed. Check execute route and " +
      "guardrail state. Context: {context}",
  },

  NO_EXECUTION_ACTIVITY: {
    priority: "MEDIUM",
    taskType: "OPS",
    fileHints: [
      "app/api/funnel-health/route.ts",
      "app/api/auto-entry/execute/route.ts",
    ],
    routeHints: [
      "/api/funnel-health",
      "/api/readiness",
      "/api/broker/clock",
    ],
    executionReady: true,
    titleTemplate: "Investigate execution inactivity",
    descriptionTemplate:
      "No execution activity during market hours. Check system health " +
      "and market conditions. Context: {context}",
  },

  // ─── HIGH: Scoring and signal flow issues ─────────────────────────

  SCORING_DEGRADED: {
    priority: "HIGH",
    taskType: "SELF_HEAL",
    fileHints: [
      "app/api/ai/score/drain/route.ts",
      "app/api/signals/all/route.ts",
      "lib/aiScoring.ts",
    ],
    routeHints: [
      "/api/ai/score/drain",
      "/api/signals/all",
      "/api/readiness",
    ],
    executionReady: true,
    titleTemplate: "Investigate scoring degradation",
    descriptionTemplate:
      "AI scoring appears degraded or not producing qualified signals. " +
      "Check scoring pipeline and signal flow. Context: {context}",
  },

  SIGNAL_FLOW_BLOCKED: {
    priority: "HIGH",
    taskType: "SELF_HEAL",
    fileHints: [
      "app/api/signals/all/route.ts",
      "app/api/ai/score/drain/route.ts",
      "app/api/funnel-health/route.ts",
    ],
    routeHints: [
      "/api/signals/all",
      "/api/ai/score/drain",
      "/api/funnel-health",
    ],
    executionReady: true,
    titleTemplate: "Investigate signal flow blockage",
    descriptionTemplate:
      "Signal flow appears blocked. Check signal ingestion, " +
      "scoring pipeline, and funnel progression. Context: {context}",
  },
};

// Fallback for unknown incident codes
const DEFAULT_INCIDENT: IncidentTaskDefaults = {
  priority: "MEDIUM",
  taskType: "OTHER",
  routeHints: ["/api/funnel-health", "/api/readiness"],
  executionReady: false, // Unknown incidents require manual review
  titleTemplate: "Investigate incident: {code}",
  descriptionTemplate: "Unknown incident detected. Context: {context}",
};

// ─── Public API ─────────────────────────────────────────────────────

export interface FunnelIncident {
  code: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  message: string;
  context: Record<string, unknown>;
}

export interface BridgeResult {
  created: boolean;
  deduped: boolean;
  taskId: string | null;
  incidentCode: string;
  reason?: string;
}

/**
 * Create a ManualActionTask from a funnel incident.
 * Deduplicates by title+taskType to prevent flooding the queue.
 */
export async function createTaskFromIncident(
  incident: FunnelIncident,
): Promise<BridgeResult> {
  const defaults = INCIDENT_DEFAULTS[incident.code] ?? DEFAULT_INCIDENT;

  // Build title and description from templates
  const contextStr = JSON.stringify(incident.context).slice(0, 200);
  const title = defaults.titleTemplate
    .replace("{code}", incident.code)
    .replace("{context}", contextStr);
  const description = defaults.descriptionTemplate
    .replace("{code}", incident.code)
    .replace("{context}", incident.message);

  // Check for existing active task with same title
  const existing = await findDuplicateManualTask(title, defaults.taskType);
  if (existing) {
    return {
      created: false,
      deduped: true,
      taskId: existing.id,
      incidentCode: incident.code,
      reason: "duplicate_active_task",
    };
  }

  // Create new task
  const input: ManualActionTaskInput = {
    title,
    description,
    priority: defaults.priority,
    taskType: defaults.taskType,
    executionReady: defaults.executionReady,
    fileHints: defaults.fileHints,
    routeHints: defaults.routeHints,
    source: "incident_bridge",
    objective: `Resolve ${incident.code} incident: ${incident.message}`,
  };

  const task = await createManualActionTask(input);
  if (!task) {
    return {
      created: false,
      deduped: false,
      taskId: null,
      incidentCode: incident.code,
      reason: "redis_unavailable",
    };
  }

  return {
    created: true,
    deduped: false,
    taskId: task.id,
    incidentCode: incident.code,
  };
}

/**
 * Batch-create ManualActionTasks from multiple incidents.
 * Only creates tasks for HIGH and CRITICAL severity incidents.
 */
export async function createTasksFromIncidents(
  incidents: FunnelIncident[],
): Promise<{
  results: BridgeResult[];
  createdCount: number;
  dedupedCount: number;
  skippedCount: number;
}> {
  const results: BridgeResult[] = [];
  let createdCount = 0;
  let dedupedCount = 0;
  let skippedCount = 0;

  for (const incident of incidents) {
    // Only escalate HIGH and CRITICAL incidents
    if (incident.severity !== "CRITICAL" && incident.severity !== "HIGH") {
      skippedCount++;
      continue;
    }

    try {
      const result = await createTaskFromIncident(incident);
      results.push(result);

      if (result.created) createdCount++;
      if (result.deduped) dedupedCount++;
    } catch {
      // Non-fatal: continue with other incidents
      skippedCount++;
    }
  }

  return { results, createdCount, dedupedCount, skippedCount };
}

/**
 * Get the default task configuration for an incident code.
 * Useful for preview/dry-run scenarios.
 */
export function getIncidentDefaults(code: string): IncidentTaskDefaults {
  return INCIDENT_DEFAULTS[code] ?? DEFAULT_INCIDENT;
}

/**
 * Check if an incident code has an execution-ready default configuration.
 */
export function isIncidentExecutionReady(code: string): boolean {
  const defaults = INCIDENT_DEFAULTS[code];
  return defaults?.executionReady ?? false;
}
