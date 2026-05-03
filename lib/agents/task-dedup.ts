/**
 * Task Dedup — 24-hour rolling dedup window for auto-generated tasks.
 *
 * Prevents adaptive guardrails and profit engine from creating duplicate
 * engineering tasks within a 24-hour window. Uses Redis key presence as
 * the dedup signal; TTL auto-cleans after the window expires.
 */

import { redis } from "@/lib/redis";

const DEDUP_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const KEY_PREFIX = "agents:task_dedup:";

/**
 * Normalise a task title into a stable, short dedup key segment.
 * Strip special chars, lowercase, collapse spaces → underscores.
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
 * Returns `true` if a task with this title was already created within the
 * last 24 hours (i.e. it is a duplicate and should be skipped).
 *
 * Returns `false` and atomically marks the title as "seen" when the task is
 * genuinely new.
 */
export async function isRecentDuplicateTask(title: string): Promise<boolean> {
  if (!redis) return false; // no Redis → allow task creation
  const key = KEY_PREFIX + normaliseTitle(title);
  // SET NX EX atomically: only sets if absent; returns "OK" when set, null when already present
  const result = await redis.set(key, "1", { nx: true, ex: DEDUP_TTL_SECONDS });
  // "OK" means we just set it → task is new
  // null means key already existed → task is a duplicate
  return result === null;
}
