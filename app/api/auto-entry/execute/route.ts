import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { alpacaRequest, createOrder } from "@/lib/alpaca";
import { redis } from "@/lib/redis";
import { recordAutoEntryTelemetry } from "@/lib/autoEntry/telemetry";
import { requireAuth } from "@/lib/auth";
import { getGuardrailConfig, etDateString, minutesSince } from "@/lib/autoEntry/guardrails";
import { getAutoConfig, tierForScore, riskMultForTier } from "@/lib/autoEntry/config";
import { resolveDecisionPrice, computeBracket, type QuoteLike, type Side } from "@/lib/autoEntry/pricing";
import { withRedisLock } from "@/lib/locks";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import * as guardrailsStore from "@/lib/autoEntry/guardrailsStore";
import { sendNotification } from "@/lib/notifications/notify";
import { NotificationEvent } from "@/lib/notifications/types";
import { normalizeStopPrice, normalizeLimitPrice, tickForEquityPrice } from "@/lib/tickSize";
import { fetchBrokerTruth, type BrokerTruth } from "@/lib/broker/truth";

function ensureBracketLegsValid(params: {
  side: "LONG" | "SHORT";
  basePrice: number;
  takeProfitLimit: number;
  stopLossStop: number;
}) {
  const { side, basePrice } = params;
  let tp = Number(params.takeProfitLimit);
  let sl = Number(params.stopLossStop);

  const base = Number(basePrice);
  const min = 0.01;

  if (side === "LONG") {
    if (!(tp >= base + min)) tp = Number((base + min).toFixed(2));
    if (!(sl <= base - min)) sl = Number((base - min).toFixed(2));
  } else {
    if (!(tp <= base - min)) tp = Number((base - min).toFixed(2));
    if (!(sl >= base + min)) sl = Number((base + min).toFixed(2));
  }

  return { takeProfitLimit: tp, stopLossStop: sl };
}

function isAlpacaInvalidStopVsBase(err: any) {
  const s = String(err?.message || err || "").toLowerCase();
  return (
    s.includes("stop_loss.stop_price") &&
    s.includes("base_price") &&
    (s.includes("must be") || s.includes("must"))
  );
}

async function disableTradeAsPoison(tradeId: string, reason: string) {
  const trades = await readTrades();
  const now = new Date().toISOString();
  let updated = 0;
  const next = trades.map((t: any) => {
    if (t.id !== tradeId) return t;
    updated += 1;
    return {
      ...t,
      status: "ERROR",
      autoEntryStatus: "DISABLED",
      error: "invalid_trade_payload",
      reason,
      updatedAt: now,
    };
  });
  if (updated) await writeTrades(next);
  return updated;
}


function isAutoPendingTrade(t: any) {
  return (
    t?.status === "AUTO_PENDING" ||
    t?.autoEntryStatus === "AUTO_PENDING" ||
    (t?.autoEntry === true && t?.status === "NEW")
  );
}

export const dynamic = "force-dynamic";
const AUTO_ENTRY_TP_MIN_ABS = Number(process.env.AUTO_ENTRY_TP_MIN_ABS ?? "0.05");
async function hasOpenOrdersForSymbol(symbol: string) {
  const qs = `status=open&symbols=${encodeURIComponent(symbol)}&limit=50`;
  const resp = await alpacaRequest({ method: "GET", path: `/v2/orders?${qs}` });
  if (!resp.ok) return { ok: false as const, status: resp.status, text: resp.text || "" };

  try {
    const parsed = JSON.parse(resp.text || "[]");
    const orders = Array.isArray(parsed) ? parsed : [];
    return { ok: true as const, orders };
  } catch {
    return { ok: true as const, orders: [] as any[] };
  }
}


function safeNum(v: any, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

/**
 * Check if a trade is stale (created more than 6 hours ago or not from today ET).
 * Returns true if stale, false if recent.
 */
function isStaleAutoPending(createdAt: string | undefined, etDate: string): boolean {
  if (!createdAt) return false; // Assume recent if no timestamp
  try {
    const createdDate = new Date(createdAt);
    const nowMs = Date.now();
    const ageMs = nowMs - createdDate.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours > 6) return true; // Older than 6 hours
    
    // Also check if createdAt is not from today ET
    const createdETDate = etDateString(createdDate);
    if (createdETDate !== etDate) return true; // Not from today
  } catch {
    return false; // If parsing fails, assume valid
  }
  return false;
}

