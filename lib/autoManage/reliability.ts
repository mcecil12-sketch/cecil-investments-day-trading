import { alpacaRequest, createOrder, getPositions } from "@/lib/alpaca";
import { computeUnrealizedR } from "@/lib/autoManage/risk";

const num = (value: any) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const up = (value: any) => String(value || "").toUpperCase();

function getEtHourMinute(nowIso: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(nowIso));

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "NaN");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "NaN");
  return {
    hour: Number.isFinite(hour) ? hour : -1,
    minute: Number.isFinite(minute) ? minute : -1,
  };
}

function parseHourMinute(value: string) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function isEtAtOrAfter(nowIso: string, thresholdEt: string) {
  const now = getEtHourMinute(nowIso);
  const threshold = parseHourMinute(thresholdEt);
  if (!threshold) return false;
  if (now.hour > threshold.hour) return true;
  if (now.hour < threshold.hour) return false;
  return now.minute >= threshold.minute;
}

export function getTradeTimestamp(trade: any) {
  return String(trade?.openedAt || trade?.executedAt || trade?.createdAt || trade?.updatedAt || "");
}

export function getTradeAgeMin(trade: any, nowIso: string) {
  const started = Date.parse(getTradeTimestamp(trade));
  const now = Date.parse(nowIso);
  if (!Number.isFinite(started) || !Number.isFinite(now) || now < started) return null;
  return (now - started) / 60000;
}

export function getTradeScore(trade: any) {
  return num(trade?.aiScore ?? trade?.score ?? trade?.ai?.score);
}

export function getTradeTier(trade: any) {
  const tier = String(trade?.aiGrade || trade?.grade || trade?.ai?.grade || "").trim().toUpperCase();
  return tier || null;
}

export type OpenOrderLite = {
  id: string;
  symbol: string;
  side?: string;
  type?: string;
  status?: string;
  order_class?: string;
  client_order_id?: string;
  legs?: any[];
};

function flattenOrderLegs(order: any, out: OpenOrderLite[]) {
  const id = String(order?.id || "");
  const symbol = up(order?.symbol);
  if (id && symbol) {
    out.push({
      id,
      symbol,
      side: String(order?.side || ""),
      type: String(order?.type || ""),
      status: String(order?.status || ""),
      order_class: String(order?.order_class || ""),
      client_order_id: String(order?.client_order_id || ""),
      legs: Array.isArray(order?.legs) ? order.legs : [],
    });
  }
  const legs = Array.isArray(order?.legs) ? order.legs : [];
  for (const leg of legs) {
    flattenOrderLegs(leg, out);
  }
}

export async function fetchOpenOrdersDetailed(): Promise<OpenOrderLite[]> {
  try {
    const resp = await alpacaRequest({ method: "GET", path: "/v2/orders?status=open&nested=true&limit=500" });
    if (!resp.ok) return [];
    const parsed = JSON.parse(resp.text || "[]");
    const orders = Array.isArray(parsed) ? parsed : [];
    const out: OpenOrderLite[] = [];
    for (const order of orders) {
      flattenOrderLegs(order, out);
    }
    return out;
  } catch {
    return [];
  }
}

export function buildOpenOrdersBySymbol(orders: OpenOrderLite[]) {
  const out = new Map<string, OpenOrderLite[]>();
  for (const order of Array.isArray(orders) ? orders : []) {
    const symbol = up(order?.symbol);
    if (!symbol) continue;
    const bucket = out.get(symbol) || [];
    bucket.push(order);
    out.set(symbol, bucket);
  }
  return out;
}

function normalizeQty(trade: any, brokerPosition?: any) {
  const tradeQty = num(trade?.quantity ?? trade?.qty ?? trade?.size ?? trade?.positionSize ?? trade?.shares);
  if (tradeQty != null && tradeQty > 0) return tradeQty;
  const brokerQty = Math.abs(num(brokerPosition?.qty) ?? 0);
  if (brokerQty > 0) return brokerQty;
  return 0;
}

function isStopLikeOrder(order: OpenOrderLite) {
  const type = String(order?.type || "").toLowerCase();
  return type.includes("stop");
}

