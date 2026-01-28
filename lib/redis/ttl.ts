/**
 * Centralized Redis TTL configuration.
 * All values can be overridden via environment variables.
 */

// Convert days to seconds
const daysToSeconds = (days: number) => days * 24 * 60 * 60;
const hoursToSeconds = (hours: number) => hours * 60 * 60;
const minutesToSeconds = (minutes: number) => minutes * 60;

export const REDIS_TTL_CONFIG = {
  // Signals: 7 days default (short-lived, regenerated frequently)
  SIGNALS_DAYS: Number(process.env.REDIS_TTL_SIGNALS_DAYS ?? "7"),

  // Trades: 30 days default (important for reconciliation and history)
  TRADES_DAYS: Number(process.env.REDIS_TTL_TRADES_DAYS ?? "30"),

  // Performance: 365 days (equity curve history useful for dashboards)
  PERFORMANCE_EQUITY_DAYS: Number(process.env.REDIS_TTL_PERF_EQUITY_DAYS ?? "365"),
  PERFORMANCE_SNAPSHOTS_DAYS: Number(process.env.REDIS_TTL_PERF_SNAPSHOTS_DAYS ?? "365"),

  // Funnel/Telemetry: 30 days (daily tracking is enough)
  FUNNEL_DAYS: Number(process.env.REDIS_TTL_FUNNEL_DAYS ?? "30"),
  TELEMETRY_DAYS: Number(process.env.REDIS_TTL_TELEMETRY_DAYS ?? "30"),

  // Auto-entry guardrails: 7 days (daily reset, keep for a week)
  GUARDRAILS_DAYS: Number(process.env.REDIS_TTL_GUARDRAILS_DAYS ?? "7"),

  // Locks: 10 minutes (short-lived, prevent deadlocks)
  LOCK_MINUTES: Number(process.env.REDIS_TTL_LOCK_MINUTES ?? "10"),

  // Dedupe/Notifications: 24 hours
  DEDUPE_HOURS: Number(process.env.REDIS_TTL_DEDUPE_HOURS ?? "24"),

  // AI metrics/heartbeat: 90 days (tracking daily metrics)
  AI_METRICS_DAYS: Number(process.env.REDIS_TTL_AI_METRICS_DAYS ?? "90"),

  // Budget tracking: 30 days
  AI_BUDGET_DAYS: Number(process.env.REDIS_TTL_AI_BUDGET_DAYS ?? "30"),
} as const;

/**
 * Get TTL in seconds for a given category.
 * Returns 0 if ttlSeconds <= 0 (no expiration).
 */
export function getTtlSeconds(category: keyof typeof REDIS_TTL_CONFIG): number {
  const dayOrHourOrMin = REDIS_TTL_CONFIG[category];

  if (category.endsWith("_DAYS")) {
    return daysToSeconds(dayOrHourOrMin);
  } else if (category.endsWith("_HOURS")) {
    return hoursToSeconds(dayOrHourOrMin);
  } else if (category.endsWith("_MINUTES")) {
    return minutesToSeconds(dayOrHourOrMin);
  }

  return 0;
}

/**
 * Safely set expiration on a Redis key.
 * Returns true if expiration was set, false if ttlSeconds <= 0 or redis unavailable.
 */
export async function ensureExpire(
  redis: any,
  key: string,
  ttlSeconds: number
): Promise<boolean> {
  if (!redis || ttlSeconds <= 0) return false;
  try {
    await redis.expire(key, ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely trim a list to max length.
 * Returns the new length, or -1 if error/no-op.
 */
export async function trimList(
  redis: any,
  key: string,
  maxLength: number
): Promise<number> {
  if (!redis || maxLength <= 0) return -1;
  try {
    // Keep items from 0 to maxLength-1 (most recent first)
    await redis.ltrim(key, 0, maxLength - 1);
    return maxLength;
  } catch {
    return -1;
  }
}

/**
 * Set a string key with TTL in one call (Upstash-compatible).
 */
export async function setWithTtl(
  redis: any,
  key: string,
  value: any,
  ttlSeconds: number
): Promise<boolean> {
  if (!redis) return false;
  if (ttlSeconds <= 0) {
    // No TTL, just set
    await redis.set(key, value);
    return true;
  }
  // Upstash Redis supports { ex: seconds }
  await redis.set(key, value, { ex: ttlSeconds });
  return true;
}

/**
 * Helper to push items to a list with TTL.
 * Push first, then trim and expire.
 */
export async function pushWithTtl(
  redis: any,
  key: string,
  value: any,
  ttlSeconds: number,
  maxLength?: number
): Promise<boolean> {
  if (!redis) return false;

  try {
    // Push to list
    await redis.lpush(key, value);

    // Trim if needed
    if (maxLength && maxLength > 0) {
      await trimList(redis, key, maxLength);
    }

    // Set expiration
    if (ttlSeconds > 0) {
      await redis.expire(key, ttlSeconds);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Helper to set a hash with TTL.
 * Set fields first, then expire.
 */
export async function hsetWithTtl(
  redis: any,
  key: string,
  fields: Record<string, any>,
  ttlSeconds: number
): Promise<boolean> {
  if (!redis) return false;

  try {
    await redis.hset(key, fields);

    if (ttlSeconds > 0) {
      await redis.expire(key, ttlSeconds);
    }

    return true;
  } catch {
    return false;
  }
}