/**
 * Check if entry price has drifted too much from decision price.
 * Returns rejection reason if drifted, null if acceptable.
 */
function checkPriceDrift(
  decisionPrice: number,
  entryPrice: number,
  stopPrice: number
): string | null {
  if (decisionPrice <= 0 || entryPrice <= 0) return null;
  
  const priceDriftPct = Math.abs(decisionPrice - entryPrice) / entryPrice;
  
  // Allow 1-2% drift
  if (priceDriftPct > 0.02) {
    return "entry_price_drifted_too_much";
  }
  
  // Also check if drift exceeds 0.5R risk distance
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  if (riskPerShare > 0 && Math.abs(decisionPrice - entryPrice) > 0.5 * riskPerShare) {
    return "entry_price_drifted_risk_multiple";
  }
  
  return null;
}

/**
 * Validate and repair bracket prices before submission.
 * Returns { valid: boolean, tp: number, stop: number, reason?: string }
 */
function validateAndRepairBracket(params: {
  side: "LONG" | "SHORT";
  basePrice: number;
  takeProfitPrice: number;
  stopPrice: number;
}): { valid: boolean; tp: number; stop: number; reason?: string } {
  const { side, basePrice, takeProfitPrice, stopPrice } = params;
  const isLong = side === "LONG";
  const tick = 0.01;
  
  const roundUp = (x: number) => Number((Math.ceil(x / tick) * tick).toFixed(2));
  const roundDown = (x: number) => Number((Math.floor(x / tick) * tick).toFixed(2));
  
  // Validate stop price direction
  if (isLong && stopPrice >= basePrice) {
    return { valid: false, tp: takeProfitPrice, stop: stopPrice, reason: "stop_price_invalid_for_side" };
  }
  if (!isLong && stopPrice <= basePrice) {
    return { valid: false, tp: takeProfitPrice, stop: stopPrice, reason: "stop_price_invalid_for_side" };
  }
  
  // Validate TP meets minimum requirements
  const minTpLong = basePrice + tick;
  const maxTpShort = basePrice - tick;
  
  let tp = takeProfitPrice;
  const tpIsValid = isLong ? (tp >= minTpLong) : (tp <= maxTpShort);
  
  if (!tpIsValid) {
    // Try to repair TP using risk multiple
    const stopDist = Math.abs(basePrice - stopPrice);
    if (stopDist < tick) {
      return { valid: false, tp, stop: stopPrice, reason: "stop_distance_too_small" };
    }
    
    const repairedTp = isLong 
      ? roundUp(basePrice + 2 * stopDist) 
      : roundDown(basePrice - 2 * stopDist);
    
    // Check if repaired TP is now valid
    const repairedTpValid = isLong ? (repairedTp >= minTpLong) : (repairedTp <= maxTpShort);
    if (!repairedTpValid) {
      return { valid: false, tp: repairedTp, stop: stopPrice, reason: "invalid_bracket_prices_unrepairable" };
    }
    
    return { valid: true, tp: repairedTp, stop: stopPrice, reason: "bracket_repaired_with_risk_multiple" };
  }
  
  return { valid: true, tp, stop: stopPrice };
}

function headerToken(req: Request) {
  const h = req.headers.get("x-auto-entry-token") || "";
  if (h) return h;
  const auth = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}