function isCloseSideForTrade(order: OpenOrderLite, tradeSide: string) {
  const side = String(order?.side || "").toLowerCase();
  const tradeSideUp = up(tradeSide);
  if (tradeSideUp === "SHORT") return side === "buy";
  return side === "sell";
}

export type StaleReasonCode =
  | "eod_flatten_missed"
  | "broker_position_stale_after_close"
  | "db_trade_stale_open"
  | "close_order_submitted_not_finalized"
  | "stale_open_without_broker_order"
  | "stale_open_with_conflicting_stop";

export type StaleOpenClassification = {
  stale: boolean;
  reason: StaleReasonCode | null;
  hasBrokerPosition: boolean;
  hasOpenOrders: boolean;
  hasCloseOrderOpen: boolean;
  hasConflictingStop: boolean;
  afterStaleWindow: boolean;
  ageMin: number | null;
};

export function classifyStaleOpenTrade(args: {
  trade: any;
  brokerPosition?: any;
  openOrders?: OpenOrderLite[];
  nowIso: string;
  marketClosed: boolean;
  staleAfterEt: string;
  eodFlattenEnabled: boolean;
}) : StaleOpenClassification {
  const openOrders = Array.isArray(args.openOrders) ? args.openOrders : [];
  const hasBrokerPosition = Boolean(args.brokerPosition && Math.abs(num(args.brokerPosition?.qty) ?? 0) > 0);
  const hasOpenOrders = openOrders.length > 0;
  const hasCloseOrderOpen = openOrders.some((order) => isCloseSideForTrade(order, args.trade?.side));
  const hasConflictingStop = openOrders.some((order) => isStopLikeOrder(order));
  const afterStaleWindow = args.marketClosed || isEtAtOrAfter(args.nowIso, args.staleAfterEt);
  const ageMin = getTradeAgeMin(args.trade, args.nowIso);

  if (!afterStaleWindow) {
    return {
      stale: false,
      reason: null,
      hasBrokerPosition,
      hasOpenOrders,
      hasCloseOrderOpen,
      hasConflictingStop,
      afterStaleWindow,
      ageMin,
    };
  }

  if (hasBrokerPosition && hasCloseOrderOpen) {
    return {
      stale: true,
      reason: "close_order_submitted_not_finalized",
      hasBrokerPosition,
      hasOpenOrders,
      hasCloseOrderOpen,
      hasConflictingStop,
      afterStaleWindow,
      ageMin,
    };
  }

  if (hasBrokerPosition && hasConflictingStop) {
    return {
      stale: true,
      reason: "stale_open_with_conflicting_stop",
      hasBrokerPosition,
      hasOpenOrders,
      hasCloseOrderOpen,
      hasConflictingStop,
      afterStaleWindow,
      ageMin,
    };
  }

  if (hasBrokerPosition && args.marketClosed) {
    return {
      stale: true,
      reason: args.eodFlattenEnabled ? "eod_flatten_missed" : "broker_position_stale_after_close",
      hasBrokerPosition,
      hasOpenOrders,
      hasCloseOrderOpen,
      hasConflictingStop,
      afterStaleWindow,
      ageMin,
    };
  }

  if (hasBrokerPosition) {
    return {
      stale: true,
      reason: "broker_position_stale_after_close",
      hasBrokerPosition,
      hasOpenOrders,
      hasCloseOrderOpen,
      hasConflictingStop,
      afterStaleWindow,
      ageMin,
    };
  }

  if (!hasBrokerPosition && hasConflictingStop) {
    return {
      stale: true,
      reason: "stale_open_with_conflicting_stop",
      hasBrokerPosition,
      hasOpenOrders,
      hasCloseOrderOpen,
      hasConflictingStop,
      afterStaleWindow,
      ageMin,
    };
  }

  if (!hasBrokerPosition && hasOpenOrders) {
    return {
      stale: true,
      reason: "stale_open_without_broker_order",
      hasBrokerPosition,
      hasOpenOrders,
      hasCloseOrderOpen,
      hasConflictingStop,
      afterStaleWindow,
      ageMin,
    };
  }

  return {
    stale: true,
    reason: "db_trade_stale_open",
    hasBrokerPosition,
    hasOpenOrders,
    hasCloseOrderOpen,
    hasConflictingStop,
    afterStaleWindow,
    ageMin,
  };
}

