import { redis } from "@/lib/redis";
import { ensureExpire, getTtlSeconds, trimList } from "@/lib/redis/ttl";

type AnyRecord = Record<string, any>;

export type SeedSkipReason =
  | "already_active_trade"
  | "already_terminal_trade"
  | "missing_prices"
  | "missing_direction"
  | "missing_signal_id"
  | "market_closed"
  | "capacity_full"
  | "below_threshold"
  | "stale_signal"
  | "duplicate_symbol"
  | "overlay_block";

export type SeedSignalSkip = {
  signalId: string;
  symbol: string;
  reason: SeedSkipReason;
  ageMs?: number | null;
};

export type SeedRunTelemetry = {
  runAt: string;
  source: string;
  marketOpen: boolean;
  totalQualifiedSignals: number;
  freshQualifiedSignals?: number;
  staleQualifiedSignals?: number;
  totalCandidates: number;
  createdCount: number;
  staleThresholdUsedMs?: number;
  skippedByReason: Partial<Record<SeedSkipReason, number>>;
  skippedQualifiedSignals: SeedSignalSkip[];
  dryRun?: boolean;
  debug?: boolean;
  runId?: string;
};

const PREFIX = "autoentry:seed:v1";

function dayKey(etDate: string) {
  return `${PREFIX}:day:${etDate}`;
}

function runsKey(etDate: string) {
  return `${PREFIX}:runs:${etDate}`;
}

function latestKey() {
  return `${PREFIX}:latest`;
}

function unwrapRedisResult<T>(value: any): T {
  if (value && typeof value === "object" && "result" in value) {
    return (value as AnyRecord).result as T;
  }
  return value as T;
}

async function safeLpush(key: string, value: string) {
  if (!redis) return;
  try {
    await redis.lpush(key, value);
  } catch {
    // non-fatal
  }
}

async function safeLrange(key: string, start: number, stop: number): Promise<string[]> {
  if (!redis) return [];
  try {
    const raw = await redis.lrange(key, start, stop);
    const rows = unwrapRedisResult<any>(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function parseRow(row: any): SeedRunTelemetry | null {
  if (!row && row !== 0) return null;
  if (typeof row === "object") {
    if (typeof row.runAt === "string" && typeof row.source === "string") return row as SeedRunTelemetry;
  }
  const text = String(row || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.runAt === "string" && typeof parsed?.source === "string") {
      return parsed as SeedRunTelemetry;
    }
  } catch {
    return null;
  }
  return null;
}

export async function recordSeedRunTelemetry(etDate: string, run: SeedRunTelemetry): Promise<void> {
  if (!redis) return;

  try {
    const dk = dayKey(etDate);
    const rk = runsKey(etDate);
    const now = run.runAt || new Date().toISOString();

    await redis.hset(dk, {
      lastRunAt: run.runAt,
      lastSource: run.source,
      marketOpen: run.marketOpen ? "1" : "0",
      totalQualifiedSignals: run.totalQualifiedSignals,
      freshQualifiedSignals: run.freshQualifiedSignals ?? 0,
      staleQualifiedSignals: run.staleQualifiedSignals ?? 0,
      totalCandidates: run.totalCandidates,
      createdCount: run.createdCount,
      staleThresholdUsedMs: run.staleThresholdUsedMs ?? 0,
      updatedAt: now,
      skippedByReason: JSON.stringify(run.skippedByReason || {}),
      skippedQualifiedSignalsCount: Array.isArray(run.skippedQualifiedSignals) ? run.skippedQualifiedSignals.length : 0,
      dryRun: run.dryRun ? "1" : "0",
      debug: run.debug ? "1" : "0",
      runId: run.runId || "",
    });

    await safeLpush(rk, JSON.stringify(run));
    await trimList(redis, rk, 200);
    await redis.set(latestKey(), run, { ex: getTtlSeconds("TELEMETRY_DAYS") });

    const ttl = getTtlSeconds("TELEMETRY_DAYS");
    await ensureExpire(redis, dk, ttl);
    await ensureExpire(redis, rk, ttl);
  } catch {
    // never break seeding for telemetry
  }
}

export async function readLatestSeedRunTelemetry(etDate?: string): Promise<SeedRunTelemetry | null> {
  if (!redis) return null;

  try {
    if (etDate) {
      const rows = await safeLrange(runsKey(etDate), 0, 0);
      const parsed = parseRow(rows[0]);
      if (parsed) return parsed;
    }

    const latest = await redis.get<SeedRunTelemetry>(latestKey());
    if (latest && typeof latest === "object") {
      return latest as SeedRunTelemetry;
    }
  } catch {
    // fall through
  }

  return null;
}
