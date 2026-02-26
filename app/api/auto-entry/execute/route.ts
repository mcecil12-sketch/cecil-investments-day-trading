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
import {
  deriveSessionMeta,
  evaluatePendingEligibility,
  getTradeTimestamp,
  type EligibilityConfig,
} from "@/lib/autoEntry/eligibility";
import { scoreSignalWithAI } from "@/lib/aiScoring";
import { evaluateBreakerTransition } from "@/lib/autoEntry/breaker";

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

function pendingTp(trade: any) {
  return safeNum(trade?.takeProfitPrice ?? trade?.targetPrice, 0);
}

function hasValidPendingRisk(trade: any) {
  const entryPrice = safeNum(trade?.entryPrice, 0);
  const stopPrice = safeNum(trade?.stopPrice, 0);
  const takeProfitPrice = pendingTp(trade);
  const side = String(trade?.side || "LONG").toUpperCase();

  if (!(entryPrice > 0 && stopPrice > 0 && takeProfitPrice > 0)) return false;
  if (!(side === "LONG" || side === "SHORT")) return false;

  if (side === "LONG") {
    if (stopPrice >= entryPrice) return false;
    if (takeProfitPrice <= entryPrice) return false;
  } else {
    if (stopPrice <= entryPrice) return false;
    if (takeProfitPrice >= entryPrice) return false;
  }
  return true;
}

function byNewestCreatedAtDesc(a: any, b: any) {
  const aTs = Date.parse(getTradeTimestamp(a)) || 0;
  const bTs = Date.parse(getTradeTimestamp(b)) || 0;
  return bTs - aTs;
}

function toRawSignal(trade: any) {
  const sideRaw = String(trade?.side || "").toUpperCase();
  const side: "LONG" | "SHORT" = sideRaw === "SHORT" ? "SHORT" : "LONG";
  return {
    id: trade?.signalId || trade?.id,
    ticker: String(trade?.ticker || "").toUpperCase(),
    timeframe: "1Min",
    createdAt: String(getTradeTimestamp(trade) || new Date().toISOString()),
    entryPrice: safeNum(trade?.entryPrice, 0),
    stopPrice: safeNum(trade?.stopPrice, 0),
    targetPrice: safeNum(trade?.takeProfitPrice ?? trade?.targetPrice, 0),
    side,
    source: trade?.source || "AUTO",
    status: "SCORED",
  };
}