export type FlattenAttemptResult = {
  attempted: boolean;
  succeeded: boolean;
  failed: boolean;
  reason: string;
  flattenOrderCount: number;
  flattenClosedCount: number;
  flattenErrorMessage?: string;
  lastFlattenAt: string;
  closeOrderId?: string;
  closeOrderStatus?: string;
  cancelledOrderIds: string[];
  skippedBecauseCloseAlreadyOpen?: boolean;
};

async function cancelOrderId(orderId: string) {
  const resp = await alpacaRequest({ method: "DELETE", path: `/v2/orders/${encodeURIComponent(orderId)}` });
  return resp.ok || resp.status === 404;
}

export async function attemptFlattenPosition(args: {
  trade: any;
  brokerPosition?: any;
  openOrders?: OpenOrderLite[];
  nowIso: string;
  reason: string;
  marketClosed: boolean;
}): Promise<FlattenAttemptResult> {
  const openOrders = Array.isArray(args.openOrders) ? args.openOrders : [];
  const brokerPosition = args.brokerPosition;
  const ticker = up(args.trade?.ticker);
  const lastFlattenAt = args.nowIso;

  if (!ticker) {
    return {
      attempted: true,
      succeeded: false,
      failed: true,
      reason: args.reason,
      flattenOrderCount: 0,
      flattenClosedCount: 0,
      flattenErrorMessage: "missing_ticker",
      lastFlattenAt,
      cancelledOrderIds: [],
    };
  }

  const existingCloseOrder = openOrders.find((order) => isCloseSideForTrade(order, args.trade?.side));
  if (existingCloseOrder) {
    return {
      attempted: true,
      succeeded: true,
      failed: false,
      reason: `${args.reason}:close_order_already_open`,
      flattenOrderCount: openOrders.length,
      flattenClosedCount: 0,
      lastFlattenAt,
      cancelledOrderIds: [],
      closeOrderId: existingCloseOrder.id,
      closeOrderStatus: existingCloseOrder.status,
      skippedBecauseCloseAlreadyOpen: true,
    };
  }

  const cancelIds = openOrders.map((order) => String(order.id || "")).filter(Boolean);
  const cancelledOrderIds: string[] = [];
  for (const orderId of cancelIds) {
    const cancelled = await cancelOrderId(orderId);
    if (!cancelled) {
      return {
        attempted: true,
        succeeded: false,
        failed: true,
        reason: args.reason,
        flattenOrderCount: openOrders.length,
        flattenClosedCount: 0,
        flattenErrorMessage: `cancel_failed:${orderId}`,
        lastFlattenAt,
        cancelledOrderIds,
      };
    }
    cancelledOrderIds.push(orderId);
  }

  if (!brokerPosition || Math.abs(num(brokerPosition?.qty) ?? 0) <= 0) {
    return {
      attempted: true,
      succeeded: true,
      failed: false,
      reason: `${args.reason}:no_broker_position`,
      flattenOrderCount: cancelledOrderIds.length,
      flattenClosedCount: 0,
      lastFlattenAt,
      cancelledOrderIds,
    };
  }

  if (args.marketClosed) {
    return {
      attempted: true,
      succeeded: false,
      failed: true,
      reason: args.reason,
      flattenOrderCount: openOrders.length,
      flattenClosedCount: 0,
      flattenErrorMessage: "market_closed_before_flatten_submit",
      lastFlattenAt,
      cancelledOrderIds,
    };
  }

  const qty = normalizeQty(args.trade, brokerPosition);
  if (!(qty > 0)) {
    return {
      attempted: true,
      succeeded: false,
      failed: true,
      reason: args.reason,
      flattenOrderCount: openOrders.length,
      flattenClosedCount: 0,
      flattenErrorMessage: "close_qty_invalid",
      lastFlattenAt,
      cancelledOrderIds,
    };
  }

  const closeSide = up(args.trade?.side) === "SHORT" ? "buy" : "sell";
  try {
    const order: any = await createOrder({
      symbol: ticker,
      qty,
      side: closeSide,
      type: "market",
      time_in_force: "day",
      extended_hours: false,
    });

    const closeOrderId = String(order?.id || "");
    if (!closeOrderId) {
      return {
        attempted: true,
        succeeded: false,
        failed: true,
        reason: args.reason,
        flattenOrderCount: openOrders.length,
        flattenClosedCount: 0,
        flattenErrorMessage: "close_order_missing_id",
        lastFlattenAt,
        cancelledOrderIds,
      };
    }

    return {
      attempted: true,
      succeeded: true,
      failed: false,
      reason: args.reason,
      flattenOrderCount: openOrders.length + 1,
      flattenClosedCount: 1,
      lastFlattenAt,
      closeOrderId,
      closeOrderStatus: String(order?.status || ""),
      cancelledOrderIds,
    };
  } catch (err: any) {
    return {
      attempted: true,
      succeeded: false,
      failed: true,
      reason: args.reason,
      flattenOrderCount: openOrders.length,
      flattenClosedCount: 0,
      flattenErrorMessage: String(err?.message || err),
      lastFlattenAt,
      cancelledOrderIds,
    };
  }
}

