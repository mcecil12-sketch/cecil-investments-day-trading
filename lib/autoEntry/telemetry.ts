import { redis } from "@/lib/redis";

export type AutoEntryOutcome = "SUCCESS" | "SKIP" | "FAIL";

export type AutoEntryTelemetryEvent = {
  etDate: string;   // YYYY-MM-DD (ET)
  at: string;       // ISO timestamp
  outcome: AutoEntryOutcome;
  reason?: string;
  ticker?: string;
  tradeId?: string;
  source?: string;
  runId?: string;
};

const PREFIX = "autoentry:telemetry:v1";

function dayKey(etDate: string) {
  return `${PREFIX}:day:${etDate}`;
}

function runsKey(etDate: string) {
  return `${PREFIX}:runs:${etDate}`;
}

function unwrapRedisResult<T>(x: any): T {
  if (x && typeof x === "object" && "result" in x) return (x as any).result as T;
  return x as T;
}

async function safeLpush(key: string, value: string) {
  if (!redis) return;
  const client: any = redis;
  try {
    if (typeof client.lpush === "function") {
      await client.lpush(key, value);
      return;
    }
  } catch {}
  try {
    if (typeof client.rpush === "function") {
      await client.rpush(key, value);
      return;
    }
  } catch {}
}

async function safeLtrim(key: string, start: number, stop: number) {
  if (!redis) return;
  const client: any = redis;
  try {
    if (typeof client.ltrim === "function") {
      await client.ltrim(key, start, stop);
      return;
    }
  } catch {}
}

async function safeLrange(key: string, start: number, stop: number): Promise<string[]> {
  if (!redis) return [];
  const client: any = redis;
  try {
    if (typeof client.lrange === "function") {
      const raw = await client.lrange(key, start, stop);
      const value = unwrapRedisResult<any>(raw);
      return Array.isArray(value) ? value : [];
    }
  } catch {}
  return [];
}

export async function recordAutoEntryTelemetry(e: AutoEntryTelemetryEvent) {
  try {
    if (!redis) return;
    const dk = dayKey(e.etDate);
    const rk = runsKey(e.etDate);

    const reason = String(e.reason || "unknown").toLowerCase();
    const outcome = e.outcome;

    await redis.hincrby(dk, "runs", 1);
    if (outcome === "SUCCESS") await redis.hincrby(dk, "success", 1);
    if (outcome === "SKIP") {
      await redis.hincrby(dk, "skipped", 1);
      await redis.hincrby(dk, `skip:${reason}`, 1);
    }
    if (outcome === "FAIL") await redis.hincrby(dk, "failed", 1);

    await redis.hset(dk, {
      lastRunAt: e.at,
      lastOutcome: outcome,
      lastReason: reason,
      lastTicker: e.ticker ?? "",
      lastTradeId: e.tradeId ?? "",
      lastSource: e.source ?? "",
      lastRunId: e.runId ?? "",
    });

    await safeLpush(rk, JSON.stringify(e));
    await safeLtrim(rk, 0, 199);

    await redis.expire(dk, 60 * 60 * 24 * 35);
    await redis.expire(rk, 60 * 60 * 24 * 35);
  } catch {
    // never break auto-entry for telemetry
  }
}

export async function readAutoEntryTelemetry(etDate: string, limit: number = 50) {
  if (!redis) return { etDate, summary: {}, runs: [] };
  const dk = dayKey(etDate);
  const rk = runsKey(etDate);

  const summary = await redis.hgetall(dk);
  const rows = await safeLrange(rk, 0, Math.max(0, limit - 1));

  const runs = (rows || [])
    .map((x: any) => {
      try { return JSON.parse(String(x)); } catch { return null; }
    })
    .filter(Boolean);

  return { etDate, summary, runs };
}
