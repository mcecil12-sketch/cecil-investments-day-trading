
import { getAutoConfig, tierForScore, riskMultForTier, AutoTier } from "./config";

type AnySignal = Record<string, any>;
type AnyTrade = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function etDateKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

function safeNum(v: any, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

type EnsureTokenSuccess = {
  ok: true;
  cfg: ReturnType<typeof getAutoConfig>;
};

type EnsureTokenFailure =
  | { ok: false; status: 500; error: "AUTO_ENTRY_TOKEN missing" }
  | { ok: false; status: 401; error: "unauthorized" };

type EnsureTokenResult = EnsureTokenSuccess | EnsureTokenFailure;

function headerToken(req: Request) {
  return req.headers.get("x-auto-entry-token") || "";
}

function ensureToken(req: Request): EnsureTokenResult {
  const cfg = getAutoConfig();
  if (!cfg.token) return { ok: false, status: 500, error: "AUTO_ENTRY_TOKEN missing" as const };
  const got = headerToken(req);
  if (!got || got !== cfg.token) return { ok: false, status: 401, error: "unauthorized" as const };
  return { ok: true as const, cfg };
}

function isMarketHoursGuard() {
  return true;
}

async function redis() {
  const mod = await import("../redis");
  return mod;
}

async function readRecentSignals(limit = 300): Promise<AnySignal[]> {
  const r = await redis();
  if (!r || !r.redis) return [];
  const ids: string[] = await r.redis.lrange("signals:ids", 0, limit - 1);
  if (!ids.length) return [];
  const pipeline = r.redis.pipeline();
  for (const id of ids) pipeline.get(`signal:${id}`);
  const res = await pipeline.exec();
  const out: AnySignal[] = [];
  for (const item of res) {
    const val = (item as [unknown, string | null] | undefined)?.[1];
    if (!val) continue;
    try { out.push(JSON.parse(val)); } catch {}
  }
  return out;
}

async function readTrades(): Promise<AnyTrade[]> {
  const r = await redis();
  if (!r || !r.redis) return [];
  const ids: string[] = await r.redis.lrange("trades:ids", 0, 999);
  if (!ids.length) return [];
  const pipeline = r.redis.pipeline();
  for (const id of ids) pipeline.get(`trade:${id}`);
  const res = await pipeline.exec();
  const out: AnyTrade[] = [];
  for (const item of res) {
    const val = (item as [unknown, string | null] | undefined)?.[1];
    if (!val) continue;
    try { out.push(JSON.parse(val)); } catch {}
  }
  return out;
}

function isOpenTrade(t: AnyTrade) {
  const s = String(t?.status || "").toUpperCase();
  return ["OPEN", "BROKER_PENDING", "UNMANAGED", "MANAGING"].includes(s);
}

async function setnxLock(key: string, ttlSec: number) {
  const r = await redis();
  if (!r || !r.redis) return false;
  const ok = await r.redis.set(key, "1", { nx: true, ex: ttlSec });
  return Boolean(ok);
}

async function bumpDailyCounter(key: string) {
  const r = await redis();
  if (!r || !r.redis) return 0;
  const day = etDateKey();
  const k = `${key}:${day}`;
  const n = await r.redis.incr(k);
  if (n === 1) await r.redis.expire(k, 60 * 60 * 36);
  return n;
}

async function getDailyCounter(key: string) {
  const r = await redis();
  if (!r || !r.redis) return 0;
  const day = etDateKey();
  const k = `${key}:${day}`;
  const v = await r.redis.get(k);
  return safeNum(v, 0);
}

async function writeTrade(trade: AnyTrade) {
  const r = await redis();
  if (!r || !r.redis) return;
  const id = trade.id;
  await r.redis.set(`trade:${id}`, JSON.stringify(trade));
  await r.redis.lrem("trades:ids", 0, id);
  await r.redis.lpush("trades:ids", id);
}

function pickEntryFromSignal(s: AnySignal) {
  return {
    ticker: String(s.ticker || "").toUpperCase(),
    side: String(s.side || "LONG").toUpperCase(),
    entryPrice: safeNum(s.entryPrice, 0),
    stopPrice: safeNum(s.stopPrice, 0),
    targetPrice: safeNum(s.targetPrice, 0),
  };
}

function shouldConsiderSignal(s: AnySignal) {
  if (!s) return false;
  if (!s.ticker) return false;
  if (s.status && String(s.status).toUpperCase() === "ERROR") return false;
  if (s.qualified !== true) return false;
  if (typeof s.score !== "number") return false;
  if (!s.signalContext) return false;
  const barsUsed = safeNum(s.signalContext?.barsUsed, 0);
  if (barsUsed < 20) return false;
  return true;
}

function tierAllowed(tier: AutoTier, cfg: ReturnType<typeof getAutoConfig>) {
  return cfg.allowedTiers.includes(tier);
}

export async function runAutoEntryOnce(req: Request) {
  const auth = ensureToken(req);
  if (!auth.ok) return auth;

  const cfg = auth.cfg;
  const startedAt = nowIso();

  if (!cfg.enabled) {
    return { ok: true, skipped: true, reason: "AUTO_TRADING_ENABLED=false", startedAt };
  }
  if (!cfg.paperOnly) {
    return { ok: true, skipped: true, reason: "AUTO_TRADING_PAPER_ONLY=false (blocked in Phase 4)", startedAt };
  }

  if (!isMarketHoursGuard()) {
    return { ok: true, skipped: true, reason: "marketClosed", startedAt };
  }

  const trades = await readTrades();
  const openCount = trades.filter(isOpenTrade).length;
  if (openCount >= cfg.maxOpen) {
    return { ok: true, skipped: true, reason: `maxOpenReached:${openCount}/${cfg.maxOpen}`, startedAt };
  }

  const entriesToday = await getDailyCounter("auto:entries");
  if (entriesToday >= cfg.maxPerDay) {
    return { ok: true, skipped: true, reason: `maxPerDayReached:${entriesToday}/${cfg.maxPerDay}`, startedAt };
  }

  const signals = await readRecentSignals(300);
  const candidates = signals
    .filter(shouldConsiderSignal)
    .sort((a, b) => safeNum(b.score, 0) - safeNum(a.score, 0));

  const actions: any[] = [];

  for (const s of candidates) {
    const score = safeNum(s.score, 0);
    const tier = tierForScore(score);
    if (!tier) continue;
    if (!tierAllowed(tier, cfg)) continue;

    const lockKey = `auto:lock:signal:${String(s.id || s.signalId || s.ticker)}:${etDateKey()}`;
    const locked = await setnxLock(lockKey, 60 * 60 * 12);
    if (!locked) {
      actions.push({ id: s.id, ticker: s.ticker, action: "skip", reason: "already_locked" });
      continue;
    }

    const { ticker, side, entryPrice, stopPrice, targetPrice } = pickEntryFromSignal(s);
    if (!ticker || entryPrice <= 0 || stopPrice <= 0) {
      actions.push({ id: s.id, ticker, action: "skip", reason: "missing_prices" });
      continue;
    }

    const riskMult = riskMultForTier(tier);

    const tradeId = crypto.randomUUID();
    const trade: AnyTrade = {
      id: tradeId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ticker,
      side,
      entryPrice,
      stopPrice,
      targetPrice,
      status: "AUTO_PENDING",
      source: "auto-entry",
      signalId: s.id || null,
      ai: { score, tier, riskMult },
      paper: true,
    };

    await writeTrade(trade);

    await bumpDailyCounter("auto:entries");

    actions.push({
      id: s.id,
      ticker,
      action: "created_trade",
      tradeId,
      tier,
      score,
      riskMult,
    });

    break;
  }

  return {
    ok: true,
    startedAt,
    candidates: candidates.length,
    openCount,
    entriesToday: await getDailyCounter("auto:entries"),
    actions,
  };
}
