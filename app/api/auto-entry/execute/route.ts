import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { alpacaRequest, createOrder } from "@/lib/alpaca";
import { redis } from "@/lib/redis";
import { recordAutoEntryTelemetry } from "@/lib/autoEntry/telemetry";
import { requireAuth } from "@/lib/auth";
import { getGuardrailConfig, minutesSince } from "@/lib/autoEntry/guardrails";
import { getAutoConfig, tierForScore, riskMultForTier } from "@/lib/autoEntry/config";
import { getAutoManageConfig } from "@/lib/autoManage/config";
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
import { getEtDateString } from "@/lib/time/etDate";
import {
  buildAutoEntryDisabledNotificationEvent,
  notificationEnv,
  shouldSendAutoEntryDisabledNotification,
} from "@/lib/autoEntry/disabledNotification";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { buildAutoEntryFunnelFields } from "./funnel";
import { isOperationallyOpenTrade } from "@/lib/trades/operational";
import { buildOpenOrdersBySymbol, planConservativeReplacement } from "@/lib/autoManage/reliability";

async function bumpAutoEntryFunnelSafe(fields: Record<string, number | undefined>) {
  if (!fields || Object.keys(fields).length === 0) return;
  const numericOnly: Record<string, number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "number") numericOnly[key] = value;
  }
  if (Object.keys(numericOnly).length === 0) return;
  try {
    await bumpTodayFunnel(numericOnly as any);
  } catch (err) {
    console.log("[funnel] auto-entry bump failed (non-fatal)", err);
  }
}

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

function parseAlpacaError(err: any): { code: string; message: string } {
  const raw = String(err?.message || err || "");
  try {
    const parsed = JSON.parse(raw);
    return {
      code: String(parsed?.code ?? ""),
      message: String(parsed?.message ?? raw),
    };
  } catch {
    return { code: "", message: raw };
  }
}

function isAlpacaInvalidTakeProfitVsBase(err: any) {
  const parsed = parseAlpacaError(err);
  const msg = String(parsed.message || "").toLowerCase();
  const code = String(parsed.code || "");
  const hasTpConstraint = msg.includes("take_profit.limit_price") && msg.includes("base_price");
  const hasConstraintWords = msg.includes("must") || msg.includes("constraint") || msg.includes("higher") || msg.includes("lower");
  return code === "42210000" && hasTpConstraint && hasConstraintWords;
}

