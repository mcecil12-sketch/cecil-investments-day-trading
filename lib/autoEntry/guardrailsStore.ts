import { redis } from "@/lib/redis";
import { GuardrailConfig } from "./guardrails";
import { getTtlSeconds, ensureExpire } from "@/lib/redis/ttl";

const PREFIX = "ae:guardrails:v1";
const ENABLE_KEY = "ae:auto-entry:enabled";
const ENABLE_REASON_KEY = "ae:auto-entry:enabledReason";

function guardKey(etDate: string) {
  return `${PREFIX}:${etDate}`;
}

function tickerField(ticker: string) {
  return `lastTickerEntryAt:${ticker.toUpperCase()}`;
}

export type GuardrailState = {
  entriesToday: number;
  lastEntryAt: string | null;
  lastLossAt: string | null;
  consecutiveFailures: number;
  autoDisabledReason: string | null;
  tickerEntries: Record<string, string>;
};

export async function getGuardrailsState(etDate: string): Promise<GuardrailState> {
  if (!redis) {
    return {
      entriesToday: 0,
      lastEntryAt: null,
      lastLossAt: null,
      consecutiveFailures: 0,
      autoDisabledReason: null,
      tickerEntries: {},
    };
  }

  const data = (await redis.hgetall(guardKey(etDate))) ?? {};
  const entriesToday = Number(data.entriesToday ?? 0) || 0;
  const consecutiveFailures = Number(data.consecutiveFailures ?? 0) || 0;
  const tickerEntries: Record<string, string> = {};
  Object.entries(data).forEach(([field, value]) => {
    if (field.startsWith("lastTickerEntryAt:") && value) {
      const ticker = field.split(":")[1];
      tickerEntries[ticker.toUpperCase()] = String(value);
    }
  });

  const lastEntryAt = typeof data.lastEntryAt === "string" ? data.lastEntryAt : null;
  const lastLossAt = typeof data.lastLossAt === "string" ? data.lastLossAt : null;
  const autoDisabledReason =
    typeof data.autoDisabledReason === "string" ? data.autoDisabledReason : null;

  return {
    entriesToday,
    lastEntryAt,
    lastLossAt,
    consecutiveFailures,
    autoDisabledReason,
    tickerEntries,
  };
}

export async function bumpEntry(etDate: string, ticker: string) {
  if (!redis) return;
  const now = new Date().toISOString();
  const key = guardKey(etDate);
  await redis.hincrby(key, "entriesToday", 1);
  await redis.hset(key, { lastEntryAt: now });
  await redis.hset(key, { [tickerField(ticker)]: now });
  const ttl = getTtlSeconds("GUARDRAILS_DAYS");
  await ensureExpire(redis, key, ttl);
}

export async function resetFailures(etDate: string) {
  if (!redis) return;
  const key = guardKey(etDate);
  await redis.hset(key, { consecutiveFailures: "0" });
  await redis.hdel(key, "autoDisabledReason");
  const ttl = getTtlSeconds("GUARDRAILS_DAYS");
  await ensureExpire(redis, key, ttl);
}

export async function recordFailure(etDate: string, reason: string, opts?: { markLoss?: boolean }) {
  if (!redis) return 0;
  const key = guardKey(etDate);
  const now = new Date().toISOString();
  if (opts?.markLoss) {
    await redis.hset(key, { lastLossAt: now });
  }
  const count = await redis.hincrby(key, "consecutiveFailures", 1);
  const ttl = getTtlSeconds("GUARDRAILS_DAYS");
  await ensureExpire(redis, key, ttl);
  return count;
}

export async function setAutoDisabled(etDate: string, reason: string) {
  if (!redis) return;
  const key = guardKey(etDate);
  await redis.hset(key, { autoDisabledReason: reason });
  const ttl = getTtlSeconds("GUARDRAILS_DAYS");
  await ensureExpire(redis, key, ttl);
}

export async function clearAutoDisabled(etDate: string) {
  if (!redis) return;
  await redis.hdel(guardKey(etDate), "autoDisabledReason");
}

export async function resetGuardrails(etDate: string, opts?: { resetEntries?: boolean; resetFailures?: boolean; clearAutoDisabled?: boolean; clearLoss?: boolean }) {
  if (!redis) return;
  const key = guardKey(etDate);
  if (opts?.resetEntries) {
    await redis.hset(key, { entriesToday: "0" });
  }
  if (opts?.resetFailures) {
    await redis.hset(key, { consecutiveFailures: "0" });
  }
  if (opts?.clearAutoDisabled) {
    await redis.hdel(key, "autoDisabledReason");
  }
  if (opts?.clearLoss) {
    await redis.hdel(key, "lastLossAt");
  }
}

export async function recordLoss(etDate: string, atIso: string) {
  if (!redis) return;
  const key = guardKey(etDate);
  await redis.hset(key, { lastLossAt: atIso });
  const ttl = getTtlSeconds("GUARDRAILS_DAYS");
  await ensureExpire(redis, key, ttl);
}

function parseBooleanFlag(value: string | null | undefined): boolean | null {
  if (value == null) return null;
  const normalized = value.toString().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

export async function getAutoEntryEnabledState(
  config: GuardrailConfig
): Promise<{ enabled: boolean; reason: string | null }> {
  if (!redis) {
    return {
      enabled: config.enabled,
      reason: null,
    };
  }

  const [value, reason] = (await Promise.all([
    redis.get(ENABLE_KEY),
    redis.get(ENABLE_REASON_KEY),
  ])) as [string | null, string | null];
  const parsed = parseBooleanFlag(value);
  if (parsed === null) {
    return {
      enabled: config.enabled,
      reason: reason ?? null,
    };
  }

  return {
    enabled: parsed,
    reason: reason ?? null,
  };
}

export async function setAutoEntryEnabled(enabled: boolean, reason?: string) {
  if (!redis) return;
  const multi = redis.multi();
  multi.set(ENABLE_KEY, enabled ? "1" : "0");
  if (reason) {
    multi.set(ENABLE_REASON_KEY, reason);
  } else {
    multi.del(ENABLE_REASON_KEY);
  }
  await multi.exec();
}
