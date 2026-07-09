import { redis } from "@/lib/redis";
import { getTtlSeconds, ensureExpire, trimList } from "@/lib/redis/ttl";

export type HighPrioritySeedQueueItem = {
  signalId: string;
  symbol: string;
  scoredAt: string;
  qualifiedAt: string;
  aiScore: number;
  aiGrade: string | null;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  etDate: string;
  queuedAt: string;
};

const PREFIX = "autoentry:high_priority_seed_queue:v1";
const QUEUE_KEY = `${PREFIX}:queue`;

function dedupeSignalKey(signalId: string) {
  return `${PREFIX}:dedupe:signal:${signalId}`;
}

function dedupeSymbolDayKey(symbol: string, direction: "LONG" | "SHORT", etDate: string) {
  return `${PREFIX}:dedupe:symdirday:${symbol}:${direction}:${etDate}`;
}

function normalizeSymbol(raw: unknown): string {
  return String(raw || "").trim().toUpperCase();
}

function normalizeDirection(raw: unknown): "LONG" | "SHORT" | null {
  const v = String(raw || "").trim().toUpperCase();
  if (v === "LONG" || v === "SHORT") return v;
  return null;
}

function parseNum(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function enqueueHighPrioritySeedQueue(
  payload: Omit<HighPrioritySeedQueueItem, "queuedAt">
): Promise<{ enqueued: boolean; reason?: string }> {
  if (!redis) return { enqueued: false, reason: "redis_unavailable" };

  const signalId = String(payload.signalId || "").trim();
  const symbol = normalizeSymbol(payload.symbol);
  const direction = normalizeDirection(payload.direction);
  const entry = parseNum(payload.entry);
  const stop = parseNum(payload.stop);
  const target = parseNum(payload.target);
  const aiScore = parseNum(payload.aiScore);
  const etDate = String(payload.etDate || "").trim();

  if (!signalId || !symbol || !direction || !etDate) {
    return { enqueued: false, reason: "invalid_identity" };
  }
  if (!(entry != null && stop != null && target != null && entry > 0 && stop > 0 && target > 0)) {
    return { enqueued: false, reason: "invalid_prices" };
  }
  if (aiScore == null) {
    return { enqueued: false, reason: "invalid_score" };
  }

  const ttl = getTtlSeconds("TELEMETRY_DAYS");
  const signalKey = dedupeSignalKey(signalId);
  const symDayKey = dedupeSymbolDayKey(symbol, direction, etDate);

  try {
    const signalOk = await redis.set(signalKey, "1", { nx: true, ex: Math.max(3600, ttl) });
    if (!signalOk) {
      return { enqueued: false, reason: "duplicate_signal_id" };
    }

    const symDayOk = await redis.set(symDayKey, "1", { nx: true, ex: Math.max(3600, ttl) });
    if (!symDayOk) {
      await redis.del(signalKey).catch(() => null);
      return { enqueued: false, reason: "duplicate_symbol_direction_day" };
    }

    const item: HighPrioritySeedQueueItem = {
      signalId,
      symbol,
      scoredAt: String(payload.scoredAt || new Date().toISOString()),
      qualifiedAt: String(payload.qualifiedAt || payload.scoredAt || new Date().toISOString()),
      aiScore,
      aiGrade: payload.aiGrade ? String(payload.aiGrade) : null,
      direction,
      entry,
      stop,
      target,
      etDate,
      queuedAt: new Date().toISOString(),
    };

    await redis.lpush(QUEUE_KEY, JSON.stringify(item));
    await trimList(redis, QUEUE_KEY, 5000);
    await ensureExpire(redis, QUEUE_KEY, Math.max(3600, ttl));
    return { enqueued: true };
  } catch {
    return { enqueued: false, reason: "redis_error" };
  }
}

export async function drainHighPrioritySeedQueue(maxItems = 250): Promise<HighPrioritySeedQueueItem[]> {
  if (!redis) return [];
  const cap = Math.max(1, Math.min(2000, Math.trunc(maxItems)));

  try {
    const rows = await redis.lrange(QUEUE_KEY, 0, cap - 1);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    await redis.ltrim(QUEUE_KEY, cap, -1).catch(() => null);

    const out: HighPrioritySeedQueueItem[] = [];
    for (const row of rows) {
      try {
        const parsed = typeof row === "string" ? JSON.parse(row) : row;
        if (!parsed || typeof parsed !== "object") continue;
        const signalId = String(parsed.signalId || "").trim();
        const symbol = normalizeSymbol(parsed.symbol);
        const direction = normalizeDirection(parsed.direction);
        const entry = parseNum(parsed.entry);
        const stop = parseNum(parsed.stop);
        const target = parseNum(parsed.target);
        if (!signalId || !symbol || !direction) continue;
        if (!(entry != null && stop != null && target != null && entry > 0 && stop > 0 && target > 0)) continue;
        out.push({
          signalId,
          symbol,
          direction,
          entry,
          stop,
          target,
          scoredAt: String(parsed.scoredAt || ""),
          qualifiedAt: String(parsed.qualifiedAt || parsed.scoredAt || ""),
          aiScore: parseNum(parsed.aiScore) ?? 0,
          aiGrade: parsed.aiGrade ? String(parsed.aiGrade) : null,
          etDate: String(parsed.etDate || ""),
          queuedAt: String(parsed.queuedAt || ""),
        });
      } catch {
        continue;
      }
    }

    return out;
  } catch {
    return [];
  }
}
