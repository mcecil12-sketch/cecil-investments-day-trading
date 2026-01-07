import { redis } from "@/lib/redis";
import type { DailyScorecard } from "./types";

function unwrapRedisValue(input: any): any {
  if (input == null) return null;
  if (typeof input === "string") return input;

  if (typeof input === "object") {
    if ("result" in input) return (input as any).result;
    if ("value" in input) return (input as any).value;
  }
  return input;
}

function parseMaybeJson(value: any): any {
  const v = unwrapRedisValue(value);
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return { __parseError: true, __raw: s };
    }
  }
  return v;
}

export function dailyScorecardKey(dateET: string) {
  return `scorecard:daily:v1:${dateET}`;
}

export async function readDailyScorecard(dateET: string) {
  if (!redis) {
    return { ok: false as const, key: dailyScorecardKey(dateET), error: "redis_unavailable" as const };
  }
  const key = dailyScorecardKey(dateET);
  const raw = await redis.get(key);
  const parsed = parseMaybeJson(raw);
  if (parsed && parsed.__parseError) {
    return { ok: false as const, key, error: "invalid_json" as const };
  }
  if (!parsed) {
    return { ok: true as const, key, found: false as const, scorecard: null };
  }
  return { ok: true as const, key, found: true as const, scorecard: parsed as DailyScorecard };
}

export async function writeDailyScorecard(dateET: string, scorecard: DailyScorecard) {
  if (!redis) {
    return { ok: false as const, key: dailyScorecardKey(dateET), error: "redis_unavailable" as const };
  }
  const key = dailyScorecardKey(dateET);
  const payload = JSON.stringify(scorecard);
  // Keep 120 days of history
  await redis.set(key, payload, { ex: 60 * 60 * 24 * 120 });
  return { ok: true as const, key };
}
