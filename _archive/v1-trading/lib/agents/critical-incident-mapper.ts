/**
 * Maps ProtectionIncident → CriticalTask via the Redis critical task queue.
 * Deduplication is handled by saveCriticalTask (incidentCode:symbol:date).
 */

import type { ProtectionIncident } from "@/lib/risk/protection-integrity";
import { saveCriticalTask, type CriticalTask } from "@/lib/redis";

/**
 * Convert a single protection incident into an execution-ready critical task.
 * Returns the (possibly deduplicated) task, or null if Redis is unavailable.
 */
export async function mapIncidentToTask(
  incident: ProtectionIncident,
): Promise<CriticalTask | null> {
  return saveCriticalTask({
    incidentCode: incident.code,
    symbol: incident.symbol,
    severity: incident.severity,
    detail: incident.detail,
  });
}

/**
 * Batch-map an array of protection incidents to critical tasks.
 * Only CRITICAL-severity incidents are promoted; lower severities are skipped.
 *
 * When a MISSING_STOP incident is present alongside a known bracket stop (indicated
 * by bracketStopActive=true), the generic MISSING_STOP task is suppressed and
 * a ROOT_CAUSE_PREMATURE_EXIT_AFTER_BRACKET_FILL task is raised instead.
 */
export async function mapIncidentsToTasks(
  incidents: ProtectionIncident[],
  opts?: { bracketStopActive?: boolean },
): Promise<CriticalTask[]> {
  const results: CriticalTask[] = [];
  const hasBracketStop = opts?.bracketStopActive === true;

  for (const incident of incidents) {
    if (incident.severity !== "CRITICAL") continue;
    // Suppress generic MISSING_STOP when broker bracket stop is active —
    // the real root cause is a premature app-initiated exit, not a missing stop.
    if (incident.code === "MISSING_STOP" && hasBracketStop) continue;
    try {
      const task = await mapIncidentToTask(incident);
      if (task) results.push(task);
    } catch {
      // non-fatal — continue mapping remaining incidents
    }
  }
  return results;
}

/**
 * Classify a confirmed premature-exit-after-bracket-fill event as a root-cause
 * critical task.  Owner is always "execution".  Generic MISSING_STOP tasks for
 * the same symbol+date are automatically superseded via the dedup key.
 */
export async function classifyBracketPrematureExit(opts: {
  symbol: string;
  tradeId: string;
  detail: string;
  exitRoute?: string;
  exitInitiator?: string;
  autoManageRunId?: string;
}): Promise<CriticalTask | null> {
  return saveCriticalTask({
    incidentCode: "ROOT_CAUSE_PREMATURE_EXIT_AFTER_BRACKET_FILL",
    symbol: opts.symbol,
    severity: "CRITICAL",
    detail: [
      opts.detail,
      opts.exitRoute ? `exitRoute=${opts.exitRoute}` : null,
      opts.exitInitiator ? `initiator=${opts.exitInitiator}` : null,
      opts.autoManageRunId ? `runId=${opts.autoManageRunId}` : null,
      `tradeId=${opts.tradeId}`,
      "owner=execution",
    ].filter(Boolean).join(" | "),
  });
}

/**
 * Returns true when a MISSING_STOP task should be suppressed because the broker
 * already has an active bracket stop leg protecting the position.
 */
export function shouldSuppressMissingStopTask(opts: { bracketStopActive: boolean }): boolean {
  return opts.bracketStopActive;
}
