import { redis } from "@/lib/redis";
import { getBudgetState, addSpend } from "@/lib/aiBudget";
import { getFunnelDayKey } from "@/lib/funnelMetrics";

export type AiMetrics = {
  date: string; // YYYY-MM-DD (ET)
  calls: number;
  byModel: Record<string, number>;
  lastHeartbeat: string | null;
  errors: Record<string, number>;
};

function isoNow() {
  return new Date().toISOString();
}

function etDateKey(): string {
  return getFunnelDayKey();
}

function metricsKey(date: string) {
  return `ai:metrics:v1:${date}`;
}

const HEARTBEAT_KEY = "ai:heartbeat:v1";

export async function getAiMetrics(date = etDateKey()): Promise<AiMetrics> {
  const base: AiMetrics = {
    date,
    calls: 0,
    byModel: {},
    lastHeartbeat: null,
    errors: {},
  };

  if (!redis) return base;

  const m = (await redis.get<AiMetrics>(metricsKey(date))) ?? base;
  const hb = (await redis.get<string>(HEARTBEAT_KEY)) ?? null;

  return {
    ...m,
    date,
    lastHeartbeat: hb,
  };
}

export async function recordHeartbeat(): Promise<void> {
  if (!redis) return;
  await redis.set(HEARTBEAT_KEY, isoNow());
}

export async function writeAiHeartbeat(): Promise<void> {
  if (!redis) return;
  const date = etDateKey();
  const key = metricsKey(date);
  const current =
    (await redis.get<AiMetrics>(key)) ?? {
      date,
      calls: 0,
      byModel: {},
      lastHeartbeat: null,
      errors: {},
    };
  current.lastHeartbeat = isoNow();
  await redis.set(key, current);
}

export async function recordAiCall(model: string): Promise<void> {
  if (!redis) return;

  const date = etDateKey();
  const key = metricsKey(date);

  const current =
    (await redis.get<AiMetrics>(key)) ?? {
      date,
      calls: 0,
      byModel: {},
      lastHeartbeat: null,
    };

  current.calls = (current.calls ?? 0) + 1;
  const counts = (current.byModel ?? {}) as Record<string, number>;
  counts[model] = (counts[model] ?? 0) + 1;
  current.byModel = counts;

  await redis.set(key, current);
}

export async function recordAiError(model: string, message: string): Promise<void> {
  if (!redis) return;

  const date = etDateKey();
  const key = metricsKey(date);

  const current =
    (await redis.get<AiMetrics>(key)) ?? {
      date,
      calls: 0,
      byModel: {},
      lastHeartbeat: null,
      errors: {},
    };

  const errCounts = (current.errors ?? {}) as Record<string, number>;
  errCounts[model] = (errCounts[model] ?? 0) + 1;
  current.errors = errCounts;

  await redis.set(key, current);
}

export async function recordSpend(model: string, amountUsd: number): Promise<void> {
  try {
    await addSpend({ model, amountUsd });
  } catch (e: any) {
    console.log("[aiMetrics] recordSpend failed (non-fatal):", e?.message ?? String(e));
  }
}

export async function readTodayAiMetrics() {
  const date = etDateKey();
  const [budget, metrics] = await Promise.all([
    getBudgetState(date),
    getAiMetrics(date),
  ]);
  return { budget, metrics };
}