export function applyFlattenDiagnosticsToTrade(args: {
  trade: any;
  nowIso: string;
  flatten: FlattenAttemptResult;
  stale?: StaleOpenClassification | null;
}) {
  const autoManage = { ...(args.trade?.autoManage || {}) };
  autoManage.eodFlattenAttempted = args.flatten.attempted;
  autoManage.eodFlattenSucceeded = args.flatten.succeeded;
  autoManage.eodFlattenFailed = args.flatten.failed;
  autoManage.flattenReason = args.flatten.reason;
  autoManage.flattenOrderCount = args.flatten.flattenOrderCount;
  autoManage.flattenClosedCount = args.flatten.flattenClosedCount;
  autoManage.flattenErrorMessage = args.flatten.flattenErrorMessage;
  autoManage.lastFlattenAt = args.flatten.lastFlattenAt;
  if (args.stale) {
    autoManage.staleOpen = args.stale.stale;
    autoManage.staleReason = args.stale.reason;
    autoManage.staleDetectedAt = args.nowIso;
  }

  return {
    ...args.trade,
    closeOrderId: args.flatten.closeOrderId || args.trade?.closeOrderId,
    closeOrderStatus: args.flatten.closeOrderStatus || args.trade?.closeOrderStatus,
    closeRequestedAt: args.flatten.attempted ? args.nowIso : args.trade?.closeRequestedAt,
    updatedAt: args.nowIso,
    autoManage,
  };
}

export function finalizeTradeWithoutBroker(args: {
  trade: any;
  nowIso: string;
  reason: string;
  stale?: StaleOpenClassification | null;
}) {
  const autoManage = { ...(args.trade?.autoManage || {}) };
  autoManage.staleOpen = args.stale?.stale ?? true;
  autoManage.staleReason = args.stale?.reason || args.reason;
  autoManage.staleDetectedAt = args.nowIso;
  autoManage.lastFlattenAt = args.trade?.autoManage?.lastFlattenAt || args.nowIso;
  autoManage.lastFlattenOutcome = "finalized_without_broker_position";

  return {
    ...args.trade,
    status: "CLOSED",
    autoEntryStatus: "CLOSED",
    closedAt: args.trade?.closedAt || args.nowIso,
    finalizedAt: args.nowIso,
    closeReason: args.reason,
    updatedAt: args.nowIso,
    error: undefined,
    autoManage,
  };
}

export type ReplacementConfig = {
  thresholdScoreDelta: number;
  minAgeMin: number;
  protectWinnerAboveR: number;
  allowUnknownROverride: boolean;
};