async function fetchQuoteForSymbol(symbol: string): Promise<QuoteLike | null> {
  const encoded = encodeURIComponent(symbol);
  const quoteResp = await alpacaRequest({ method: "GET", path: `/v2/stocks/${encoded}/quotes/latest` });
  const quoteLike: QuoteLike = { last: null, mid: null, bid: null, ask: null };
  let hasQuote = false;

  if (quoteResp.ok) {
    try {
      const parsed = JSON.parse(quoteResp.text || "{}");
      const qt = (parsed as any)?.quote || (parsed as any)?.quotes?.[0] || parsed;
      if (qt) {
        const bidVal = safeNum(qt?.bp ?? qt?.bid_price ?? qt?.bid);
        const askVal = safeNum(qt?.ap ?? qt?.ask_price ?? qt?.ask);
        const lastVal = safeNum(
          qt?.last?.price ?? qt?.last_price ?? qt?.last_trade?.price ?? qt?.p ?? qt?.price
        );
        if (bidVal) quoteLike.bid = bidVal;
        if (askVal) quoteLike.ask = askVal;
        if (lastVal) quoteLike.last = lastVal;
        if (quoteLike.bid && quoteLike.ask) {
          quoteLike.mid = (quoteLike.bid + quoteLike.ask) / 2;
        }
        hasQuote = Boolean(quoteLike.bid || quoteLike.ask || quoteLike.last || quoteLike.mid);
      }
    } catch {}
  }

  if (!hasQuote) {
    const tradeResp = await alpacaRequest({ method: "GET", path: `/v2/stocks/${encoded}/trades/latest` });
    if (tradeResp.ok) {
      try {
        const parsed = JSON.parse(tradeResp.text || "{}");
        const tr = (parsed as any)?.trade || (parsed as any)?.trades?.[0] || parsed;
        const px = safeNum(tr?.p ?? tr?.price);
        if (px) {
          quoteLike.last = px;
          hasQuote = true;
        }
      } catch {}
    }
  }

  return hasQuote ? quoteLike : null;
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureToken(req: Request) {
  const cfg = getAutoConfig();

  const cookieOk = await requireAuth(req);
  if (cookieOk.ok) return { ok: true as const, cfg };

  if (!cfg.token) return { ok: false as const, status: 500, error: "AUTO_ENTRY_TOKEN missing" };
  const got = headerToken(req);
  if (!got || got !== cfg.token) return { ok: false as const, status: 401, error: "unauthorized" };
  return { ok: true as const, cfg };
}

async function setnxLock(key: string, ttlSec: number) {
  if (!redis) return false;
  const ok = await redis.set(key, "1", { nx: true, ex: ttlSec });
  return Boolean(ok);
}


function computeQty(entryPrice: number, stopPrice: number, riskDollars: number) {
  const diff = Math.abs(entryPrice - stopPrice);
  if (!diff || diff <= 0) return 1;
  const qty = Math.floor(riskDollars / diff);
  return Math.max(1, qty);
}

async function listOpenOrders(symbol: string) {
  const qs = `status=open&symbols=${encodeURIComponent(symbol)}`;
  const resp = await alpacaRequest({ method: "GET", path: `/v2/orders?${qs}` });
  if (!resp.ok) return [];
  try {
    const parsed = JSON.parse(resp.text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function cancelOrder(id: string) {
  const resp = await alpacaRequest({ method: "DELETE", path: `/v2/orders/${id}` });
  return resp.ok || resp.status === 404;
}

async function cancelConflictingOrders(symbol: string, entrySide: "buy" | "sell") {
  const open = await listOpenOrders(symbol);
  const cancels = [];
  for (const o of open) {
    const oSide = String(o?.side || "").toLowerCase();
    const oType = String(o?.type || "").toLowerCase();
    const id = String(o?.id || "");
    if (!id) continue;

    // Conflict definition: opposite-side stop/market orders (exact Alpaca reject cause)
    const opposite = (entrySide === "buy" && oSide === "sell") || (entrySide === "sell" && oSide === "buy");
    const isStopOrMkt = (["stop","market"].includes(oType));
    if (opposite && isStopOrMkt) {
      cancels.push(id);
    }
  }

  const results = [];
  for (const id of cancels) {
    try {
      const ok = await cancelOrder(id);
      results.push({ id, ok });
    } catch (e) {
      results.push({ id, ok: false, error: String(e) });
    }
  }

  return { cancelled: results, openCount: open.length };
}

type GuardSummary = {
  enabled: boolean;
  autoEntryToggleReason: string | null;
  entriesToday: number;
  maxEntriesPerDay: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  autoDisabledReason: string | null;
  maxOpenPositions: number;
  openPositions: number;
  brokerPositionsCount?: number;
  brokerOpenOrdersCount?: number;
  brokerTruthError?: string;
  lastLossAt: string | null;
  cooldownAfterLossMin: number;
  cooldownRemainingMin: number | null;
  tickerCooldownMin: number;
};

const APP_BASE_URL = (process.env.APP_URL || "").replace(/\/$/, "");

function buildGuardSummary(params: {
  guardState: guardrailsStore.GuardrailState;
  guardConfig: import("@/lib/autoEntry/guardrails").GuardrailConfig;
  toggleState: { enabled: boolean; reason: string | null };
  openPositions: number;
  brokerTruth?: BrokerTruth;
}): GuardSummary {
  return {
    enabled: params.toggleState.enabled,
    autoEntryToggleReason: params.toggleState.reason,
    entriesToday: params.guardState.entriesToday,
    maxEntriesPerDay: params.guardConfig.maxEntriesPerDay,
    consecutiveFailures: params.guardState.consecutiveFailures,
    maxConsecutiveFailures: params.guardConfig.maxConsecutiveFailures,
    autoDisabledReason: params.guardState.autoDisabledReason,
    maxOpenPositions: params.guardConfig.maxOpenPositions,
    openPositions: params.openPositions,
    brokerPositionsCount: params.brokerTruth?.positionsCount,
    brokerOpenOrdersCount: params.brokerTruth?.openOrdersCount,
    brokerTruthError: params.brokerTruth?.error,
    lastLossAt: params.guardState.lastLossAt,
    cooldownAfterLossMin: params.guardConfig.cooldownAfterLossMin,
    cooldownRemainingMin: null,
    tickerCooldownMin: params.guardConfig.tickerCooldownMin,
  };
}

async function fireNotification(event: NotificationEvent) {
  try {
    await sendNotification(event);
  } catch (err) {
    console.error("[notify] auto entry event failed", err);
  }
}

async function emitAutoDisabledNotification(tradeId: string, reason: string, ticker: string) {
  await fireNotification({
    type: "AUTO_ENTRY_DISABLED",
    tradeId,
    ticker,
    title: `Auto entry disabled ${ticker}`,
    message: `Auto entry has been disabled: ${reason}`,
    paper: true,
    dedupeKey: "AUTO_ENTRY_DISABLED",
    dedupeTtlSec: 3600,
  });
}

export async function POST(req: Request) {
  const auth = await ensureToken(req);
  if (!auth.ok) return NextResponse.json(auth, { status: auth.status });

  const cfg = auth.cfg;
  const counts = {
    checked: 0,
    invalidMarked: 0,
    executed: 0,
    skipped: 0,
  };
  const guardConfig = getGuardrailConfig();
  const etDate = etDateString(new Date());
  const [guardState, toggleState, brokerTruth] = await Promise.all([
    guardrailsStore.getGuardrailsState(etDate),
    guardrailsStore.getAutoEntryEnabledState(guardConfig),
    fetchBrokerTruth(),
  ]);

  const trades = await readTrades<any>();
  const openPositions = trades.filter(
    (t) =>
      Boolean(t?.status === "OPEN") &&
      (t?.source === "auto-entry" || t?.source === "AUTO")
  ).length;

  let guardSummary = buildGuardSummary({
    guardState,
    guardConfig,
    toggleState,
    openPositions,
    brokerTruth,
  });

  if (!cfg.enabled) {
    return NextResponse.json(
      { ok: true, skipped: true, reason: "AUTO_TRADING_ENABLED=false", counts, guardrails: guardSummary },
      { status: 200 }
    );
  }
  if (!cfg.paperOnly) {
    return NextResponse.json(
      { ok: true, skipped: true, reason: "AUTO_TRADING_PAPER_ONLY=false (blocked in Phase 4)", counts, guardrails: guardSummary },
      { status: 200 }
    );
  }

  if (!toggleState.enabled) {
    counts.skipped += 1;
    return NextResponse.json(
      { ok: true, skipped: true, reason: "auto_entry_disabled", counts, guardrails: guardSummary },
      { status: 200 }
    );
  }

  let marketOpen = true;
  try {
    const clock = await fetchAlpacaClock();
    marketOpen = Boolean(clock.is_open);
  } catch {
    marketOpen = false;
  }

  if (!marketOpen) {
    counts.skipped += 1;
    await recordAutoEntryTelemetry({ etDate, at: new Date().toISOString(), outcome: "SKIP", reason: "market_closed", source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
    return NextResponse.json(
      { ok: true, skipped: true, reason: "market_closed", counts, guardrails: guardSummary },
      { status: 200 }
    );
  }

  if (guardState.autoDisabledReason) {
    counts.skipped += 1;
    await fireNotification({
      type: "AUTO_ENTRY_DISABLED",
      ticker: "AUTO_ENTRY",
      title: "Auto entry disabled",
      message: `Circuit breaker: ${guardState.autoDisabledReason}`,
      paper: true,
      dedupeKey: `AUTO_ENTRY_DISABLED:${guardState.autoDisabledReason}`,
      dedupeTtlSec: 3600,
    });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "circuit_breaker",
        detail: guardState.autoDisabledReason,
        counts,
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  if (brokerTruth.error) {
    counts.skipped += 1;
    await recordAutoEntryTelemetry({
      etDate,
      at: new Date().toISOString(),
      outcome: "SKIP",
      reason: "broker_truth_unavailable",
      source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"),
      runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || ""),
      detail: brokerTruth.error,
    });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "broker_truth_unavailable",
        detail: brokerTruth.error,
        counts,
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  if (brokerTruth.positionsCount >= guardConfig.maxOpenPositions) {
    counts.skipped += 1;
    await recordAutoEntryTelemetry({
      etDate,
      at: new Date().toISOString(),
      outcome: "SKIP",
      reason: "max_open_positions",
      source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"),
      runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || ""),
      detail: `brokerPositionsCount=${brokerTruth.positionsCount}, maxOpenPositions=${guardConfig.maxOpenPositions}`,
    });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "max_open_positions",
        detail: `brokerPositionsCount=${brokerTruth.positionsCount}, maxOpenPositions=${guardConfig.maxOpenPositions}`,
        counts,
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  if (guardState.entriesToday >= guardConfig.maxEntriesPerDay) {
    counts.skipped += 1;
    await recordAutoEntryTelemetry({ etDate, at: new Date().toISOString(), outcome: "SKIP", reason: "max_entries_per_day", source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
    return NextResponse.json(
      { ok: true, skipped: true, reason: "max_entries_per_day", counts, guardrails: guardSummary },
      { status: 200 }
    );
  }

  const sinceLoss = minutesSince(guardState.lastLossAt);
  if (sinceLoss != null && sinceLoss < guardConfig.cooldownAfterLossMin) {
    const minsRemaining = Math.ceil(guardConfig.cooldownAfterLossMin - sinceLoss);
    guardSummary.cooldownRemainingMin = minsRemaining;
    counts.skipped += 1;
    await recordAutoEntryTelemetry({ etDate, at: new Date().toISOString(), outcome: "SKIP", reason: "cooldown_after_loss", source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "cooldown_after_loss",
        detail: `${minsRemaining}m`,
        counts,
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }
  let idx = -1;
  for (let i = 0; i < trades.length; i += 1) {
    const candidate = trades[i];
    if (!candidate || !isAutoPendingTrade(candidate)) continue;
    if (!(candidate.source === "auto-entry" || candidate.source === "AUTO")) continue;
    counts.checked += 1;

    const entryPrice = safeNum(candidate.entryPrice, 0);
    const stopPrice = safeNum(candidate.stopPrice, 0);
    const takeProfitPrice = safeNum(candidate.takeProfitPrice, 0);
    const sideStr = String(candidate.side || "LONG").toUpperCase();
    const isLong = sideStr === "LONG";
    let invalidError: string | null = null;

    // Check if trade is stale (created >6h ago or not from today ET)
    if (isStaleAutoPending(candidate.createdAt, etDate)) {
      invalidError = "stale_auto_pending";
    }
    // Check for price drift between decision price and entry price
    else if (!invalidError && candidate.decisionPrice) {
      const driftReason = checkPriceDrift(
        safeNum(candidate.decisionPrice, 0),
        entryPrice,
        stopPrice
      );
      if (driftReason) invalidError = driftReason;
    }
    // Original basic validations
    else if (entryPrice <= 0 || stopPrice <= 0 || takeProfitPrice <= 0) {
      invalidError = "auto_entry_invalid_missing_prices_any";
    } else if (isLong && stopPrice >= entryPrice) {
      invalidError = "auto_entry_invalid_bad_stop";
    }

    if (invalidError) {
      counts.invalidMarked += 1;
      trades[i] = {
        ...candidate,
        status: "ERROR",
        brokerStatus: candidate.brokerStatus,
        error: invalidError,
        autoEntryStatus: "AUTO_ERROR",
        errorDetails: { entryPrice: candidate.entryPrice ?? null, stopPrice: candidate.stopPrice ?? null, takeProfitPrice: candidate.takeProfitPrice ?? null },
        updatedAt: nowIso(),
      };
      await writeTrades(trades);
      continue;
    }

    idx = i;
    break;
  }

  if (idx === -1) {
    counts.skipped += 1;
    await recordAutoEntryTelemetry({ etDate, at: new Date().toISOString(), outcome: "SKIP", reason: "no_AUTO_PENDING", source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
    return NextResponse.json(
      { ok: true, skipped: true, reason: "no_AUTO_PENDING_trades", counts, guardrails: guardSummary },
      { status: 200 }
    );
  }

  const trade = trades[idx];
  const ticker = String(trade.ticker || "").toUpperCase();
  const side = String(trade.side || "LONG").toUpperCase();

  const lastTickerEntry = guardState.tickerEntries[ticker];
  const sinceTicker = minutesSince(lastTickerEntry);
  if (sinceTicker != null && sinceTicker < guardConfig.tickerCooldownMin) {
    const minsRemaining = Math.ceil(guardConfig.tickerCooldownMin - sinceTicker);
    counts.skipped += 1;
    await recordAutoEntryTelemetry({ etDate, at: new Date().toISOString(), outcome: "SKIP", reason: "ticker_cooldown", ticker, source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "ticker_cooldown",
        detail: `${minsRemaining}m`,
        counts,
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  const tradeId = String(trade.id || "");
  if (!tradeId) return NextResponse.json({ ok: false, error: "trade missing id" }, { status: 400 });

  const entryPrice = safeNum(trade.entryPrice, 0);
  const stopPrice = safeNum(trade.stopPrice, 0);

  if (!ticker || (side !== "LONG" && side !== "SHORT") || entryPrice <= 0 || stopPrice <= 0) {
    return NextResponse.json({ ok: false, error: "trade missing ticker/side/entryPrice/stopPrice", tradeId }, { status: 400 });
  }

  const lockKey = `lock:auto-entry:${ticker}`;
  const locked = await setnxLock(lockKey, 60 * 10);
  if (!locked) {
    counts.skipped += 1;
    await recordAutoEntryTelemetry({ etDate, at: new Date().toISOString(), outcome: "SKIP", reason: "already_locked", ticker, tradeId, source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
    return NextResponse.json(
      { ok: true, skipped: true, reason: "already_locked", tradeId, counts, guardrails: guardSummary },
      { status: 200 }
    );
  }

  const open = await hasOpenOrdersForSymbol(ticker);
  if (!open.ok) {
    return NextResponse.json(
      {
        ok: false,
        status: open.status,
        error: open.text || "alpaca open orders lookup failed",
        tradeId,
        guardrails: guardSummary,
      },
      { status: 500 }
    );
  }
  if (open.orders.length > 0) {
    counts.skipped += 1;
    await recordAutoEntryTelemetry({ etDate, at: new Date().toISOString(), outcome: "SKIP", reason: "open_order_exists", ticker, tradeId, source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
    return NextResponse.json(
      { ok: true, skipped: true, reason: "open_order_exists", tradeId, openOrders: open.orders.map((o: any) => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, status: o.status })), counts, guardrails: guardSummary },
      { status: 200 }
    );
  }

  const score = safeNum(trade.ai?.score ?? trade.score ?? 0, 0);
  const tier = tierForScore(score) || "C";
  const riskMult = riskMultForTier(tier);
  const riskDollars = cfg.baseRiskDollars * riskMult;
  const qty = computeQty(entryPrice, stopPrice, riskDollars);

  const sideDirection = side === "LONG" ? "buy" : "sell";
  const redisLockKey = `lock:auto-entry:${ticker}`;
  const startedAt = nowIso();
  const sideEnum: Side = side === "LONG" ? "LONG" : "SHORT";

  const quote = await fetchQuoteForSymbol(ticker);
  const decision = resolveDecisionPrice({ seedEntryPrice: entryPrice, quote });

  const stopDistance = Math.abs(entryPrice - stopPrice);
  const rr = 1;

  const tpRaw = sideEnum === "LONG"
    ? entryPrice + stopDistance * rr
    : entryPrice - stopDistance * rr;

  let tp = Math.round(tpRaw * 100) / 100;
  let bracketStop = Math.round(stopPrice * 100) / 100;

  const bracketGuard = ensureBracketLegsValid({
    side: sideEnum,
    basePrice: entryPrice,
    takeProfitLimit: tp,
    stopLossStop: bracketStop,
  });
  tp = bracketGuard.takeProfitLimit;
  bracketStop = bracketGuard.stopLossStop;

  const TP_MIN_OFFSET_FORCE = 0.50;
  if (sideEnum === "LONG") {
    const minTp = Number((entryPrice + TP_MIN_OFFSET_FORCE).toFixed(2));
    if (tp < minTp) tp = minTp;
  } else {
    const maxTp = Number((entryPrice - TP_MIN_OFFSET_FORCE).toFixed(2));
    if (tp > maxTp) tp = maxTp;
  }

  if (sideDirection === "buy") {
    const minTpAbs = Number((entryPrice + AUTO_ENTRY_TP_MIN_ABS).toFixed(2));
    if (tp < minTpAbs) tp = minTpAbs;
  } else {
    const maxTpAbs = Number((entryPrice - AUTO_ENTRY_TP_MIN_ABS).toFixed(2));
    if (tp > maxTpAbs) tp = maxTpAbs;
  }

  tp = Number(tp.toFixed(2));
  bracketStop = Number(bracketStop.toFixed(2));

  const dbg: any = {
    ticker,
    side,
    entryPrice,
    stopPrice,
    quote,
    decisionPrice: decision.decisionPrice,
    decisionSource: decision.source,
    stopDistance,
    takeProfitPrice: tp,
    bracketStopPrice: bracketStop,
    qty,
    riskDollars,
    tier,
    score,
  };

  const lock = await withRedisLock({
    key: redisLockKey,
    ttlSeconds: 90,
    owner: `execute:${tradeId}`,
    fn: async () => {
      // Validate and repair bracket BEFORE submitting order
      const bracketCheck = validateAndRepairBracket({
        side: sideDirection === "buy" ? "LONG" : "SHORT",
        basePrice: entryPrice,
        takeProfitPrice: tp,
        stopPrice: bracketStop,
      });
      
      if (!bracketCheck.valid) {
        // Return poison flag to trigger disabling
        return { __poison: true, message: `bracket_validation_failed: ${bracketCheck.reason || "unknown"}` } as any;
      }
      
      // Use repaired bracket if it was corrected
      let finalTp = bracketCheck.tp;
      let finalStop = bracketCheck.stop;

      // Apply FINAL tick normalization
      const tick = tickForEquityPrice(entryPrice);
      const stopNorm = normalizeStopPrice({
        side: sideDirection === "buy" ? "LONG" : "SHORT",
        entryPrice,
        stopPrice: finalStop,
        tick,
      });
      if (!stopNorm.ok) {
        return { __poison: true, message: `stop_normalization_failed: ${stopNorm.reason}` } as any;
      }
      finalStop = stopNorm.stop;

      finalTp = normalizeLimitPrice({ price: finalTp, tick });

      const minTpLong = Number((entryPrice + tick).toFixed(2));
      const maxTpShort = Number((entryPrice - tick).toFixed(2));

      const wantTp =
        sideDirection === "buy"
          ? finalTp >= minTpLong
          : finalTp <= maxTpShort;

      const payload: any = {
        symbol: ticker,
        qty,
        side: sideDirection,
        type: "market",
        time_in_force: "day",
        order_class: wantTp ? "bracket" : "oto",
        stop_loss: { stop_price: finalStop },
      };

      if (wantTp) payload.take_profit = { limit_price: finalTp };

      try {
        return await createOrder(payload);
      } catch (e: any) {
        if (isAlpacaInvalidStopVsBase(e)) {
          return { __poison: true, message: String(e?.message || e || "") } as any;
        }
        throw e;
      }
    },
  });

  if (!lock.ok) {
    const failureCount = await guardrailsStore.recordFailure(etDate, "alpaca_error");
    guardSummary.consecutiveFailures = failureCount;
    if (failureCount >= guardConfig.maxConsecutiveFailures) {
      await guardrailsStore.setAutoDisabled(etDate, "max_consecutive_failures");
      guardSummary.autoDisabledReason = "max_consecutive_failures";
      await emitAutoDisabledNotification(tradeId, "max_consecutive_failures", ticker);
    }
    return NextResponse.json(
      {
        ok: false,
        error: lock.error,
        tradeId,
        lockKey: redisLockKey,
        debug: dbg,
        guardrails: guardSummary,
      },
      { status: lock.error === "LOCKED" ? 409 : 500 }
    );
  }

  try {
    const order = lock.value;
    if ((order as any)?.__poison) {
      counts.invalidMarked += 1;
      await disableTradeAsPoison(tradeId, "invalid_stop_vs_base_price");
      await recordAutoEntryTelemetry({ etDate, at: new Date().toISOString(), outcome: "SKIP", reason: "invalid_stop_vs_base_price", ticker, tradeId, source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
      return NextResponse.json(
        { ok: true, skipped: true, reason: "invalid_stop_vs_base_price", tradeId, counts, guardrails: guardSummary },
        { status: 200 }
      );
    }

    const legs = Array.isArray((order as any)?.legs) ? (order as any).legs : [];
    const stopChild = (order as any)?.stop_loss ?? legs.find((l: any) => String(l?.type || "").toLowerCase().includes("stop"));
    const takeProfitChild = (order as any)?.take_profit ?? legs.find((l: any) => String(l?.type || "").toLowerCase().includes("limit"));
    const stopOrderId = stopChild?.id ?? null;
    const takeProfitOrderId = takeProfitChild?.id ?? null;

    const updated = {
      ...trade,
      quantity: qty,
      status: "OPEN",
      submitToBroker: true,
      brokerOrderId: order.id,
      brokerStatus: (order as any).status,
      brokerRaw: order,
      alpacaOrderId: order.id,
      alpacaStatus: (order as any).status,
      stopOrderId,
      takeProfitOrderId,
      lastStopAppliedAt: startedAt,
      error: undefined,
      updatedAt: startedAt,
      executedAt: startedAt,
      ai: {
        ...(trade.ai || {}),
        score,
        tier,
        riskMult,
        riskDollars,
      },
      paper: true,
    };

    trades[idx] = updated;
    await writeTrades(trades);
    counts.executed += 1;

    await guardrailsStore.bumpEntry(etDate, ticker);
    guardSummary.entriesToday += 1;
    guardSummary.openPositions += 1;
    await guardrailsStore.resetFailures(etDate);
    guardSummary.consecutiveFailures = 0;
    await guardrailsStore.clearAutoDisabled(etDate);
    guardSummary.autoDisabledReason = null;

    await recordAutoEntryTelemetry({ etDate, at: startedAt, outcome: "SUCCESS", reason: "placed", ticker, tradeId, source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
    await fireNotification({
      type: "AUTO_ENTRY_PLACED",
      tradeId,
      ticker,
      tier,
      paper: true,
      title: `Auto entry placed ${ticker}`,
      message: `Submitted ${qty} ${ticker} ${sideDirection} @ ${entryPrice.toFixed(
        2
      )} stop ${bracketStop.toFixed(2)} tp ${tp.toFixed(2)}`,
      dedupeKey: `AUTO_ENTRY_PLACED:${tradeId}`,
      dedupeTtlSec: 600,
      meta: {
        score,
        riskDollars,
        takeProfit: tp,
        stop: bracketStop,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        trade: updated,
        broker: {
          id: order.id,
          status: (order as any).status,
          order_class: (order as any).order_class ?? "bracket",
          stopOrderId,
          takeProfitOrderId,
        },
        debug: dbg,
        counts,
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const message = String(e?.message || e || "unknown_error");
    const stack = String(e?.stack || "");
    const failureCount = await guardrailsStore.recordFailure(etDate, "execute_error");
    guardSummary.consecutiveFailures = failureCount;
    if (failureCount >= guardConfig.maxConsecutiveFailures) {
      await guardrailsStore.setAutoDisabled(etDate, "max_consecutive_failures");
      guardSummary.autoDisabledReason = "max_consecutive_failures";
      await emitAutoDisabledNotification(tradeId, "max_consecutive_failures", ticker);
    }
    const updated = {
      ...trade,
      status: "ERROR",
      error: message,
      updatedAt: startedAt,
    };
    trades[idx] = updated;
    await writeTrades(trades);
    await recordAutoEntryTelemetry({ etDate, at: startedAt, outcome: "FAIL", reason: "execute_error", ticker, tradeId, source: String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown"), runId: String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "") });
    await fireNotification({
      type: "AUTO_ENTRY_FAILED",
      tradeId,
      ticker,
      title: `Auto entry failed ${ticker}`,
      message: `Execution error: ${message}`,
      paper: true,
      dedupeKey: `AUTO_ENTRY_FAILED:${tradeId}`,
      dedupeTtlSec: 600,
    });
    return NextResponse.json(
      { ok: false, error: message, stack, tradeId, debug: dbg, counts, guardrails: guardSummary },
      { status: 500 }
    );
  }
}
