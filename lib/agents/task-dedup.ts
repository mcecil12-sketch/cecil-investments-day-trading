/**
 * Task Dedup — 24-hour rolling dedup window for auto-generated tasks.
 *
 * Prevents adaptive guardrails and profit engine from creating duplicate
 * engineering tasks within a 24-hour window.
 *
 * Provides:
 *   - Hash-based dedupeKey from title + findingId + suggestedAction + targetFiles
 *   - Occurrence counting (increments on each duplicate attempt)
 *   - Execution lock (SET NX 24h) to prevent concurrent execution of same task
 *   - Fix-class suppression: certain re-optimization classes require new trade data
 *   - Dedup stats: counters for skipped duplicate / insufficient data executions
 */

import { createHash } from "crypto";
import { redis } from "@/lib/redis";
import { AGENT_EXECUTION_DEDUP_STATS_KEY } from "@/lib/agents/keys";

// ─── Fix-class suppression ────────────────────────────────────────────
//
// These fix classes perform re-optimization. They MUST NOT re-execute
// within 24h unless at least REOPT_MIN_NEW_TRADES new closed trades exist
// since the last fix. This prevents repeated low-value adaptive loops.

/**
 * Fix classes that require newClosedTradesSinceLastFix >= REOPT_MIN_NEW_TRADES
 * before re-execution is allowed.
 */
export const REOPT_FIX_CLASSES: ReadonlySet<string> = new Set([
  "tier_C_high_loss_rate",
  "negative_avg_r",
  "scoring_quality_degraded",
  "win_rate_low",
]);

export const REOPT_MIN_NEW_TRADES = 3;

const DEDUP_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const LOCK_TTL_SECONDS = 24 * 60 * 60;  // 24 hours
const META_PREFIX = "agents:task_dedup_meta:";
const LOCK_PREFIX = "agents:execution_lock:";

interface DedupMeta {
  taskId: string;
  title: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastExecutedAt?: string;
}

/**
 * Normalise a task title into a stable string segment.
 * Strips bracket-prefixes ([Adaptive], [ProfitEngine]), lowercases, collapses
 * non-alphanumeric runs to underscores.
 */
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\[.*?\]/g, "") // strip [Adaptive], [ProfitEngine] etc.
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

/**
 * Build a stable 24-char hex dedupeKey from title + optional extra context.
 * All callers should pass as much context as available for precision.
 */
