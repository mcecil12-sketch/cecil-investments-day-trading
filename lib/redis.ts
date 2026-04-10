import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.warn("[redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
}

export const redis =
  url && token
    ? new Redis({ url, token })
    : null;

// ─── Critical Task Queue ────────────────────────────────────────────

export interface CriticalTask {
  id: string;
  incidentCode: string;
  symbol: string;
  severity: string;
  detail: string;
  createdAt: string;
  resolvedAt?: string;
}

const CRITICAL_TASKS_KEY = "critical_tasks";

/**
 * Save a critical task, deduped by incidentCode:symbol:date.
 */
export async function saveCriticalTask(
  task: Omit<CriticalTask, "id" | "createdAt">,
): Promise<CriticalTask | null> {
  if (!redis) return null;
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const dedupeKey = `${task.incidentCode}:${task.symbol}:${dateKey}`;

  const existing = await redis.hget<CriticalTask>(CRITICAL_TASKS_KEY, dedupeKey);
  if (existing && !existing.resolvedAt) return existing;

  const entry: CriticalTask = {
    id: dedupeKey,
    incidentCode: task.incidentCode,
    symbol: task.symbol,
    severity: task.severity,
    detail: task.detail,
    createdAt: now.toISOString(),
  };

  await redis.hset(CRITICAL_TASKS_KEY, { [dedupeKey]: entry });
  return entry;
}

/**
 * Get all unresolved critical tasks, sorted newest-first.
 */
export async function getCriticalTasks(): Promise<CriticalTask[]> {
  if (!redis) return [];
  const all = await redis.hgetall<Record<string, CriticalTask>>(CRITICAL_TASKS_KEY);
  if (!all) return [];
  return Object.values(all)
    .filter((t) => t && !t.resolvedAt)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/**
 * Resolve a critical task by its dedupe key.
 */
export async function resolveCriticalTask(id: string): Promise<boolean> {
  if (!redis) return false;
  const task = await redis.hget<CriticalTask>(CRITICAL_TASKS_KEY, id);
  if (!task) return false;
  task.resolvedAt = new Date().toISOString();
  await redis.hset(CRITICAL_TASKS_KEY, { [id]: task });
  return true;
}
