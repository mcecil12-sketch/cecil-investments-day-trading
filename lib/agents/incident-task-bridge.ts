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
 */
const INCIDENT_DEFAULTS: Record<string, IncidentTaskDefaults> = {
  // CRITICAL: Protection issues requiring broker action
  PROTECTION_MISSING: {
    priority: "CRITICAL",
    taskType: "OPS",
    routeHints: [
      "/api/risk/protection-audit",
      "/api/trades/open",
      "/api/broker/positions",
    ],
    executionReady: true,
    titleTemplate: "Fix missing stop protection",
    descriptionTemplate:
      "Critical: Open trade(s) missing stop-loss protection. " +
      "Audit protection integrity and apply stops via broker API. " +
      "Context: {context}",
  },

  // HIGH: Funnel underutilization
  UNDERUTILIZED_FUNNEL: {
    priority: "HIGH",
    taskType: "SELF_HEAL",
    routeHints: [
      "/api/funnel-health",
      "/api/scanner/seed",
      "/api/signals",
    ],
    fileHints: [
      "lib/autoEntry/scoring.ts",
      "lib/autoEntry/guardrails.ts",
    ],
    executionReady: true,
    titleTemplate: "Investigate underutilized funnel",
    descriptionTemplate:
      "High candidate count but low seeding. Check scoring thresholds, " +
      "capacity constraints, and guardrail settings. Context: {context}",
  },

  // HIGH: Qualified signals not being seeded
  QUALIFIED_NOT_SEEDED: {
    priority: "HIGH",
    taskType: "SELF_HEAL",
    routeHints: [
      "/api/scanner/seed",
      "/api/funnel-health",
      "/api/guardrails/state",
    ],
    fileHints: [
      "lib/autoEntry/seed.ts",
      "lib/autoEntry/guardrails.ts",
    ],
    executionReady: true,
    titleTemplate: "Fix qualified signals not seeding",
    descriptionTemplate:
      "Qualified signals exist but none seeded. Check seeding logic " +
      "and capacity constraints. Context: {context}",
  },

  // MEDIUM: Seeded trades not executing
  SEED_NOT_EXECUTED: {
    priority: "MEDIUM",
    taskType: "OPS",
    routeHints: [
      "/api/scanner/execute",
      "/api/broker/positions",
      "/api/trades/seeded",
    ],
    executionReady: true,
    titleTemplate: "Investigate seeded trades not executed",
    descriptionTemplate:
      "Trades seeded but not executed. Check execute route and " +
      "broker integration. Context: {context}",
  },

  // MEDIUM: No recent execution activity
  NO_EXECUTION_ACTIVITY: {
    priority: "MEDIUM",
    taskType: "OPS",
    routeHints: [
      "/api/funnel-health",
      "/api/scanner/status",
      "/api/broker/positions",
    ],
    executionReady: true,
    titleTemplate: "Investigate execution inactivity",
    descriptionTemplate:
      "No execution activity during market hours. Check system health " +
      "and market conditions. Context: {context}",
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