async function tryRescoreTrade(trade: any) {
  const result = await scoreSignalWithAI(toRawSignal(trade));
  const scored = (result as any)?.scored || {};
  const score = Number(scored?.aiScore ?? scored?.score);
  const grade = String(scored?.aiGrade || scored?.grade || "");
  const qualified = scored?.qualified === true || Number.isFinite(score) || Boolean(grade);
  const bestDirection = String(scored?.bestDirection || scored?.direction || scored?.side || trade?.side || "").toUpperCase();
  const summary = String(scored?.aiSummary || scored?.summary || "");

  if (!qualified) {
    return { ok: false as const };
  }

  const now = new Date().toISOString();
  return {
    ok: true as const,
    patch: {
      aiScore: Number.isFinite(score) ? score : trade?.aiScore ?? null,
      aiGrade: grade || trade?.aiGrade || null,
      qualified: scored?.qualified === true,
      bestDirection,
      aiSummary: summary || trade?.aiSummary || "",
      rescoredAt: now,
      updatedAt: now,
      ai: {
        ...(trade?.ai || {}),
        score: Number.isFinite(score) ? score : trade?.ai?.score ?? null,
        grade: grade || trade?.ai?.grade || null,
        qualified: scored?.qualified === true,
        bestDirection,
        summary: summary || trade?.ai?.summary || "",
      },
    },
  };
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
    pendingCount: 0,
    eligibleCount: 0,
    staleArchived: 0,
    duplicatesArchived: 0,
    invalidMarked: 0,
    executed: 0,
    skipped: 0,
  };
  const notes: string[] = [];
  const guardConfig = getGuardrailConfig();
  const etDate = etDateString(new Date());
  const [guardState, toggleState, brokerTruth] = await Promise.all([
    guardrailsStore.getGuardrailsState(etDate),
    guardrailsStore.getAutoEntryEnabledState(guardConfig),
    fetchBrokerTruth(),
  ]);

  let marketOpen = true;
  let marketTimestamp = nowIso();
  let marketReason: string | undefined;
  try {
    const clock = await fetchAlpacaClock();
    marketOpen = Boolean(clock.is_open);
    marketTimestamp = String((clock as any)?.timestamp || (clock as any)?.next_open || nowIso());
  } catch {
    marketOpen = false;
    marketReason = "clock_unavailable";
  }

  const trades = await readTrades<any>();
  const pendingIndexes = trades
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => Boolean(t && isAutoPendingTrade(t) && (t?.source === "auto-entry" || t?.source === "AUTO")));
  counts.pendingCount = pendingIndexes.length;

  const eligibleIndexes: number[] = [];
  const nowForPending = nowIso();
  const maxAgeMin = Number.isFinite(Number(process.env.AUTO_ENTRY_MAX_AGE_MIN))
    ? Math.max(1, Number(process.env.AUTO_ENTRY_MAX_AGE_MIN))
    : 15;
  const rescoreAfterMin = Number.isFinite(Number(process.env.AUTO_ENTRY_RESCORE_AFTER_MIN))
    ? Math.max(0, Number(process.env.AUTO_ENTRY_RESCORE_AFTER_MIN))
    : 10;
  const blockCarryover = ["1", "true", "yes", "on"].includes(
    String(process.env.AUTO_ENTRY_BLOCK_CARRYOVER || "1").toLowerCase()
  );
  const sessionMeta = deriveSessionMeta(marketTimestamp || nowForPending);
  const eligibilityCfg: EligibilityConfig = {
    todayET: sessionMeta.etDate,
    currentSessionTag: sessionMeta.sessionTag,
    marketIsOpen: marketOpen,
    maxAgeMin,
    rescoreAfterMin,
    blockCarryover,
  };
  let tradesChanged = false;

  const pendingSorted = [...pendingIndexes].sort((a, b) => byNewestCreatedAtDesc(a.t, b.t));
  const byTickerPending = new Map<string, Array<{ t: any; i: number }>>();
  for (const item of pendingSorted) {
    const ticker = String(item.t?.ticker || "").toUpperCase();
    if (!ticker) continue;
    const arr = byTickerPending.get(ticker) || [];
    arr.push(item);
    byTickerPending.set(ticker, arr);
  }

  for (const [ticker, group] of byTickerPending.entries()) {
    const sorted = [...group].sort((a, b) => byNewestCreatedAtDesc(a.t, b.t));
    const processed = new Set<number>();
    let selectedIndex: number | null = null;

    for (const item of sorted) {
      counts.checked += 1;
      const tradeId = String(item.t?.id || "");
      let workingTrade = item.t;
      let eligibility = evaluatePendingEligibility(workingTrade, nowForPending, eligibilityCfg);

      if (!eligibility.eligible && eligibility.requiresRescore) {
        try {
          const rescored = await tryRescoreTrade(workingTrade);
          if (!rescored.ok) {
            trades[item.i] = {
              ...trades[item.i],
              status: "ERROR",
              autoEntryStatus: "AUTO_ERROR",
              reason: "rescore_failed",
              error: "rescore_failed",
              updatedAt: nowForPending,
              rescoredAt: nowForPending,
            };
            counts.invalidMarked += 1;
            counts.skipped += 1;
            tradesChanged = true;
            processed.add(item.i);
            notes.push(`rescore_failed:${ticker}:${tradeId || "unknown"}`);
            continue;
          }
          workingTrade = { ...workingTrade, ...rescored.patch };
          trades[item.i] = { ...trades[item.i], ...rescored.patch };
          tradesChanged = true;
          eligibility = evaluatePendingEligibility(workingTrade, nowForPending, eligibilityCfg);
        } catch {
          trades[item.i] = {
            ...trades[item.i],
            status: "ERROR",
            autoEntryStatus: "AUTO_ERROR",
            reason: "rescore_failed",
            error: "rescore_failed",
            updatedAt: nowForPending,
            rescoredAt: nowForPending,
          };
          counts.invalidMarked += 1;
          counts.skipped += 1;
          tradesChanged = true;
          processed.add(item.i);
          notes.push(`rescore_failed:${ticker}:${tradeId || "unknown"}`);
          continue;
        }
      }

      if (!eligibility.eligible) {
        if (eligibility.reason === "stale_trade" || eligibility.reason === "carryover_session") {
          trades[item.i] = {
            ...trades[item.i],
            status: "ARCHIVED",
            autoEntryStatus: "AUTO_ARCHIVED",
            reason: eligibility.reason,
            error: undefined,
            closedAt: trades[item.i]?.closedAt || nowForPending,
            updatedAt: nowForPending,
          };
          counts.staleArchived += 1;
          counts.skipped += 1;
          tradesChanged = true;
          processed.add(item.i);
          notes.push(`${eligibility.reason}:${ticker}:${tradeId || "unknown"}`);
          continue;
        }

        trades[item.i] = {
          ...trades[item.i],
          status: "ERROR",
          autoEntryStatus: "AUTO_ERROR",
          reason: eligibility.reason,
          error: eligibility.reason,
          updatedAt: nowForPending,
        };
        counts.invalidMarked += 1;
        counts.skipped += 1;
        tradesChanged = true;
        processed.add(item.i);
        notes.push(`${eligibility.reason}:${ticker}:${tradeId || "unknown"}`);
        continue;
      }

      if (!hasValidPendingRisk(workingTrade)) {
        trades[item.i] = {
          ...trades[item.i],
          status: "ERROR",
          autoEntryStatus: "AUTO_ERROR",
          reason: "invalid_pending_missing_risk",
          error: "invalid_pending_missing_risk",
          errorDetails: {
            entryPrice: workingTrade?.entryPrice ?? null,
            stopPrice: workingTrade?.stopPrice ?? null,
            takeProfitPrice: workingTrade?.takeProfitPrice ?? workingTrade?.targetPrice ?? null,
          },
          updatedAt: nowForPending,
        };
        counts.invalidMarked += 1;
        counts.skipped += 1;
        tradesChanged = true;
        processed.add(item.i);
        notes.push(`invalid_pending:${ticker}:${tradeId || "unknown"}`);
        continue;
      }

      selectedIndex = item.i;
      processed.add(item.i);
      eligibleIndexes.push(item.i);
      break;
    }

    if (selectedIndex != null) {
      for (const item of sorted) {
        if (processed.has(item.i)) continue;
        trades[item.i] = {
          ...trades[item.i],
          status: "ARCHIVED",
          autoEntryStatus: "AUTO_ARCHIVED",
          reason: "duplicate_auto_pending",
          error: undefined,
          closedAt: trades[item.i]?.closedAt || nowForPending,
          updatedAt: nowForPending,
        };
        counts.duplicatesArchived += 1;
        counts.skipped += 1;
        tradesChanged = true;
      }
    }
  }

  counts.eligibleCount = eligibleIndexes.length;

  if (tradesChanged) {
    await writeTrades(trades);
  }

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
  const runSource = String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "unknown");
  const runId = String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "");

  const pushBreakerNote = (outcome: "SUCCESS" | "SKIP" | "FAIL", action: "increment" | "reset" | "none", after: number, reason: string) => {
    if (action === "increment") {
      notes.push(`breaker_increment:${after}:${reason}`);
      return;
    }
    if (action === "reset") {
      notes.push("breaker_reset");
      return;
    }
    if (outcome === "SKIP") {
      notes.push(`breaker_noop_skip:${reason}`);
    }
  };

  const recordOutcome = async (params: {
    outcome: "SUCCESS" | "SKIP" | "FAIL";
    reason: string;
    ticker?: string;
    tradeId?: string;
    detail?: string;
  }) => {
    const initial = evaluateBreakerTransition({
      outcome: params.outcome,
      reason: params.reason,
      consecutiveFailuresBefore: guardSummary.consecutiveFailures,
      maxConsecutiveFailures: guardConfig.maxConsecutiveFailures,
    });

    let after = initial.consecutiveFailuresAfter;
    let action = initial.breakerAction;

    if (params.outcome === "FAIL") {
      after = await guardrailsStore.recordFailure(etDate, params.reason);
      guardSummary.consecutiveFailures = after;
      const shouldDisable = after >= guardConfig.maxConsecutiveFailures;
      if (shouldDisable) {
        await guardrailsStore.setAutoDisabled(etDate, "max_consecutive_failures");
        guardSummary.autoDisabledReason = "max_consecutive_failures";
        if (params.tradeId && params.ticker) {
          await emitAutoDisabledNotification(params.tradeId, "max_consecutive_failures", params.ticker);
        }
      }
    } else if (params.outcome === "SUCCESS") {
      await guardrailsStore.resetFailures(etDate);
      await guardrailsStore.clearAutoDisabled(etDate);
      guardSummary.consecutiveFailures = 0;
      guardSummary.autoDisabledReason = null;
      after = 0;
      action = "reset";
    }

    pushBreakerNote(params.outcome, action, after, params.reason);

    await recordAutoEntryTelemetry({
      etDate,
      at: new Date().toISOString(),
      outcome: params.outcome,
      reason: params.reason,
      ticker: params.ticker,
      tradeId: params.tradeId,
      source: runSource,
      runId,
      detail: params.detail,
      consecutiveFailuresBefore: initial.consecutiveFailuresBefore,
      consecutiveFailuresAfter: after,
      breakerAction: action,
      breakerReason: params.reason,
    });
  };

  if (!cfg.enabled) {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "AUTO_TRADING_ENABLED=false",
        market: { isOpen: null, timestamp: nowIso(), reason: "auto_disabled" },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }
  if (!cfg.paperOnly) {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "AUTO_TRADING_PAPER_ONLY=false (blocked in Phase 4)",
        market: { isOpen: null, timestamp: nowIso(), reason: "paper_only_disabled" },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  if (!toggleState.enabled) {
    counts.skipped += 1;
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "auto_entry_disabled",
        market: { isOpen: null, timestamp: nowIso(), reason: "auto_entry_disabled" },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  if (!marketOpen) {
    counts.skipped += 1;
    await recordOutcome({ outcome: "SKIP", reason: "market_closed" });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "market_closed",
        market: { isOpen: false, timestamp: marketTimestamp, reason: marketReason || "market_closed" },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        wouldExecuteCount: counts.eligibleCount,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
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
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  if (brokerTruth.error) {
    counts.skipped += 1;
    await recordOutcome({ outcome: "SKIP", reason: "broker_truth_unavailable", detail: brokerTruth.error });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "broker_truth_unavailable",
        detail: brokerTruth.error,
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  if (brokerTruth.positionsCount >= guardConfig.maxOpenPositions) {
    counts.skipped += 1;
    await recordOutcome({
      outcome: "SKIP",
      reason: "max_open_positions",
      detail: `brokerPositionsCount=${brokerTruth.positionsCount}, maxOpenPositions=${guardConfig.maxOpenPositions}`,
    });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "max_open_positions",
        detail: `brokerPositionsCount=${brokerTruth.positionsCount}, maxOpenPositions=${guardConfig.maxOpenPositions}`,
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  if (guardState.entriesToday >= guardConfig.maxEntriesPerDay) {
    counts.skipped += 1;
    await recordOutcome({ outcome: "SKIP", reason: "max_entries_per_day" });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "max_entries_per_day",
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  const sinceLoss = minutesSince(guardState.lastLossAt);
  if (sinceLoss != null && sinceLoss < guardConfig.cooldownAfterLossMin) {
    const minsRemaining = Math.ceil(guardConfig.cooldownAfterLossMin - sinceLoss);
    guardSummary.cooldownRemainingMin = minsRemaining;
    counts.skipped += 1;
    await recordOutcome({ outcome: "SKIP", reason: "cooldown_after_loss" });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "cooldown_after_loss",
        detail: `${minsRemaining}m`,
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }
  let idx = eligibleIndexes.length > 0 ? eligibleIndexes[0] : -1;

  if (idx === -1) {
    counts.skipped += 1;
    await recordOutcome({ outcome: "SKIP", reason: "no_AUTO_PENDING" });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "no_AUTO_PENDING_trades",
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
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
    await recordOutcome({ outcome: "SKIP", reason: "ticker_cooldown", ticker });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "ticker_cooldown",
        detail: `${minsRemaining}m`,
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
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
    await recordOutcome({ outcome: "SKIP", reason: "already_locked", ticker, tradeId });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "already_locked",
        tradeId,
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  }

  const open = await hasOpenOrdersForSymbol(ticker);
  if (!open.ok) {
    await recordOutcome({
      outcome: "FAIL",
      reason: "broker_open_orders_lookup_failed",
      ticker,
      tradeId,
      detail: open.text || "alpaca open orders lookup failed",
    });
    return NextResponse.json(
      {
        ok: false,
        status: open.status,
        error: open.text || "alpaca open orders lookup failed",
        tradeId,
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 500 }
    );
  }
  if (open.orders.length > 0) {
    counts.skipped += 1;
    await recordOutcome({ outcome: "SKIP", reason: "open_order_exists", ticker, tradeId });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "open_order_exists",
        tradeId,
        openOrders: open.orders.map((o: any) => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, status: o.status })),
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
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
    if (lock.error === "LOCKED") {
      counts.skipped += 1;
      await recordOutcome({ outcome: "SKIP", reason: "already_locked", ticker, tradeId });
    } else {
      await recordOutcome({ outcome: "FAIL", reason: "alpaca_error", ticker, tradeId, detail: lock.error });
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
      counts.skipped += 1;
      await recordOutcome({ outcome: "SKIP", reason: "invalid_stop_vs_base_price", ticker, tradeId });
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: "invalid_stop_vs_base_price",
          tradeId,
          market: { isOpen: marketOpen, timestamp: marketTimestamp },
          openPositionsCount: brokerTruth.positionsCount,
          maxOpenPositions: guardConfig.maxOpenPositions,
          entriesToday: guardState.entriesToday,
          maxEntriesPerDay: guardConfig.maxEntriesPerDay,
          pendingCount: counts.pendingCount,
          eligibleCount: counts.eligibleCount,
          executedCount: counts.executed,
          counts,
          notes: notes.slice(0, 40),
          guardrails: guardSummary,
        },
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
      openedAt: startedAt,
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
    await recordOutcome({ outcome: "SUCCESS", reason: "placed", ticker, tradeId });
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
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const message = String(e?.message || e || "unknown_error");
    const stack = String(e?.stack || "");
    await recordOutcome({ outcome: "FAIL", reason: "execute_error", ticker, tradeId, detail: message });
    const updated = {
      ...trade,
      status: "ERROR",
      error: message,
      updatedAt: startedAt,
    };
    trades[idx] = updated;
    await writeTrades(trades);
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
      {
        ok: false,
        error: message,
        stack,
        tradeId,
        debug: dbg,
        market: { isOpen: marketOpen, timestamp: marketTimestamp },
        openPositionsCount: brokerTruth.positionsCount,
        maxOpenPositions: guardConfig.maxOpenPositions,
        entriesToday: guardState.entriesToday,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        pendingCount: counts.pendingCount,
        eligibleCount: counts.eligibleCount,
        executedCount: counts.executed,
        counts,
        notes: notes.slice(0, 40),
        guardrails: guardSummary,
      },
      { status: 500 }
    );
  }
}
