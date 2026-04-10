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
 */
export async function mapIncidentsToTasks(
  incidents: ProtectionIncident[],
): Promise<CriticalTask[]> {
  const results: CriticalTask[] = [];
  for (const incident of incidents) {
    if (incident.severity !== "CRITICAL") continue;
    try {
      const task = await mapIncidentToTask(incident);
      if (task) results.push(task);
    } catch {
      // non-fatal — continue mapping remaining incidents
    }
  }
  return results;
}
