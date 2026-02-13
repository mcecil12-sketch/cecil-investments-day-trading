import { redis } from "@/lib/redis";
import { getTtlSeconds, setWithTtl } from "@/lib/redis/ttl";

const KEY_PREFIX = "funnel:v2:";
const TTL_SECONDS = getTtlSeconds("FUNNEL_DAYS");

const NUMERIC_COUNTERS = [
  "scansRun",
  "scansSkipped",
  "candidatesFound",
  "signalsPosted",
  "signalsReceived",
  "gptScored",
  "qualified",
  "shownInApp",
  "approvals",
  "ordersPlaced",
  "fills",
  "drainsRun",
  "drainScored",
  "drainTimeout",
  "drainError",
  "errorInsufficientBars",
  "skipInsufficientBars",
  "errorLiquidityDollarVol",
  "errorParseFailed",
  "errorRateLimited",
  "aiRateLimitErrors",
  "aiTimeoutErrors",
  "aiBreakerOpened",
  "aiDirectionLong",
  "aiDirectionShort",
  "aiDirectionNone",
  "autoEntryExecutes",
  "autoEntryPlaced",
  "autoEntrySkipMaxOpen",
  "autoEntrySkipNoPending",
  "autoEntrySkipMarketClosed",
] as const;

type NumericCounterKey = (typeof NUMERIC_COUNTERS)[number];

type FunnelCounters = Record<NumericCounterKey, number>;

type BumpFields = Partial<FunnelCounters> & {
  gptScoredByModel?: Record<string, number>;
};

type BumpOptions = {
  mode?: string | null;
  source?: string | null;
  runId?: string | null;
  status?: string | null;
};

export type FunnelToday = FunnelCounters & {
  date: string;
  updatedAt: string;
  scanRunsByMode: Record<string, number>;
  scanSkipsByMode: Record<string, number>;
  lastScanAt: string | null;
  lastScanMode: string | null;
  lastScanSource: string | null;
  lastScanRunId: string | null;
  lastScanStatus: string | null;
  gptScoredByModel: Record<string, number>;
};

function etDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function defaultToday(date: string): FunnelToday {
  const now = new Date().toISOString();
  return {
    date,
    updatedAt: now,
    scanRunsByMode: {},
    scanSkipsByMode: {},
    lastScanAt: null,
    lastScanMode: null,
    lastScanSource: null,
    lastScanRunId: null,
    lastScanStatus: null,
    gptScoredByModel: {},
    ...NUMERIC_COUNTERS.reduce((acc, key) => {
      acc[key] = 0;
      return acc;
    }, {} as FunnelCounters),
  };
}

function targetKey(date: string) {
  return `${KEY_PREFIX}${date}`;
}

async function persistToday(today: FunnelToday) {
  if (!redis) return;
  const ttl = getTtlSeconds("FUNNEL_DAYS");
  await setWithTtl(redis, targetKey(today.date), today, ttl);
}

export async function readTodayFunnel(): Promise<FunnelToday> {
  const date = etDate();
  const key = targetKey(date);
  if (!redis) return defaultToday(date);
  const stored = (await redis.get<FunnelToday>(key)) ?? defaultToday(date);
  return stored;
}

export async function bumpTodayFunnel(
  fields: BumpFields,
  opts: BumpOptions = {}
): Promise<FunnelToday> {
  const date = etDate();
  const key = targetKey(date);
  const now = new Date().toISOString();
  const base = redis ? (await redis.get<FunnelToday>(key)) ?? defaultToday(date) : defaultToday(date);

  const next: FunnelToday = {
    ...base,
    scanRunsByMode: { ...(base.scanRunsByMode ?? {}) },
    scanSkipsByMode: { ...(base.scanSkipsByMode ?? {}) },
    gptScoredByModel: { ...(base.gptScoredByModel ?? {}) },
    updatedAt: now,
    date,
  };

  for (const key of NUMERIC_COUNTERS) {
    const delta = fields[key];
    if (typeof delta === "number" && delta !== 0) {
      next[key] = (next[key] ?? 0) + delta;
    }
  }

  if (fields.gptScoredByModel) {
    for (const [model, value] of Object.entries(fields.gptScoredByModel)) {
      if (typeof value !== "number") continue;
      next.gptScoredByModel[model] = (next.gptScoredByModel[model] ?? 0) + value;
    }
  }

  if (opts.mode) {
    if (fields.scansRun) {
      next.scanRunsByMode[opts.mode] = (next.scanRunsByMode[opts.mode] ?? 0) + fields.scansRun;
    }
    if (fields.scansSkipped) {
      next.scanSkipsByMode[opts.mode] = (next.scanSkipsByMode[opts.mode] ?? 0) + fields.scansSkipped;
    }
    next.lastScanMode = opts.mode;
  }

  if (opts.source) next.lastScanSource = opts.source;
  if (opts.runId) next.lastScanRunId = opts.runId;
  if (opts.status) next.lastScanStatus = opts.status;
  next.lastScanAt = now;

  await persistToday(next);
  return next;
}

export async function bumpScanRun(mode: string, opts: BumpOptions = {}) {
  return bumpTodayFunnel(
    { scansRun: 1 },
    { ...opts, mode, status: opts.status ?? "RUN" }
  );
}

export async function bumpScanSkip(mode: string, opts: BumpOptions = {}) {
  return bumpTodayFunnel(
    { scansRun: 1, scansSkipped: 1 },
    { ...opts, mode, status: opts.status ?? "SKIP" }
  );
}