export type ReplacementDiagnostics = {
  replacementConsidered: boolean;
  replacementExecuted: boolean;
  replacementSkipped: boolean;
  replacementReason: string;
  weakestOpenTradeId: string | null;
  weakestOpenTicker: string | null;
  incomingCandidateScore: number | null;
  weakestOpenScore: number | null;
  weakestOpenUnrealizedR: number | null;
  weakestOpenAgeMin: number | null;
  replacementThresholdUsed: number;
};

type ReplacementCandidateState = {
  trade: any;
  score: number | null;
  ageMin: number | null;
  unrealizedR: number | null;
  stale: StaleOpenClassification;
  weaknessRank: number;
};

function computeCurrentR(trade: any, brokerPosition?: any) {
  const fromTrade = num(trade?.unrealizedR);
  if (fromTrade != null) return fromTrade;

  const entryPrice = num(trade?.entryPrice);
  const stopPrice = num(trade?.stopPrice);
  const currentPrice = num(brokerPosition?.current_price);
  const qty = normalizeQty(trade, brokerPosition);
  if (!(qty > 0)) return null;
  return computeUnrealizedR({
    side: String(trade?.side || "LONG"),
    qty,
    entryPrice,
    stopPrice,
    currentPrice,
  });
}

function buildReplacementState(args: {
  trade: any;
  brokerPosition?: any;
  openOrders?: OpenOrderLite[];
  nowIso: string;
  marketClosed: boolean;
  staleAfterEt: string;
  eodFlattenEnabled: boolean;
}) : ReplacementCandidateState {
  const stale = classifyStaleOpenTrade({
    trade: args.trade,
    brokerPosition: args.brokerPosition,
    openOrders: args.openOrders,
    nowIso: args.nowIso,
    marketClosed: args.marketClosed,
    staleAfterEt: args.staleAfterEt,
    eodFlattenEnabled: args.eodFlattenEnabled,
  });
  const score = getTradeScore(args.trade);
  const ageMin = getTradeAgeMin(args.trade, args.nowIso);
  const unrealizedR = computeCurrentR(args.trade, args.brokerPosition);

  let weaknessRank = 0;
  if (stale.stale) weaknessRank += 100;
  if (unrealizedR == null) weaknessRank += 20;
  if (unrealizedR != null && unrealizedR < 0) weaknessRank += Math.min(60, Math.abs(unrealizedR) * 20);
  if (score != null) weaknessRank += Math.max(0, 10 - score);
  if (score == null) weaknessRank += 5;
  if (ageMin != null) weaknessRank += Math.min(ageMin, 120) / 12;

  return {
    trade: args.trade,
    score,
    ageMin,
    unrealizedR,
    stale,
    weaknessRank,
  };
}

