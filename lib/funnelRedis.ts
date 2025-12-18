import { redis } from "@/lib/redis";
import { getTradingDayKey } from "@/lib/tradingDay";

export type FunnelCounters = {
  scansRun: number;
  candidatesFound: number;
  signalsPosted: number;
  signalsReceived: number;
  gptScored: number;
  qualified: number;
  shownInApp: number;
  approvals: number;
  ordersPlaced: number;
  fills: number;
};

export type FunnelStats = FunnelCounters & {
  date: string;
  updatedAt: string;
  gptScoredByModel: Record<string, number>;
};

const TTL_SECONDS = 60 * 60 * 48;

const BASE_COUNTERS: FunnelCounters = {
  scansRun: 0,
  candidatesFound: 0,
  signalsPosted: 0,
  signalsReceived: 0,
  gptScored: 0,
  qualified: 0,
  shownInApp: 0,
  approvals: 0,
  ordersPlaced: 0,
  fills: 0,
};

function keyForDay(date: string) {
  return `funnel:${date}`;
}

function makeEmpty(date: string): FunnelStats {
  return {
    ...BASE_COUNTERS,
    date,
    updatedAt: new Date().toISOString(),
    gptScoredByModel: {},
  };
}

export function getTodayKey() {
  const date = getTradingDayKey();
  return { date, key: keyForDay(date) };
}

export async function readTodayFunnel(): Promise<FunnelStats> {
  const { date, key } = getTodayKey();
  if (!redis) {
    return makeEmpty(date);
  }
  const stored = (await redis.get<FunnelStats>(key)) ?? makeEmpty(date);
  return {
    ...makeEmpty(date),
    ...stored,
    date,
    updatedAt: stored.updatedAt ?? new Date().toISOString(),
    gptScoredByModel: { ...(stored.gptScoredByModel ?? {}) },
  };
}

export async function bumpTodayFunnel(
  updates: Partial<FunnelCounters> & {
    gptScoredByModel?: Record<string, number>;
  }
): Promise<FunnelStats> {
  const { date, key } = getTodayKey();
  const now = new Date().toISOString();
  const { gptScoredByModel, ...rest } = updates;
  const countersUpdate = rest as Partial<FunnelCounters>;

  if (!redis) {
    const fallback = makeEmpty(date);
    for (const [field, value] of Object.entries(countersUpdate)) {
      if (typeof value !== "number") continue;
      const keyField = field as keyof FunnelCounters;
      fallback[keyField] = (fallback[keyField] ?? 0) + value;
    }
    if (gptScoredByModel) {
      for (const [model, value] of Object.entries(gptScoredByModel)) {
        if (typeof value !== "number") continue;
        fallback.gptScoredByModel[model] =
          (fallback.gptScoredByModel[model] ?? 0) + value;
      }
    }
    fallback.updatedAt = now;
    return fallback;
  }

  const base = (await redis.get<FunnelStats>(key)) ?? makeEmpty(date);
  const next: FunnelStats = {
    ...makeEmpty(date),
    ...base,
    date,
    updatedAt: now,
    gptScoredByModel: { ...(base.gptScoredByModel ?? {}) },
  };

  for (const [field, value] of Object.entries(countersUpdate)) {
    if (typeof value !== "number") continue;
    const keyField = field as keyof FunnelCounters;
    next[keyField] = (next[keyField] ?? 0) + value;
  }

  if (gptScoredByModel) {
    for (const [model, value] of Object.entries(gptScoredByModel)) {
      if (typeof value !== "number") continue;
      next.gptScoredByModel[model] =
        (next.gptScoredByModel[model] ?? 0) + value;
    }
  }

  await redis.set(key, next, { ex: TTL_SECONDS });
  return next;
}