async function markTradeValidationSkipped(tradeId: string, reason: string, detail?: any) {
  const trades = await readTrades();
  const now = new Date().toISOString();
  let updated = 0;
  const next = trades.map((t: any) => {
    if (t.id !== tradeId) return t;
    updated += 1;
    const previousSkips = Number(t?.validationSkips ?? 0);
    return {
      ...t,
      status: "AUTO_PENDING",
      autoEntryStatus: "AUTO_PENDING",
      validationStatus: "PAYLOAD_VALIDATION_SKIPPED",
      validationReason: reason,
      validationSkips: Number.isFinite(previousSkips) ? previousSkips + 1 : 1,
      validationDetails: detail ?? t?.validationDetails,
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
  const roundedBase = Number(basePrice.toFixed(2));
  
  const roundUp = (x: number) => Number((Math.ceil(x / tick) * tick).toFixed(2));
  const roundDown = (x: number) => Number((Math.floor(x / tick) * tick).toFixed(2));
  const roundNearest = (x: number) => Number((Math.round(x / tick) * tick).toFixed(2));

  let tp = roundNearest(takeProfitPrice);
  let stop = isLong ? roundDown(stopPrice) : roundUp(stopPrice);

  const maxStopLong = roundDown(roundedBase - tick);
  const minStopShort = roundUp(roundedBase + tick);

  if (isLong && stop > maxStopLong) {
    stop = maxStopLong;
  }
  if (!isLong && stop < minStopShort) {
    stop = minStopShort;
  }
  
  // Validate stop price direction after repair.
  if (isLong && !(stop <= maxStopLong)) {
    return { valid: false, tp, stop, reason: "stop_price_invalid_for_side" };
  }
  if (!isLong && !(stop >= minStopShort)) {
    return { valid: false, tp, stop, reason: "stop_price_invalid_for_side" };
  }
  
  // Validate TP meets minimum requirements
  const minTpLong = roundUp(roundedBase + tick);
  const maxTpShort = roundDown(roundedBase - tick);
  
  const tpIsValid = isLong ? (tp >= minTpLong) : (tp <= maxTpShort);
  
  if (!tpIsValid) {
    // Try to repair TP using risk multiple
    const stopDist = Math.abs(roundedBase - stop);
    if (stopDist < tick) {
      return { valid: false, tp, stop, reason: "stop_distance_too_small" };
    }
    
    const repairedTp = isLong 
      ? roundUp(roundedBase + 2 * stopDist)
      : roundDown(roundedBase - 2 * stopDist);
    
    // Check if repaired TP is now valid
    const repairedTpValid = isLong ? (repairedTp >= minTpLong) : (repairedTp <= maxTpShort);
    if (!repairedTpValid) {
      return { valid: false, tp: repairedTp, stop, reason: "invalid_bracket_prices_unrepairable" };
    }
    
    return { valid: true, tp: repairedTp, stop, reason: "bracket_repaired_with_risk_multiple" };
  }
  
  return { valid: true, tp, stop };
}

function sideAwareBaseFromQuote(side: "LONG" | "SHORT", quote: QuoteLike | null, fallbackBase: number) {
  const candidates: number[] = [];
  const add = (value: any) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) candidates.push(n);
  };

  add(quote?.last);
  add(quote?.mid);
  add(quote?.bid);
  add(quote?.ask);
  add(fallbackBase);

  if (candidates.length === 0) return Number(fallbackBase.toFixed(2));
  const selected = side === "LONG" ? Math.min(...candidates) : Math.max(...candidates);
  return Number(selected.toFixed(2));
}

function stopValidationSummary(params: {
  side: "LONG" | "SHORT";
  base: number;
  stop: number;
}) {
  const epsilon = 0.000001;
  if (params.side === "LONG") {
    const passed = params.stop < params.base - epsilon;
    return {
      comparison: `stop(${params.stop.toFixed(2)}) < base(${params.base.toFixed(2)})`,
      passed,
    };
  }
  const passed = params.stop > params.base + epsilon;
  return {
    comparison: `stop(${params.stop.toFixed(2)}) > base(${params.base.toFixed(2)})`,
    passed,
  };
}

function repairBracketForBase(params: {
  side: "LONG" | "SHORT";
  base: number;
  stop: number;
  tp: number;
}) {
  const tick = 0.01;
  const base = Number(params.base.toFixed(2));
  let stop = Number(params.stop.toFixed(2));
  let tp = Number(params.tp.toFixed(2));

  if (params.side === "LONG") {
    const maxStop = Number((base - tick).toFixed(2));
    if (stop > maxStop) stop = maxStop;
    const minTp = Number((base + tick).toFixed(2));
    if (tp < minTp) tp = minTp;
  } else {
    const minStop = Number((base + tick).toFixed(2));
    if (stop < minStop) stop = minStop;
    const maxTp = Number((base - tick).toFixed(2));
    if (tp > maxTp) tp = maxTp;
  }

  return { stop, tp };
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
  const cronHeader = String(req.headers.get("x-cron-token") || "").trim();
  const hasCronToken = Boolean(cronHeader) && Boolean(process.env.CRON_TOKEN) && cronHeader === String(process.env.CRON_TOKEN);

  const cookieOk = await requireAuth(req);
  if (cookieOk.ok) {
    return {
      ok: true as const,
      cfg,
      hasCookieAuth: true,
      hasCronToken,
      authModeUsed: "cookie" as const,
    };
  }

  if (hasCronToken) {
    return {
      ok: true as const,
      cfg,
      hasCookieAuth: false,
      hasCronToken: true,
      authModeUsed: "cron_token" as const,
    };
  }

  if (!cfg.token) {
    return {
      ok: false as const,
      status: 500,
      error: "AUTO_ENTRY_TOKEN missing",
      hasCookieAuth: false,
      hasCronToken,
      authModeUsed: "none" as const,
    };
  }
  const got = headerToken(req);
  if (!got || got !== cfg.token) {
    return {
      ok: false as const,
      status: 401,
      error: "unauthorized",
      hasCookieAuth: false,
      hasCronToken,
      authModeUsed: "none" as const,
    };
  }
  return {
    ok: true as const,
    cfg,
    hasCookieAuth: false,
    hasCronToken,
    authModeUsed: "auto_entry_token" as const,
  };
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
  etDateUsed: string;
  guardKeyUsed: string;
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
  authModeUsed?: "cookie" | "cron_token" | "auto_entry_token" | "none";
  hasCookieAuth?: boolean;
  hasCronToken?: boolean;
};

const APP_BASE_URL = (process.env.APP_URL || "").replace(/\/$/, "");

function buildGuardSummary(params: {
  etDate: string;
  guardKeyUsed: string;
  guardState: guardrailsStore.GuardrailState;
  guardConfig: import("@/lib/autoEntry/guardrails").GuardrailConfig;
  toggleState: { enabled: boolean; reason: string | null };
  openPositions: number;
  brokerTruth?: BrokerTruth;
}): GuardSummary {
  return {
    etDateUsed: params.etDate,
    guardKeyUsed: params.guardKeyUsed,
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

async function emitAutoDisabledNotification(args: {
  tradeId: string;
  reason: string;
  ticker: string;
  host: string;
  env: string;
  etDate: string;
  runId: string;
}) {
  if (!shouldSendAutoEntryDisabledNotification(args.env)) {
    return;
  }

  await fireNotification(
    buildAutoEntryDisabledNotificationEvent({
      tradeId: args.tradeId,
      ticker: args.ticker,
      reason: args.reason,
      host: args.host,
      env: args.env,
      etDate: args.etDate,
      runId: args.runId,
    })
  );
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
    replacementConsidered: 0,
    replacementExecuted: 0,
  };
  const notes: string[] = [];
  const guardConfig = getGuardrailConfig();
  const etDate = getEtDateString();
  const guardKeyUsed = guardrailsStore.getGuardrailStateKey(etDate);
  const env = notificationEnv();
  const requestHost = (() => {
    try {
      const h = new URL(req.url).host;
      if (h) return h;
    } catch {}
    return String(process.env.VERCEL_URL || "unknown-host");
  })();
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
    etDate,
    guardKeyUsed,
    guardState,
    guardConfig,
    toggleState,
    openPositions,
    brokerTruth,
  });
  guardSummary = {
    ...guardSummary,
    authModeUsed: auth.authModeUsed,
    hasCookieAuth: auth.hasCookieAuth,
    hasCronToken: auth.hasCronToken,
  };
  const runSourceHeader = String(req.headers.get("x-run-source") || req.headers.get("x-scan-source") || "").trim();
  const runSource = runSourceHeader || (auth.hasCookieAuth ? "terminal" : "unknown");
  const runIdHeader = String(req.headers.get("x-run-id") || req.headers.get("x-scan-run-id") || "").trim();
  const runId = runIdHeader || `ae-exec-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  await bumpAutoEntryFunnelSafe({ autoEntryExecutes: 1 });

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
      after = await guardrailsStore.recordFailure(etDate, params.reason, {
        runId,
        tradeId: params.tradeId,
      });
      guardSummary.consecutiveFailures = after;
      const shouldDisable = after >= guardConfig.maxConsecutiveFailures;
      if (shouldDisable) {
        await guardrailsStore.setAutoDisabled(etDate, "max_consecutive_failures");
        guardSummary.autoDisabledReason = "max_consecutive_failures";
        if (params.tradeId && params.ticker) {
          await emitAutoDisabledNotification({
            tradeId: params.tradeId,
            reason: "max_consecutive_failures",
            ticker: params.ticker,
            host: requestHost,
            env,
            etDate,
            runId,
          });
        }
      }
    } else if (params.outcome === "SUCCESS") {
      await guardrailsStore.resetFailures(etDate);
      if (initial.clearAutoDisabled) {
        await guardrailsStore.clearAutoDisabled(etDate);
      }
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

    await bumpAutoEntryFunnelSafe(buildAutoEntryFunnelFields({
      outcome: params.outcome,
      reason: params.reason,
    }));
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
    await emitAutoDisabledNotification({
      tradeId: "guardrail-state",
      reason: String(guardState.autoDisabledReason),
      ticker: "AUTO_ENTRY",
      host: requestHost,
      env,
      etDate,
      runId,
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

  const maxOpenReached = brokerTruth.positionsCount >= guardConfig.maxOpenPositions;

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

  const autoManageCfg = getAutoManageConfig();
  const brokerPositionsBySymbol = new Map<string, any>(
    (Array.isArray(brokerTruth.positions) ? brokerTruth.positions : []).map((p: any) => [
      String(p?.symbol || "").toUpperCase(),
      p,
    ])
  );
  const openOrdersLite = (Array.isArray(brokerTruth.openOrders) ? brokerTruth.openOrders : []).map((o: any) => ({
    id: String(o?.id || ""),
    symbol: String(o?.symbol || "").toUpperCase(),
    side: String(o?.side || ""),
    type: String(o?.type || ""),
    status: String(o?.status || ""),
    order_class: String(o?.order_class || ""),
    client_order_id: String(o?.client_order_id || ""),
    legs: [],
  }));
  const openOrdersBySymbol = buildOpenOrdersBySymbol(openOrdersLite);
  const openTradesForReplacement = (Array.isArray(trades) ? trades : []).filter((t: any) => isOperationallyOpenTrade(t));

  const replacementPlan = planConservativeReplacement({
    incomingTrade: trade,
    openTrades: openTradesForReplacement,
    brokerPositionsBySymbol,
    openOrdersBySymbol,
    nowIso: nowIso(),
    marketClosed: !marketOpen,
    staleAfterEt: autoManageCfg.staleAfterEt,
    eodFlattenEnabled: autoManageCfg.eodFlatten,
    maxOpenReached,
    config: {
      thresholdScoreDelta: autoManageCfg.replaceScoreDelta,
      minAgeMin: autoManageCfg.replaceMinAgeMin,
      protectWinnerAboveR: autoManageCfg.replaceProtectWinnerAboveR,
      allowUnknownROverride: autoManageCfg.replaceUnknownROverride,
    },
  });

  if (replacementPlan.replacementConsidered) counts.replacementConsidered += 1;

  if (maxOpenReached && (!autoManageCfg.replaceEnabled || !replacementPlan.replacementExecuted)) {
    counts.skipped += 1;
    const detail = JSON.stringify({
      brokerPositionsCount: brokerTruth.positionsCount,
      maxOpenPositions: guardConfig.maxOpenPositions,
      replacementEnabled: autoManageCfg.replaceEnabled,
      replacement: replacementPlan,
    });
    await recordOutcome({ outcome: "SKIP", reason: "max_open_positions", ticker, tradeId: String(trade?.id || ""), detail });
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: "max_open_positions",
        detail,
        replacement: replacementPlan,
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

  if (maxOpenReached && replacementPlan.replacementExecuted) {
    const weakestTradeId = String(replacementPlan.weakestOpenTradeId || "");
    const weakestIdx = trades.findIndex((t: any) => String(t?.id || "") === weakestTradeId);
    const weakestTrade = weakestIdx >= 0 ? trades[weakestIdx] : null;
    const weakestTicker = String(weakestTrade?.ticker || replacementPlan.weakestOpenTicker || "").toUpperCase();
    const weakestPos = brokerPositionsBySymbol.get(weakestTicker);
    const weakestQty = Math.abs(Number(weakestPos?.qty ?? weakestTrade?.quantity ?? 0));

    if (!(weakestTrade && weakestTicker && Number.isFinite(weakestQty) && weakestQty > 0)) {
      counts.skipped += 1;
      await recordOutcome({
        outcome: "SKIP",
        reason: "replacement_close_unavailable",
        ticker,
        tradeId: String(trade?.id || ""),
        detail: JSON.stringify({ replacement: replacementPlan, weakestTradeFound: Boolean(weakestTrade), weakestTicker, weakestQty }),
      });
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: "replacement_close_unavailable",
          replacement: replacementPlan,
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

    const weakestSide = String(weakestTrade?.side || "LONG").toUpperCase();
    const replacementCloseSide = weakestSide === "SHORT" ? "buy" : "sell";
    try {
      const closeOrder: any = await createOrder({
        symbol: weakestTicker,
        qty: weakestQty,
        side: replacementCloseSide,
        type: "market",
        time_in_force: "day",
      });

      const now = nowIso();
      trades[weakestIdx] = {
        ...weakestTrade,
        closeRequestedAt: now,
        closeOrderId: String(closeOrder?.id || weakestTrade?.closeOrderId || ""),
        closeOrderStatus: String(closeOrder?.status || "accepted"),
        updatedAt: now,
        autoManage: {
          ...(weakestTrade?.autoManage || {}),
          replacementConsidered: true,
          replacementExecuted: true,
          replacementReason: replacementPlan.replacementReason,
          replacementTriggeredByTradeId: String(trade?.id || ""),
          replacementTriggeredAt: now,
        },
      };

      await writeTrades(trades);
      counts.replacementExecuted += 1;
      notes.push(`replacement_close_submitted:${weakestTicker}`);
    } catch (replacementErr: any) {
      counts.skipped += 1;
      await recordOutcome({
        outcome: "FAIL",
        reason: "replacement_close_submit_failed",
        ticker,
        tradeId: String(trade?.id || ""),
        detail: String(replacementErr?.message || replacementErr || "replacement_close_submit_failed"),
      });
      return NextResponse.json(
        {
          ok: false,
          error: "replacement_close_submit_failed",
          detail: String(replacementErr?.message || replacementErr || "replacement_close_submit_failed"),
          replacement: replacementPlan,
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
  const targetPriceRaw = safeNum(trade.takeProfitPrice ?? trade.targetPrice, 0);
  const targetPrice = targetPriceRaw > 0 ? targetPriceRaw : null;

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
  const basePriceForValidation =
    Number.isFinite(decision.decisionPrice) && decision.decisionPrice > 0
      ? Number(decision.decisionPrice)
      : Number(entryPrice);

  const computedBasePrice = Number(basePriceForValidation.toFixed(4));
  const submitBasePrice = Number(basePriceForValidation.toFixed(2));
  const stopDistance = Math.abs(entryPrice - stopPrice);
  const rr = 1;

  const tpRaw = sideEnum === "LONG"
    ? submitBasePrice + stopDistance * rr
    : submitBasePrice - stopDistance * rr;

  let tp = Math.round(tpRaw * 100) / 100;
  let bracketStop = Math.round((sideEnum === "LONG" ? submitBasePrice - stopDistance : submitBasePrice + stopDistance) * 100) / 100;

  const bracketGuard = ensureBracketLegsValid({
    side: sideEnum,
    basePrice: submitBasePrice,
    takeProfitLimit: tp,
    stopLossStop: bracketStop,
  });
  tp = bracketGuard.takeProfitLimit;
  bracketStop = bracketGuard.stopLossStop;

  const TP_MIN_OFFSET_FORCE = 0.50;
  if (sideEnum === "LONG") {
    const minTp = Number((submitBasePrice + TP_MIN_OFFSET_FORCE).toFixed(2));
    if (tp < minTp) tp = minTp;
  } else {
    const maxTp = Number((submitBasePrice - TP_MIN_OFFSET_FORCE).toFixed(2));
    if (tp > maxTp) tp = maxTp;
  }

  if (sideDirection === "buy") {
    const minTpAbs = Number((submitBasePrice + AUTO_ENTRY_TP_MIN_ABS).toFixed(2));
    if (tp < minTpAbs) tp = minTpAbs;
  } else {
    const maxTpAbs = Number((submitBasePrice - AUTO_ENTRY_TP_MIN_ABS).toFixed(2));
    if (tp > maxTpAbs) tp = maxTpAbs;
  }

  tp = Number(tp.toFixed(2));
  bracketStop = Number(bracketStop.toFixed(2));

  const initialStopCheck = stopValidationSummary({
    side: sideEnum,
    base: submitBasePrice,
    stop: bracketStop,
  });

  const dbg: any = {
    ticker,
    side,
    entryPrice,
    stopPrice,
    targetPrice,
    quote,
    decisionPrice: decision.decisionPrice,
    decisionSource: decision.source,
    computedBasePrice,
    basePriceForValidation,
    submitBasePrice,
    stopDistance,
    originalTargetPrice: targetPrice,
    stopValidationComparison: initialStopCheck.comparison,
    stopValidationPassed: initialStopCheck.passed,
    takeProfitPrice: tp,
    bracketStopPrice: bracketStop,
    qty,
    riskDollars,
    tier,
    score,
    replacement: replacementPlan,
  };

  const lock = await withRedisLock({
    key: redisLockKey,
    ttlSeconds: 90,
    owner: `execute:${tradeId}`,
    fn: async () => {
      let validationReason = "ok";
      let failureReasonDetailed = "";
      // Validate and repair bracket BEFORE submitting order
      const bracketCheck = validateAndRepairBracket({
        side: sideDirection === "buy" ? "LONG" : "SHORT",
        basePrice: submitBasePrice,
        takeProfitPrice: tp,
        stopPrice: bracketStop,
      });
      
      if (!bracketCheck.valid) {
        validationReason = bracketCheck.reason || "bracket_validation_failed";
        return {
          __poison: true,
          reason: "invalid_stop_vs_base_price",
          message: `bracket_validation_failed: ${validationReason}`,
          validation: {
            entryPrice,
            stopPrice,
            targetPrice,
            computedBasePrice,
            side: sideEnum,
            validationReason,
            stopValidationComparison: initialStopCheck.comparison,
            stopValidationPassed: initialStopCheck.passed,
            failureReasonDetailed: validationReason,
            payloadPreview: {
              symbol: ticker,
              qty,
              side: sideDirection,
              type: "market",
              time_in_force: "day",
              stop_loss: { stop_price: bracketCheck.stop },
              take_profit: { limit_price: bracketCheck.tp },
            },
          },
        } as any;
      }
      
      // Use repaired bracket if it was corrected
      let finalTp = bracketCheck.tp;
      let finalStop = bracketCheck.stop;
      if (bracketCheck.reason) {
        validationReason = bracketCheck.reason;
      }

      // Apply FINAL tick normalization
      const tick = tickForEquityPrice(entryPrice);
      const stopNorm = normalizeStopPrice({
        side: sideDirection === "buy" ? "LONG" : "SHORT",
        entryPrice: submitBasePrice,
        stopPrice: finalStop,
        tick,
      });
      if (!stopNorm.ok) {
        validationReason = `stop_normalization_failed:${stopNorm.reason}`;
        failureReasonDetailed = validationReason;
        return {
          __poison: true,
          reason: "invalid_stop_vs_base_price",
          message: validationReason,
          validation: {
            entryPrice,
            stopPrice,
            targetPrice,
            computedBasePrice,
            side: sideEnum,
            validationReason,
            stopValidationComparison: initialStopCheck.comparison,
            stopValidationPassed: false,
            failureReasonDetailed,
          },
        } as any;
      }
      finalStop = stopNorm.stop;

      finalTp = normalizeLimitPrice({ price: finalTp, tick });
      finalTp = Number(finalTp.toFixed(2));
      const baseRounded = Number(submitBasePrice.toFixed(2));

      const maxStopLong = Number((baseRounded - tick).toFixed(2));
      const minStopShort = Number((baseRounded + tick).toFixed(2));
      if (sideDirection === "buy" && finalStop > maxStopLong) {
        finalStop = maxStopLong;
        validationReason = "stop_adjusted_to_base_tick";
      }
      if (sideDirection === "sell" && finalStop < minStopShort) {
        finalStop = minStopShort;
        validationReason = "stop_adjusted_to_base_tick";
      }

      const takeProfitValid =
        sideDirection === "buy"
          ? finalTp >= Number((baseRounded + 0.01).toFixed(2))
          : finalTp <= Number((baseRounded - 0.01).toFixed(2));

      if (!takeProfitValid) {
        return {
          __poison: true,
          reason: "invalid_take_profit_vs_base_price",
          detail: JSON.stringify({ base_price: baseRounded, take_profit: finalTp }),
          validation: {
            entryPrice,
            stopPrice,
            targetPrice,
            computedBasePrice,
            side: sideEnum,
            validationReason: "take_profit_invalid_vs_base",
            payloadPreview: {
              symbol: ticker,
              qty,
              side: sideDirection,
              type: "market",
              time_in_force: "day",
              stop_loss: { stop_price: finalStop },
              take_profit: { limit_price: finalTp },
            },
          },
        } as any;
      }

      const minTpLong = Number((baseRounded + tick).toFixed(2));
      const maxTpShort = Number((baseRounded - tick).toFixed(2));

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
          const refreshedQuote = await fetchQuoteForSymbol(ticker);
          const refreshedBase = sideAwareBaseFromQuote(sideEnum, refreshedQuote, submitBasePrice);
          const repaired = repairBracketForBase({
            side: sideEnum,
            base: refreshedBase,
            stop: finalStop,
            tp: finalTp,
          });
          const refreshedStopCheck = stopValidationSummary({
            side: sideEnum,
            base: refreshedBase,
            stop: repaired.stop,
          });

          const retryPayload: any = {
            ...payload,
            stop_loss: { stop_price: repaired.stop },
          };
          const retryTpValid =
            sideEnum === "LONG"
              ? repaired.tp >= Number((refreshedBase + tick).toFixed(2))
              : repaired.tp <= Number((refreshedBase - tick).toFixed(2));
          if (retryTpValid) {
            retryPayload.order_class = "bracket";
            retryPayload.take_profit = { limit_price: repaired.tp };
          } else {
            retryPayload.order_class = "oto";
            delete retryPayload.take_profit;
          }

          try {
            return await createOrder(retryPayload);
          } catch (retryErr: any) {
            failureReasonDetailed = `alpaca_rejected_stop_vs_base_retry_failed:${String(retryErr?.message || retryErr || "")}`;
            return {
              __poison: true,
              reason: "invalid_stop_vs_base_price",
              message: String(retryErr?.message || retryErr || ""),
              validation: {
                entryPrice,
                stopPrice,
                targetPrice,
                computedBasePrice: refreshedBase,
                side: sideEnum,
                validationReason: "alpaca_rejected_stop_vs_base",
                stopValidationComparison: refreshedStopCheck.comparison,
                stopValidationPassed: refreshedStopCheck.passed,
                failureReasonDetailed,
                payloadPreview: retryPayload,
              },
            } as any;
          }
        }
        if (isAlpacaInvalidTakeProfitVsBase(e)) {
          return {
            __poison: true,
            reason: "invalid_take_profit_vs_base_price",
            detail: JSON.stringify({
              base_price: Number(submitBasePrice.toFixed(2)),
              take_profit: finalTp,
            }),
            message: String(e?.message || e || ""),
            validation: {
              entryPrice,
              stopPrice,
              targetPrice,
              computedBasePrice,
              side: sideEnum,
              validationReason: "alpaca_rejected_tp_vs_base",
              stopValidationComparison: initialStopCheck.comparison,
              stopValidationPassed: initialStopCheck.passed,
              failureReasonDetailed: String(e?.message || e || ""),
              payloadPreview: payload,
            },
          } as any;
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
      const poisonReason =
        (order as any)?.reason === "invalid_take_profit_vs_base_price"
          ? "invalid_take_profit_vs_base_price"
          : "invalid_stop_vs_base_price";
      const validation = (order as any)?.validation || {
        entryPrice,
        stopPrice,
        targetPrice,
        computedBasePrice,
        side: sideEnum,
        validationReason: poisonReason,
        stopValidationComparison: initialStopCheck.comparison,
        stopValidationPassed: initialStopCheck.passed,
        failureReasonDetailed: poisonReason,
      };
      counts.invalidMarked += 1;
      await markTradeValidationSkipped(tradeId, poisonReason, validation);
      counts.skipped += 1;
      await recordOutcome({
        outcome: "SKIP",
        reason: poisonReason,
        ticker,
        tradeId,
        detail:
          poisonReason === "invalid_take_profit_vs_base_price"
            ? (order as any)?.detail || JSON.stringify({ base_price: Number(submitBasePrice.toFixed(2)), take_profit: Number(tp.toFixed(2)) })
            : JSON.stringify(validation),
      });
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: poisonReason,
          classification: "payload_validation_retryable",
          validation,
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