export function planConservativeReplacement(args: {
  incomingTrade: any;
  openTrades: any[];
  brokerPositionsBySymbol: Map<string, any>;
  openOrdersBySymbol: Map<string, OpenOrderLite[]>;
  nowIso: string;
  marketClosed: boolean;
  staleAfterEt: string;
  eodFlattenEnabled: boolean;
  maxOpenReached: boolean;
  config: ReplacementConfig;
}) : ReplacementDiagnostics {
  const incomingScore = getTradeScore(args.incomingTrade);
  const incomingTicker = up(args.incomingTrade?.ticker);

  if (!args.maxOpenReached) {
    return {
      replacementConsidered: false,
      replacementExecuted: false,
      replacementSkipped: true,
      replacementReason: "capacity_available",
      weakestOpenTradeId: null,
      weakestOpenTicker: null,
      incomingCandidateScore: incomingScore,
      weakestOpenScore: null,
      weakestOpenUnrealizedR: null,
      weakestOpenAgeMin: null,
      replacementThresholdUsed: args.config.thresholdScoreDelta,
    };
  }

  if (!incomingTicker) {
    return {
      replacementConsidered: true,
      replacementExecuted: false,
      replacementSkipped: true,
      replacementReason: "incoming_missing_ticker",
      weakestOpenTradeId: null,
      weakestOpenTicker: null,
      incomingCandidateScore: incomingScore,
      weakestOpenScore: null,
      weakestOpenUnrealizedR: null,
      weakestOpenAgeMin: null,
      replacementThresholdUsed: args.config.thresholdScoreDelta,
    };
  }

  if (incomingScore == null) {
    return {
      replacementConsidered: true,
      replacementExecuted: false,
      replacementSkipped: true,
      replacementReason: "incoming_score_unavailable",
      weakestOpenTradeId: null,
      weakestOpenTicker: null,
      incomingCandidateScore: null,
      weakestOpenScore: null,
      weakestOpenUnrealizedR: null,
      weakestOpenAgeMin: null,
      replacementThresholdUsed: args.config.thresholdScoreDelta,
    };
  }

  const ranked = (Array.isArray(args.openTrades) ? args.openTrades : [])
    .map((trade) => {
      const ticker = up(trade?.ticker);
      return buildReplacementState({
        trade,
        brokerPosition: args.brokerPositionsBySymbol.get(ticker),
        openOrders: args.openOrdersBySymbol.get(ticker) || [],
        nowIso: args.nowIso,
        marketClosed: args.marketClosed,
        staleAfterEt: args.staleAfterEt,
        eodFlattenEnabled: args.eodFlattenEnabled,
      });
    })
    .sort((a, b) => b.weaknessRank - a.weaknessRank);

  const weakest = ranked[0];
  if (!weakest) {
    return {
      replacementConsidered: true,
      replacementExecuted: false,
      replacementSkipped: true,
      replacementReason: "no_open_trades_to_replace",
      weakestOpenTradeId: null,
      weakestOpenTicker: null,
      incomingCandidateScore: incomingScore,
      weakestOpenScore: null,
      weakestOpenUnrealizedR: null,
      weakestOpenAgeMin: null,
      replacementThresholdUsed: args.config.thresholdScoreDelta,
    };
  }

  const weakestTicker = up(weakest.trade?.ticker);
  const weakestScore = weakest.score;
  const scoreDelta = weakestScore == null ? incomingScore : incomingScore - weakestScore;

  let replacementReason = "replacement_execute";
  let execute = true;

  if (weakestTicker === incomingTicker) {
    replacementReason = "same_ticker_already_open";
    execute = false;
  } else if (!weakest.stale.stale && weakest.ageMin != null && weakest.ageMin < args.config.minAgeMin) {
    replacementReason = "weakest_trade_too_fresh";
    execute = false;
  } else if (!weakest.stale.stale && weakest.unrealizedR != null && weakest.unrealizedR > args.config.protectWinnerAboveR) {
    replacementReason = "winner_protected";
    execute = false;
  } else if (!weakest.stale.stale && weakest.unrealizedR == null && !args.config.allowUnknownROverride) {
    replacementReason = "weakest_r_unknown";
    execute = false;
  } else if (!weakest.stale.stale && weakest.unrealizedR != null && weakest.unrealizedR > 0) {
    replacementReason = "open_trade_positive";
    execute = false;
  } else if (scoreDelta < args.config.thresholdScoreDelta && !(weakest.stale.stale && (weakest.unrealizedR ?? -1) < 0)) {
    replacementReason = "score_delta_too_small";
    execute = false;
  }

  return {
    replacementConsidered: true,
    replacementExecuted: execute,
    replacementSkipped: !execute,
    replacementReason,
    weakestOpenTradeId: String(weakest.trade?.id || "") || null,
    weakestOpenTicker: weakestTicker || null,
    incomingCandidateScore: incomingScore,
    weakestOpenScore: weakestScore,
    weakestOpenUnrealizedR: weakest.unrealizedR,
    weakestOpenAgeMin: weakest.ageMin,
    replacementThresholdUsed: args.config.thresholdScoreDelta,
  };
}

export async function lookupBrokerPositionByTicker(ticker: string) {
  if (!ticker) return null;
  try {
    const raw = await getPositions(ticker);
    return Array.isArray(raw)
      ? raw.find((position: any) => up(position?.symbol) === up(ticker)) || null
      : raw;
  } catch {
    return null;
  }
}