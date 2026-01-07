import { redis } from "@/lib/redis";
import type { DailyScorecard } from "./types";

function keyFor(dateET: string) {
  return `scorecard:daily:v1:${dateET}`;
}

export async function writeDailyScorecard(dateET: string, card: DailyScorecard) {
  if (!redis) {
    return { ok: false as const, key: keyFor(dateET), error: "redis_unavailable" };
  }
  const key = keyFor(dateET);
  const payload = JSON.stringify(card);
  // Keep 120 days of history
  await redis.set(key, payload, { ex: 60 * 60 * 24 * 120 });
  return { ok: true as const, key };
}

export async function readDailyScorecard(dateET: string) {
  if (!redis) {
    return { ok: false as const, found: false as const, key: keyFor(dateET), card: null, error: "redis_unavailable" };
  }
  const key = keyFor(dateET);
  const raw = await redis.get<string>(key);
  if (!raw) return { ok: true as const, found: false as const, key, card: null };
  try {
    const parsed = JSON.parse(raw) as DailyScorecard;
    return { ok: true as const, found: true as const, key, card: parsed };
  } catch {
    return { ok: false as const, found: false as const, key, card: null, error: "invalid_json" };
  }
}