export function buildDedupeKey(
  title: string,
  findingId?: string,
  suggestedAction?: string,
  targetFiles?: string[],
): string {
  const normalized = normaliseTitle(title);
  const extra = [findingId, suggestedAction, ...(targetFiles ?? [])]
    .filter(Boolean)
    .join("|");
  const raw = extra ? `${normalized}|${extra}` : normalized;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

/**
 * Check if a task with this dedupeKey was seen in the last 24 hours.
 * If a duplicate: increments occurrenceCount and returns `isDuplicate=true`.
 * If new: records the metadata and returns `isDuplicate=false`.
 *
 * Always call with the taskId that *would* be created — it is stored only when new.
 */
export async function checkAndRecordTaskDedup(
  dedupeKey: string,
  taskId: string,
  title: string,
): Promise<{ isDuplicate: boolean; duplicateOfTaskId: string | null; occurrenceCount: number }> {
  if (!redis) return { isDuplicate: false, duplicateOfTaskId: null, occurrenceCount: 1 };

  const metaKey = META_PREFIX + dedupeKey;
  const existingRaw = await redis.get<string>(metaKey).catch(() => null);

  if (existingRaw) {
    // Duplicate — increment occurrence count
    let meta: DedupMeta;
    try {
      meta = typeof existingRaw === "string" ? JSON.parse(existingRaw) : (existingRaw as DedupMeta);
    } catch {
      meta = { taskId, title, occurrenceCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
    }
    const updatedMeta: DedupMeta = {
      ...meta,
      occurrenceCount: (meta.occurrenceCount ?? 1) + 1,
      lastSeenAt: new Date().toISOString(),
    };
    await redis.set(metaKey, JSON.stringify(updatedMeta), { ex: DEDUP_TTL_SECONDS }).catch(() => null);
    return { isDuplicate: true, duplicateOfTaskId: meta.taskId, occurrenceCount: updatedMeta.occurrenceCount };
  }

  // New — record it
  const meta: DedupMeta = {
    taskId,
    title,
    occurrenceCount: 1,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  await redis.set(metaKey, JSON.stringify(meta), { ex: DEDUP_TTL_SECONDS }).catch(() => null);
  return { isDuplicate: false, duplicateOfTaskId: null, occurrenceCount: 1 };
}

/**
 * Acquire a 24-hour execution lock for the given dedupeKey.
 * Returns `true` when the lock was acquired (safe to proceed).
 * Returns `false` when the lock is already held (another execution is in progress).
 *
 * When no Redis is available, always returns `true` (allow execution).
 */
export async function acquireExecutionLock(dedupeKey: string): Promise<boolean> {
  if (!redis) return true;
  const lockKey = LOCK_PREFIX + dedupeKey;
  const result = await redis.set(lockKey, "1", { nx: true, ex: LOCK_TTL_SECONDS }).catch(() => "OK");
  return result !== null; // "OK" → acquired; null → already locked
}

/**
 * Release the execution lock for a dedupeKey (e.g. after task completes or fails).
 */
export async function releaseExecutionLock(dedupeKey: string): Promise<void> {
  if (!redis) return;
  const lockKey = LOCK_PREFIX + dedupeKey;
  await redis.del(lockKey).catch(() => null);
}

/**
 * Backward-compatible wrapper.
 * Returns `true` if a task with this title is a recent duplicate (24h window).
 */
export async function isRecentDuplicateTask(title: string): Promise<boolean> {
  const key = buildDedupeKey(title);
  const result = await checkAndRecordTaskDedup(key, "unknown", title);
  return result.isDuplicate;
}

// ─── Dedup stats tracking ───────────────────────────────────────────────

interface DedupStats {
  skippedDuplicateExecutionCount: number;
  skippedInsufficientDataCount: number;
  updatedAt: string;
}

const STATS_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (rolling)

async function readDedupStats(): Promise<DedupStats> {
  if (!redis) return { skippedDuplicateExecutionCount: 0, skippedInsufficientDataCount: 0, updatedAt: new Date().toISOString() };
  try {
    const raw = await redis.get<DedupStats>(AGENT_EXECUTION_DEDUP_STATS_KEY);
    if (!raw || typeof raw !== "object") return { skippedDuplicateExecutionCount: 0, skippedInsufficientDataCount: 0, updatedAt: new Date().toISOString() };
    return raw as DedupStats;
  } catch {
    return { skippedDuplicateExecutionCount: 0, skippedInsufficientDataCount: 0, updatedAt: new Date().toISOString() };
  }
}

async function writeDedupStats(stats: DedupStats): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(AGENT_EXECUTION_DEDUP_STATS_KEY, stats, { ex: STATS_TTL_SECONDS });
  } catch {
    // non-fatal
  }
}

/**
 * Record a skipped duplicate execution event.
 */
export async function recordDuplicateExecutionSkip(): Promise<void> {
  const stats = await readDedupStats();
  await writeDedupStats({
    ...stats,
    skippedDuplicateExecutionCount: stats.skippedDuplicateExecutionCount + 1,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Record a skipped-due-to-insufficient-trade-data event.
 */
export async function recordInsufficientDataSkip(): Promise<void> {
  const stats = await readDedupStats();
  await writeDedupStats({
    ...stats,
    skippedInsufficientDataCount: stats.skippedInsufficientDataCount + 1,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Get dedup suppression stats including active lock count.
 */
export async function getDedupStats(): Promise<{
  activeLocks: number;
  skippedDuplicateExecutionCount: number;
  skippedInsufficientDataCount: number;
}> {
  const stats = await readDedupStats();

  // Count active locks via pattern scan (best-effort, non-fatal)
  let activeLocks = 0;
  if (redis) {
    try {
      // Use KEYS pattern scan for lock count estimation
      // This is safe because the lock namespace is small and bounded
      const keys = await (redis as any).keys(`${LOCK_PREFIX}*`).catch(() => [] as string[]);
      activeLocks = Array.isArray(keys) ? keys.length : 0;
    } catch {
      // non-fatal — lock count is best-effort
    }
  }

  return {
    activeLocks,
    skippedDuplicateExecutionCount: stats.skippedDuplicateExecutionCount,
    skippedInsufficientDataCount: stats.skippedInsufficientDataCount,
  };
}
