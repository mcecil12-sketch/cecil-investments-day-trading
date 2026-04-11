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

export type CriticalTaskStatus = "open" | "resolved" | "expected_fail" | "expired";

export interface CriticalTask {
  id: string;
  incidentCode: string;
  symbol: string;
  severity: string;
  detail: string;
  createdAt: string;
  resolvedAt?: string;
  /** True for self-heal drills / synthetic tests. */
  synthetic?: boolean;
  /** ISO timestamp after which the task auto-expires. */
  expiresAt?: string | null;
  /** Lifecycle status for richer tracking. */
  status?: CriticalTaskStatus;
  /** Last time resolution was attempted. */
  lastAttemptAt?: string | null;
  /** Human-readable reason for resolution / expiry. */
  resolutionReason?: string | null;
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
  if (existing && !existing.resolvedAt && existing.status !== "expired" && existing.status !== "expected_fail") return existing;

  const entry: CriticalTask = {
    id: dedupeKey,
    incidentCode: task.incidentCode,
    symbol: task.symbol,
    severity: task.severity,
    detail: task.detail,
    createdAt: now.toISOString(),
    synthetic: task.synthetic ?? false,
    expiresAt: task.expiresAt ?? null,
    status: task.status ?? "open",
    lastAttemptAt: null,
    resolutionReason: null,
  };

  await redis.hset(CRITICAL_TASKS_KEY, { [dedupeKey]: entry });
  return entry;
}

/**
 * Get all unresolved critical tasks, sorted newest-first.
 * Auto-expires tasks whose expiresAt has passed.
 */
export async function getCriticalTasks(): Promise<CriticalTask[]> {
  if (!redis) return [];
  const all = await redis.hgetall<Record<string, CriticalTask>>(CRITICAL_TASKS_KEY);
  if (!all) return [];
  const now = Date.now();
  const unresolved: CriticalTask[] = [];
  for (const t of Object.values(all)) {
    if (!t) continue;
    if (t.resolvedAt || t.status === "resolved" || t.status === "expired" || t.status === "expected_fail") continue;
    // Auto-expire if TTL passed
    if (t.expiresAt && Date.parse(t.expiresAt) <= now) {
      t.status = "expired";
      t.resolvedAt = new Date().toISOString();
      t.resolutionReason = "ttl_expired";
      await redis.hset(CRITICAL_TASKS_KEY, { [t.id]: t }).catch(() => {});
      continue;
    }
    unresolved.push(t);
  }
  return unresolved.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/** Partition critical tasks into blocking (real) and non-blocking (synthetic). */
export function partitionCriticalTasks(tasks: CriticalTask[]): {
  blocking: CriticalTask[];
  synthetic: CriticalTask[];
} {
  const blocking: CriticalTask[] = [];
  const synthetic: CriticalTask[] = [];
  for (const t of tasks) {
    if (t.synthetic) synthetic.push(t);
    else blocking.push(t);
  }
  return { blocking, synthetic };
}

/** Transition a synthetic task to expected_fail or expired. */
export async function expireSyntheticTask(id: string, reason: string): Promise<boolean> {
  if (!redis) return false;
  const task = await redis.hget<CriticalTask>(CRITICAL_TASKS_KEY, id);
  if (!task || !task.synthetic) return false;
  task.status = "expected_fail";
  task.resolvedAt = new Date().toISOString();
  task.resolutionReason = reason;
  await redis.hset(CRITICAL_TASKS_KEY, { [id]: task });
  return true;
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
