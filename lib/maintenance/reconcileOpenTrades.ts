import { alpacaRequest, createOrder } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { recordReconcile } from "@/lib/maintenance/reconcileTelemetry";
import { isOperationallyOpenTrade } from "@/lib/trades/operational";
import { selectCanonicalOpenTrades } from "@/lib/trades/canonicalOpenBySymbol";
import { forceFlattenPosition } from "@/lib/broker/forceFlattenPosition";
import { verifyStopAtBroker } from "@/lib/risk/stop-verification";
import { findProtectiveStopOrder } from "@/lib/trades/protection";

const POSITION_OPEN_OVERRIDES_CANCELED_v1 = true;

const up = (v: any) => String(v || "").toUpperCase();
const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const isPos = (v: any) => {
  const n = num(v);
  return n != null && n > 0;
};

async function safeJsonArray(text: string | undefined): Promise<any[]> {
  try {
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function safeJsonObject(text: string | undefined): Promise<any | null> {
  try {
    const parsed = JSON.parse(text || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isTerminalOrderStatus(status: string | null): boolean {
  const s = String(status || "").toLowerCase();
  return Boolean(
    s &&
      [
        "filled",
        "canceled",
        "cancelled",
        "expired",
        "rejected",
        "done_for_day",
        "stopped",
        "calculated",
      ].includes(s)
  );
}

function collectOrderLegIds(order: any): string[] {
  const out = new Set<string>();
  const walk = (node: any) => {
    const id = String(node?.id || "");
    if (id) out.add(id);
    const legs = Array.isArray(node?.legs) ? node.legs : [];
    for (const leg of legs) walk(leg);
  };
  walk(order);
  return Array.from(out);
}

function extractBestFillFromOrder(order: any): { price: number | null; qty: number | null; at: string | null } {
  const fills: Array<{ price: number; qty: number | null; atTs: number; at: string | null }> = [];
  const walk = (node: any) => {
    const status = String(node?.status || "").toLowerCase();
    const px = num(node?.filled_avg_price);
    const q = num(node?.filled_qty);
    const atRaw = String(node?.filled_at || node?.updated_at || node?.submitted_at || "");
    const atTs = Date.parse(atRaw);
    if (status === "filled" && px != null && px > 0) {
      fills.push({
        price: px,
        qty: q != null && q > 0 ? q : null,
        atTs: Number.isFinite(atTs) ? atTs : 0,
        at: atRaw || null,
      });
    }
    const legs = Array.isArray(node?.legs) ? node.legs : [];
    for (const leg of legs) walk(leg);
  };
  walk(order);

  if (fills.length === 0) return { price: null, qty: null, at: null };
  fills.sort((a, b) => b.atTs - a.atTs);
  return {
    price: fills[0].price,
    qty: fills[0].qty,
    at: fills[0].at,
  };
}

async function fetchOrderById(orderId: string): Promise<{ found: boolean; status: number; order: any | null }> {
  try {
    const resp = await alpacaRequest({
      method: "GET",
      path: `/v2/orders/${encodeURIComponent(orderId)}?nested=true`,
    });
    if (!resp.ok) return { found: false, status: resp.status, order: null };
    const obj = await safeJsonObject(resp.text);
    return { found: Boolean(obj), status: resp.status, order: obj };
  } catch {
    return { found: false, status: 0, order: null };
  }
}

async function fetchFillActivitiesByOrderIds(orderIds: string[]): Promise<any[]> {
  const seen = new Set<string>();
  const fills: any[] = [];

  for (const idRaw of orderIds) {
    const id = String(idRaw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const qs = new URLSearchParams();
      qs.set("activity_types", "FILL");
      qs.set("order_id", id);
      qs.set("page_size", "100");
      qs.set("direction", "desc");
      const resp = await alpacaRequest({
        method: "GET",
        path: `/v2/account/activities?${qs.toString()}`,
      });
      if (!resp.ok) continue;
      const arr = await safeJsonArray(resp.text);
      for (const a of arr) {
        fills.push(a);
      }
    } catch {}
  }

  return fills;
}

function extractFillFromActivities(activities: any[]): { price: number | null; qty: number | null; at: string | null } {
  if (!Array.isArray(activities) || activities.length === 0) {
    return { price: null, qty: null, at: null };
  }

  let weightedNotional = 0;
  let weightedQty = 0;
  let latestAt: string | null = null;
  let latestTs = 0;

  for (const a of activities) {
    const px = num(a?.price);
    const q = Math.abs(num(a?.qty) ?? 0);
    const tsRaw = String(a?.transaction_time || a?.date || a?.settle_date || "");
    const ts = Date.parse(tsRaw);
    if (px != null && px > 0 && q > 0) {
      weightedNotional += px * q;
      weightedQty += q;
    }
    if (Number.isFinite(ts) && ts > latestTs) {
      latestTs = ts;
      latestAt = tsRaw;
    }
  }

  if (weightedQty > 0) {
    return {
      price: Number((weightedNotional / weightedQty).toFixed(4)),
      qty: Number(weightedQty.toFixed(6)),
      at: latestAt,
    };
  }

  return { price: null, qty: null, at: latestAt };
}

function computeRealizedFromClose(args: {
  side: string;
  entryPrice: any;
  stopPrice: any;
  closePrice: number | null;
  qty: any;
}): { realizedPnL?: number; realizedR?: number } {
  const side = up(args.side);
  const entry = num(args.entryPrice);
  const stop = num(args.stopPrice);
  const close = num(args.closePrice);
  const qty = Math.abs(num(args.qty) ?? 0);

  if (!(entry != null && entry > 0 && close != null && close > 0 && qty > 0)) {
    return {};
  }

  const pnlPerShare = side === "SHORT" ? entry - close : close - entry;
  const realizedPnL = Number((pnlPerShare * qty).toFixed(2));

  if (!(stop != null && stop > 0)) {
    return { realizedPnL };
  }

  const riskPerShare = Math.abs(entry - stop);
  const riskAmount = riskPerShare * qty;
  if (!(riskAmount > 0)) {
    return { realizedPnL };
  }

  return {
    realizedPnL,
    realizedR: Number((realizedPnL / riskAmount).toFixed(4)),
  };
}

function collectStopBySymbol(order: any, bySymbol: Map<string, number>) {
  const symbol = up(order?.symbol);
  const stop = num(order?.stop_price ?? order?.stopPrice ?? order?.stop_loss?.stop_price);
  const type = String(order?.type || "").toLowerCase();
  const isStopLike = type.includes("stop") || stop != null;

  if (symbol && isStopLike && stop != null && stop > 0 && !bySymbol.has(symbol)) {
    bySymbol.set(symbol, stop);
  }

  const legs = Array.isArray(order?.legs) ? order.legs : [];
  for (const leg of legs) {
    collectStopBySymbol(leg, bySymbol);
  }
}

async function fetchOpenStopBySymbol(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const resp = await alpacaRequest({ method: "GET", path: "/v2/orders?status=open&nested=true&limit=500" });
    if (!resp.ok) return out;
    const parsed = JSON.parse(resp.text || "[]");
    const orders = Array.isArray(parsed) ? parsed : [];
    for (const order of orders) {
      collectStopBySymbol(order, out);
    }
  } catch {}
  return out;
}

export type ReconcileOpenTradesOptions = {
  dryRun?: boolean;
  max?: number;
  closeReason?: string;
  syncToPositionOpen?: boolean;
  runSource?: string;
  runId?: string;
  deadlineMs?: number;
};

export type ReconcileOpenTradesResult = {
  ok: boolean;
  dryRun: boolean;
  checked: number;
  closed: number;
  synced: number;
  backfilled: number;
  backfilledTickers: string[];
  repairedOpenedAt: number;
  cleanedPending: number;
  cleanedPendingIds: string[];
  cleanedPendingTickers: string[];
  cleanedStaleBackfill: number;
  cleanedStaleBackfillIds: string[];
  cleanedDuplicateBackfill: number;
  cleanedDuplicateBackfillIds: string[];
  cleanedDuplicateBackfillTickers: string[];
  openPositions: number;
  protectedPositions: number;
  missingStopCount: number;
  repairedStops: number;
  flattenedUnprotected: number;
  unresolvedCriticalCount: number;
  broker: {
    positionsCount: number;
    openOrdersCount: number;
    fetchedAt: string;
  };
  results: any[];
  error?: string;
  detail?: string;
};

export async function reconcileOpenTrades(
  options: ReconcileOpenTradesOptions = {}
): Promise<ReconcileOpenTradesResult> {
  const {
    dryRun = false,
    max = 500,
    closeReason = "reconciled_not_in_alpaca",
    syncToPositionOpen = true,
    runSource = "unknown",
    runId = "",
    deadlineMs = undefined,
  } = options;

  const startMs = Date.now();
  const checkDeadline = () => {
    if (deadlineMs && Date.now() - startMs > deadlineMs) {
      throw new Error(`reconcile timeout: exceeded ${deadlineMs}ms`);
    }
  };

  try {
    checkDeadline();

    const nowIso = new Date().toISOString();

    // Use broker-truth as authoritative source
    const brokerTruth = await fetchBrokerTruth();

    if (brokerTruth.error) {
      return {
        ok: false,
        dryRun,
        checked: 0,
        closed: 0,
        synced: 0,
        backfilled: 0,
        backfilledTickers: [],
        repairedOpenedAt: 0,
        cleanedPending: 0,
        cleanedPendingIds: [],
        cleanedPendingTickers: [],
        cleanedStaleBackfill: 0,
        cleanedStaleBackfillIds: [],
        cleanedDuplicateBackfill: 0,
        cleanedDuplicateBackfillIds: [],
        cleanedDuplicateBackfillTickers: [],
        openPositions: 0,
        protectedPositions: 0,
        missingStopCount: 0,
        repairedStops: 0,
        flattenedUnprotected: 0,
        unresolvedCriticalCount: 0,
        broker: {
          positionsCount: 0,
          openOrdersCount: 0,
          fetchedAt: new Date().toISOString(),
        },
        results: [],
        error: "broker_truth_failed",
        detail: brokerTruth.error,
      };
    }

    checkDeadline();

    const posBySym = new Map<string, any>();
    for (const p of brokerTruth.positions) {
      const sym = up(p.symbol);
      if (sym) posBySym.set(sym, p);
    }

    const openOrderIdSet = new Set(
      brokerTruth.openOrders.map((o) => String(o.id || "")).filter(Boolean)
    );
    const openOrderSymSet = new Set(
      brokerTruth.openOrders.map((o) => up(o.symbol)).filter(Boolean)
    );
    const openStopBySymbol = await fetchOpenStopBySymbol();

    const trades: any[] = await readTrades();
    // Use the same operational-open definition as countOperationalOpenTickers so
    // reconcile covers exactly the trades that register as "open" in telemetry.
    // Includes: status=OPEN trades AND trades with alpacaStatus/brokerStatus=="position_open"
    // Excludes: ARCHIVED and CLOSED trades.
    const openTrades = trades
      .filter((t) => isOperationallyOpenTrade(t))
      .slice(0, max);

    const results: any[] = [];

    // Cleanup: archive AUTO_PENDING that conflicts with an existing broker position or OPEN trade.
    const conflictingTickerSet = new Set<string>();
    for (const p of brokerTruth.positions) {
      const ticker = up(p?.symbol);
      if (ticker) conflictingTickerSet.add(ticker);
    }
    for (const t of openTrades) {
      const ticker = up(t?.ticker);
      if (ticker) conflictingTickerSet.add(ticker);
    }

    let cleanedPending = 0;
    const cleanedPendingIds: string[] = [];
    const cleanedPendingTickersSet = new Set<string>();
    for (const t of trades) {
      const status = up(t?.status);
      const autoEntryStatus = up(t?.autoEntryStatus);
      const isAutoPending = status === "AUTO_PENDING" || autoEntryStatus === "AUTO_PENDING";
      const ticker = up(t?.ticker);
      if (!isAutoPending || !ticker || !conflictingTickerSet.has(ticker)) continue;

      cleanedPending += 1;
      if (cleanedPendingIds.length < 200) {
        cleanedPendingIds.push(String(t?.id || ""));
      }
      cleanedPendingTickersSet.add(ticker);

      if (!dryRun) {
        t.status = "ARCHIVED";
        t.autoEntryStatus = "AUTO_ARCHIVED";
        t.reason = "conflicting_open_position";
        t.closeReason = "conflicting_open_position";
        t.cancelReason = "conflicting_open_position";
        t.closedAt = t.closedAt || nowIso;
        t.updatedAt = nowIso;
      }

      results.push({
        id: t?.id,
        ticker,
        stale: false,
        action: dryRun ? "would_archive_conflicting_auto_pending" : "archived_conflicting_auto_pending",
        reason: "conflicting_open_position",
      });
    }
    const cleanedPendingTickers = Array.from(cleanedPendingTickersSet);

    // Repair: Ensure all OPEN trades have openedAt set
    let repairedOpenedAt = 0;
    for (const t of openTrades) {
      if (!t.openedAt) {
        const ticker = up(t?.ticker);
        const brokerPos = ticker ? posBySym.get(ticker) : null;
        t.openedAt = brokerPos?.created_at || t.createdAt || nowIso;
        repairedOpenedAt += 1;
      }
    }

    if (repairedOpenedAt > 0 && !dryRun) {
      console.log(
        `[reconcile] repaired openedAt for ${repairedOpenedAt} OPEN trades (source=${runSource}, id=${runId})`
      );
    }

    let closed = 0;
    let synced = 0;

    for (const t of openTrades) {
      checkDeadline();

      const ticker = up(t?.ticker);
      const existsPos = Boolean(ticker && posBySym.has(ticker));

      const alpacaOrderId = String(t?.alpacaOrderId || t?.brokerOrderId || "");
      const existsOrderId = Boolean(alpacaOrderId && openOrderIdSet.has(alpacaOrderId));
      const existsOrderSym = Boolean(ticker && openOrderSymSet.has(ticker));

      const stale = !existsPos && !existsOrderId && !existsOrderSym;

      if (stale) {
        const linkedOrderId = String(t?.alpacaOrderId || t?.brokerOrderId || "").trim();
        const linkedLegIds = [
          String(t?.stopOrderId || "").trim(),
          String(t?.takeProfitOrderId || "").trim(),
        ].filter(Boolean);

        if (linkedOrderId) {
          const orderLookup = await fetchOrderById(linkedOrderId);

          if (orderLookup.found && orderLookup.order) {
            const orderObj = orderLookup.order;
            const orderStatus = String(orderObj?.status || "").toLowerCase() || null;
            const orderLegIds = collectOrderLegIds(orderObj);
            const allOrderIds = Array.from(new Set([linkedOrderId, ...linkedLegIds, ...orderLegIds]));

            if (isTerminalOrderStatus(orderStatus)) {
              let fill = extractBestFillFromOrder(orderObj);
              if (fill.price == null) {
                const acts = await fetchFillActivitiesByOrderIds(allOrderIds);
                const fillFromActs = extractFillFromActivities(acts);
                if (fillFromActs.price != null) {
                  fill = fillFromActs;
                }
              }

              const closePrice = fill.price != null ? Number(fill.price) : num(t?.entryPrice);
              const closeAt = fill.at || nowIso;
              const qtyForCalc =
                fill.qty ??
                num(t?.filledQty) ??
                num(t?.qty) ??
                num(t?.quantity) ??
                num(orderObj?.filled_qty) ??
                0;

              if (!dryRun) {
                t.status = "CLOSED";
                t.autoEntryStatus = "CLOSED";
                t.closedAt = t.closedAt || closeAt;
                t.finalizedAt = nowIso;
                t.updatedAt = nowIso;
                t.alpacaStatus = orderStatus || t.alpacaStatus || "terminal";
                t.brokerStatus = orderStatus || t.brokerStatus || "terminal";
                t.closeReason = t.closeReason || `reconciled_terminal_order:${orderStatus || "unknown"}`;
                if (closePrice != null && closePrice > 0) {
                  t.closePrice = closePrice;
                }
                const realized = computeRealizedFromClose({
                  side: t?.side,
                  entryPrice: t?.entryPrice,
                  stopPrice: t?.stopPrice,
                  closePrice: closePrice ?? null,
                  qty: qtyForCalc,
                });
                if (typeof realized.realizedPnL === "number") t.realizedPnL = realized.realizedPnL;
                if (typeof realized.realizedR === "number") t.realizedR = realized.realizedR;
              }

              closed += 1;
              results.push({
                id: t?.id,
                ticker,
                stale: false,
                action: dryRun ? "would_finalize_from_order" : "finalized_from_order",
                orderId: linkedOrderId,
                orderStatus,
                closePrice,
                closeAt,
                usedActivityFallback: fill.price == null,
              });
              continue;
            }

            if (!dryRun) {
              t.status = "OPEN";
              t.autoEntryStatus = "OPEN";
              t.updatedAt = nowIso;
              t.alpacaStatus = orderStatus || t.alpacaStatus || "order_exists";
              t.brokerStatus = orderStatus || t.brokerStatus || "order_exists";
            }
            synced += 1;
            results.push({
              id: t?.id,
              ticker,
              stale: false,
              action: dryRun ? "would_keep_open_order_exists" : "kept_open_order_exists",
              orderId: linkedOrderId,
              orderStatus,
            });
            continue;
          }

          if (orderLookup.status !== 404) {
            results.push({
              id: t?.id,
              ticker,
              stale: false,
              action: "skip_close_lookup_non_404",
              orderId: linkedOrderId,
              lookupStatus: orderLookup.status,
            });
            continue;
          }

          const fallbackOrderIds = Array.from(new Set([linkedOrderId, ...linkedLegIds]));
          const fallbackActs = await fetchFillActivitiesByOrderIds(fallbackOrderIds);
          const fillFallback = extractFillFromActivities(fallbackActs);

          if (fillFallback.price != null) {
            const closePrice = Number(fillFallback.price);
            const closeAt = fillFallback.at || nowIso;
            const qtyForCalc =
              fillFallback.qty ??
              num(t?.filledQty) ??
              num(t?.qty) ??
              num(t?.quantity) ??
              0;

            if (!dryRun) {
              t.status = "CLOSED";
              t.autoEntryStatus = "CLOSED";
              t.closedAt = t.closedAt || closeAt;
              t.finalizedAt = nowIso;
              t.updatedAt = nowIso;
              t.alpacaStatus = t.alpacaStatus || "filled_activity_only";
              t.brokerStatus = t.brokerStatus || "filled_activity_only";
              t.closeReason = t.closeReason || "reconciled_fill_activity";
              t.closePrice = closePrice;
              const realized = computeRealizedFromClose({
                side: t?.side,
                entryPrice: t?.entryPrice,
                stopPrice: t?.stopPrice,
                closePrice,
                qty: qtyForCalc,
              });
              if (typeof realized.realizedPnL === "number") t.realizedPnL = realized.realizedPnL;
              if (typeof realized.realizedR === "number") t.realizedR = realized.realizedR;
            }

            closed += 1;
            results.push({
              id: t?.id,
              ticker,
              stale: false,
              action: dryRun ? "would_finalize_from_fill_activity" : "finalized_from_fill_activity",
              orderId: linkedOrderId,
              closePrice,
              closeAt,
            });
            continue;
          }
        }

        const debugOrderId = linkedOrderId || "none";
        const debugLegIds = linkedLegIds.length > 0 ? linkedLegIds.join("|") : "none";
        const debugStatus = linkedOrderId ? "404" : "none";
        const closeReasonWithDebug = `${closeReason}:order_lookup_failed(orderId=${debugOrderId},legIds=${debugLegIds},http=${debugStatus})`;

        if (!dryRun) {
          t.status = "CLOSED";
          t.closedAt = t.closedAt || nowIso;
          t.updatedAt = nowIso;
          t.closeReason = closeReasonWithDebug;
          t.autoEntryStatus = "CLOSED";
          t.alpacaStatus = t.alpacaStatus || "not_found_in_broker";
          t.brokerStatus = t.brokerStatus || "not_found_in_broker";
        }
        closed += 1;
        results.push({
          id: t?.id,
          ticker,
          stale: true,
          action: dryRun ? "would_close" : "closed",
          reason: "not_in_broker_positions_or_orders",
          closeReason: closeReasonWithDebug,
        });
        console.log(
          `[reconcile] closing stale trade (source=${runSource}, id=${runId})`,
          { tradeId: t?.id, ticker, alpacaOrderId: linkedOrderId, legIds: linkedLegIds, lookupStatus: debugStatus }
        );
        continue;
      }

      if (syncToPositionOpen && existsPos) {
        const brokerPos = posBySym.get(ticker);
        let orderStatus: string | null = null;

        if (alpacaOrderId) {
          try {
            const r = await alpacaRequest({
              method: "GET",
              path: `/v2/orders/${encodeURIComponent(alpacaOrderId)}`,
            });
            const obj = await safeJsonObject(r.text);
            const s = obj?.status ? String(obj.status) : null;
            if (s) orderStatus = s;

            if (existsPos && orderStatus) {
              const os = String(orderStatus).toLowerCase();
              if (os === "canceled" || os === "expired" || os === "rejected") {
                orderStatus = "position_open";
              }
            }

            if (
              !dryRun &&
              obj &&
              (typeof obj.filled_qty === "string" || typeof obj.filled_qty === "number")
            ) {
              const fq = Number(obj.filled_qty);
              if (Number.isFinite(fq) && fq > 0) t.filledQty = fq;
            }
            if (
              !dryRun &&
              obj &&
              (typeof obj.filled_avg_price === "string" ||
                typeof obj.filled_avg_price === "number")
            ) {
              const ap = Number(obj.filled_avg_price);
              if (Number.isFinite(ap) && ap > 0) t.avgFillPrice = ap;
            }
          } catch (err) {
            console.warn(
              `[reconcile] order lookup failed (source=${runSource})`,
              { alpacaOrderId, error: String(err) }
            );
          }
        }

        if (!dryRun) {
          // Broker truth wins: enforce OPEN status when position exists
          t.status = "OPEN";
          t.autoEntryStatus = "OPEN";
          t.alpacaStatus = orderStatus || "position_open";
          t.brokerStatus = orderStatus || "position_open";
          t.updatedAt = nowIso;

          // Ensure openedAt is set (use existing or broker position time or now)
          if (!t.openedAt) {
            const brokerPos = posBySym.get(up(t?.ticker));
            t.openedAt = brokerPos?.created_at || nowIso;
          }

          // Clear closure/error fields that may have been artifact of previous status
          delete t.closedAt;
          delete t.finalizedAt;
          delete t.closeReason;
          delete t.error;
          delete t.realizedPnL;
          delete t?.realizedR;

          // Ensure filledQty/avgFillPrice are set from broker or estimate
          if (
            (t.filledQty == null || !Number.isFinite(Number(t.filledQty))) &&
            Number.isFinite(Number(t.qty))
          ) {
            t.filledQty = Number(t.qty);
          }

          if (
            (t.avgFillPrice == null || !Number.isFinite(Number(t.avgFillPrice))) &&
            Number.isFinite(Number(t.entryPrice))
          ) {
            t.avgFillPrice = Number(t.entryPrice);
          }

          if (!isPos(t.entryPrice)) {
            const brokerEntry = num((brokerPos as any)?.avg_entry_price);
            if (brokerEntry != null && brokerEntry > 0) {
              t.entryPrice = brokerEntry;
              if (!isPos(t.avgFillPrice)) t.avgFillPrice = brokerEntry;
            }
          }

          if (!isPos(t.stopPrice)) {
            const stopFromOrder = openStopBySymbol.get(ticker);
            if (stopFromOrder != null && stopFromOrder > 0) {
              t.stopPrice = stopFromOrder;
            }
          }

          if (!isPos(t.stopPrice)) {
            t.autoEntryStatus = "INVALID";
            t.reason = t.reason || "missing_stop_price";
          }
        }

        synced += 1;
        results.push({
          id: t?.id,
          ticker,
          stale: false,
          existsPos: true,
          existsOrderId,
          existsOrderSym,
          sync: dryRun ? "would_sync" : "synced",
          orderStatus: orderStatus || null,
          hydratedEntry: !isPos(t?.entryPrice) ? false : undefined,
          hydratedStop: !isPos(t?.stopPrice) ? false : undefined,
          invalidReason: !isPos(t?.stopPrice) ? "missing_stop_price" : undefined,
        });
        continue;
      }

      results.push({
        id: t?.id,
        ticker,
        stale: false,
        existsPos,
        existsOrderId,
        existsOrderSym,
      });
    }

    checkDeadline();

    // Clean stale broker_backfill rows before backfill
    let cleanedStaleBackfill = 0;
    const cleanedStaleBackfillIds: string[] = [];
    const activeBrokerTickers = new Set(brokerTruth.positions.map((p) => up(p.symbol)).filter(Boolean));

    for (const t of trades) {
      if (t?.source === "broker_backfill" && t?.ticker) {
        const ticker = up(t.ticker);
        // If broker_backfill row exists for ticker NOT in live broker positions, it's stale
        if (ticker && !activeBrokerTickers.has(ticker) && t?.status !== "ARCHIVED" && t?.status !== "CLOSED") {
          if (!dryRun) {
            Object.assign(t, {
              status: "ARCHIVED",
              closedAt: nowIso,
              updatedAt: nowIso,
              closeReason: "stale_broker_backfill",
              alpacaStatus: null,
              brokerStatus: null,
              note: (t?.note || "") + " [Archived: stale broker_backfill position closed at broker]",
            });
          }
          cleanedStaleBackfill += 1;
          if (cleanedStaleBackfillIds.length < 10) {
            cleanedStaleBackfillIds.push(t.id);
          }
          console.log(
            `[reconcile] archived stale broker_backfill (source=${runSource}, id=${runId})`,
            { ticker, tradeId: t.id, reason: "stale_broker_backfill", dryRun }
          );
        }
      }
    }

    checkDeadline();

    // Pre-build canonical AUTO OPEN tickers set — prevents creating ghost broker_backfill duplicates
    // when an executed AUTO trade already owns the broker position.
    const autoOpenTickers = new Set<string>();
    for (const t of trades) {
      if (t?.status === "OPEN" && (t?.source === "AUTO" || t?.source === "AUTO-ENTRY")) {
        const ticker = up(t.ticker);
        if (ticker) autoOpenTickers.add(ticker);
      }
    }

    // Duplicate-cleanup counters declared here so both the backfill loop and post-loop
    // safety-net pass can use them without re-declaration.
    let cleanedDuplicateBackfill = 0;
    const cleanedDuplicateBackfillIds: string[] = [];
    const cleanedDuplicateBackfillTickers: string[] = [];

    // Backfill: Create or reuse DB trades for broker positions
    let backfilled = 0;
    const backfilledTickers: string[] = [];

    for (const pos of brokerTruth.positions) {
      checkDeadline();

      const posTicker = up(pos.symbol);
      if (!posTicker) continue;

      // Find ALL broker_backfill rows for this ticker (not just first)
      const allBackfillsForTicker = trades.filter(
        (t) => t?.source === "broker_backfill" && up(t?.ticker) === posTicker
      );

      if (allBackfillsForTicker.length > 0) {
        // If a canonical AUTO OPEN trade already owns this position, archive all backfills immediately.
        if (autoOpenTickers.has(posTicker)) {
          for (const bf of allBackfillsForTicker) {
            if (bf.status === "ARCHIVED" || bf.status === "CLOSED") continue;
            if (!dryRun) {
              Object.assign(bf, {
                status: "ARCHIVED",
                closedAt: nowIso,
                updatedAt: nowIso,
                closeReason: "duplicate_broker_backfill",
                alpacaStatus: null,
                brokerStatus: null,
                note: (bf?.note || "") + " [Archived: canonical AUTO OPEN trade owns this position]",
              });
            }
            cleanedDuplicateBackfill += 1;
            if (cleanedDuplicateBackfillIds.length < 10) cleanedDuplicateBackfillIds.push(bf.id);
            if (!cleanedDuplicateBackfillTickers.includes(posTicker) && cleanedDuplicateBackfillTickers.length < 10) {
              cleanedDuplicateBackfillTickers.push(posTicker);
            }
            console.log(
              `[reconcile] archived existing broker_backfill — canonical AUTO owns position (source=${runSource}, id=${runId})`,
              { ticker: posTicker, tradeId: bf.id, dryRun }
            );
          }
          continue; // canonical AUTO is authoritative — skip backfill reuse/creation
        }

        // Pick the best one to keep: prefer OPEN, then newest by updatedAt
        const toKeep = allBackfillsForTicker.sort((a, b) => {
          if (a.status === "OPEN" && b.status !== "OPEN") return -1;
          if (b.status === "OPEN" && a.status !== "OPEN") return 1;
          return (b.updatedAt || "").localeCompare(a.updatedAt || "");
        })[0];

        // Archive all duplicates
        for (const dup of allBackfillsForTicker) {
          if (dup.id === toKeep.id) continue;
          if (dup.status === "ARCHIVED" || dup.status === "CLOSED") continue;

          if (!dryRun) {
            Object.assign(dup, {
              status: "ARCHIVED",
              closedAt: nowIso,
              updatedAt: nowIso,
              closeReason: "duplicate_broker_backfill",
              alpacaStatus: null,
              brokerStatus: null,
              note: (dup?.note || "") + " [Archived: duplicate broker_backfill superseded]",
            });
          }
          cleanedStaleBackfill += 1;
          if (cleanedStaleBackfillIds.length < 10) {
            cleanedStaleBackfillIds.push(dup.id);
          }
          console.log(
            `[reconcile] archived duplicate broker_backfill (source=${runSource}, id=${runId})`,
            { ticker: posTicker, tradeId: dup.id, reason: "duplicate_broker_backfill", dryRun }
          );
        }

        // Reuse the kept broker_backfill row, sync it to current broker state
        if (toKeep.status !== "OPEN") {
          // Re-open if it was closed/archived
          if (!dryRun) {
            Object.assign(toKeep, {
              status: "OPEN",
              closedAt: null,
              closeReason: null,
              updatedAt: nowIso,
              note: (toKeep?.note || "") + " [Reopened: broker position active again]",
            });
          }
          console.log(
            `[reconcile] reopened existing broker_backfill (source=${runSource}, id=${runId})`,
            { ticker: posTicker, tradeId: toKeep.id, dryRun }
          );
        }

        // Sync position data
        if (!dryRun) {
          Object.assign(toKeep, {
            qty: Math.abs(Number(pos.qty || 0)),
            side: (Number(pos.qty) > 0 ? "LONG" : "SHORT") as "LONG" | "SHORT",
            entryPrice: Number(pos.avg_entry_price || 0),
            avgFillPrice: Number(pos.avg_entry_price || 0),
            filledQty: Math.abs(Number(pos.qty || 0)),
            stopPrice: openStopBySymbol.get(posTicker) ?? toKeep.stopPrice,
            autoEntryStatus: isPos(toKeep.stopPrice || openStopBySymbol.get(posTicker)) ? "OPEN" : "INVALID",
            alpacaStatus: "position_open",
            brokerStatus: "position_open",
            updatedAt: nowIso,
          });
        }
        continue; // Reused existing, no new backfill
      }

      // Skip creation when a canonical AUTO OPEN trade already covers this broker position.
      if (autoOpenTickers.has(posTicker)) {
        console.log(
          `[reconcile] skipping backfill for ${posTicker}: canonical AUTO OPEN trade already exists (source=${runSource}, id=${runId})`
        );
        continue;
      }

      // No existing broker_backfill row, create new one
      const newTrade: any = {
        id: crypto.randomUUID(),
        ticker: posTicker,
        side: (Number(pos.qty) > 0 ? "LONG" : "SHORT") as "LONG" | "SHORT",
        qty: Math.abs(Number(pos.qty || 0)),
        status: "OPEN",
        source: "broker_backfill",
        paper: true,
        note: "Backfilled from broker position during reconcile-open-trades",
        createdAt: pos.created_at || nowIso,
        openedAt: pos.created_at || nowIso,
        updatedAt: nowIso,
        entryPrice: Number(pos.avg_entry_price || 0),
        stopPrice: openStopBySymbol.get(posTicker) ?? null,
        filledQty: Math.abs(Number(pos.qty || 0)),
        avgFillPrice: Number(pos.avg_entry_price || 0),
        autoEntryStatus: isPos(openStopBySymbol.get(posTicker)) ? "OPEN" : "INVALID",
        alpacaStatus: "position_open",
        brokerStatus: "position_open",
      };

      if (!isPos(newTrade.stopPrice)) {
        newTrade.autoEntryStatus = "INVALID";
        newTrade.reason = "missing_stop_price";
      }

      if (!dryRun) {
        trades.push(newTrade);
      }

      backfilled += 1;
      if (backfilledTickers.length < 10) {
        backfilledTickers.push(posTicker);
      }

      console.log(
        `[reconcile] backfilling broker position to DB (source=${runSource}, id=${runId})`,
        { ticker: posTicker, qty: newTrade.qty, side: newTrade.side, dryRun }
      );
    }

    checkDeadline();

    // Safety-net pass: archive any remaining OPEN broker_backfill rows for tickers that have AUTO trades.
    // autoOpenTickers, cleanedDuplicateBackfill, cleanedDuplicateBackfillIds, cleanedDuplicateBackfillTickers
    // are all pre-declared above the backfill loop.
    for (const t of trades) {
      if (t?.source === "broker_backfill" && t?.status === "OPEN" && t?.ticker) {
        const ticker = up(t.ticker);
        if (ticker && autoOpenTickers.has(ticker)) {
          // AUTO trade exists, archive this duplicate broker_backfill
          if (!dryRun) {
            Object.assign(t, {
              status: "ARCHIVED",
              closedAt: nowIso,
              updatedAt: nowIso,
              closeReason: "duplicate_broker_backfill",
              alpacaStatus: null,
              brokerStatus: null,
              note: (t?.note || "") + " [Archived: duplicate broker_backfill when AUTO trade exists]",
            });
          }
          cleanedDuplicateBackfill += 1;
          if (cleanedDuplicateBackfillIds.length < 10) {
            cleanedDuplicateBackfillIds.push(t.id);
          }
          if (!cleanedDuplicateBackfillTickers.includes(ticker) && cleanedDuplicateBackfillTickers.length < 10) {
            cleanedDuplicateBackfillTickers.push(ticker);
          }
          console.log(
            `[reconcile] archived duplicate OPEN broker_backfill (source=${runSource}, id=${runId})`,
            { ticker, tradeId: t.id, reason: "AUTO trade exists", dryRun }
          );
        }
      }
    }

    checkDeadline();

    // ── All-source ghost duplicate pass ──────────────────────────────────────
    // The prior safety-net pass only targets broker_backfill sources.
    // This broader pass handles any combination of sources (AUTO vs manual,
    // broker_backfill vs AUTO-ENTRY, etc.) using the richness-based canonical
    // selector so we never block on ghost duplicates that lack protection metadata.
    const { ghosts: allSourceGhosts, diagnostics: ghostDiag } = selectCanonicalOpenTrades(trades);

    let cleanedAllSourceGhosts = 0;
    const cleanedAllSourceGhostIds: string[] = [];

    for (const ghost of allSourceGhosts) {
      // Skip trades already archived by earlier passes
      if (!isOperationallyOpenTrade(ghost)) continue;

      const ticker = String(ghost?.symbol ?? ghost?.ticker ?? "").toUpperCase();
      const canonicalId = (ghost as any)._canonicalId;

      if (!dryRun) {
        Object.assign(ghost, {
          status: "ARCHIVED",
          closedAt: nowIso,
          updatedAt: nowIso,
          closeReason: "superseded_by_canonical_open_trade",
          duplicateOfTradeId: canonicalId,
          alpacaStatus: null,
          brokerStatus: null,
          note: (ghost?.note || "") +
            ` [Archived: superseded by canonical OPEN trade ${canonicalId}]`,
        });
      }

      cleanedAllSourceGhosts += 1;
      if (cleanedAllSourceGhostIds.length < 20) cleanedAllSourceGhostIds.push(String(ghost.id));

      console.log(
        `[reconcile] archived ghost duplicate OPEN trade — all-source pass (source=${runSource}, id=${runId})`,
        {
          ticker,
          tradeId: ghost.id,
          tradeSource: ghost?.source,
          canonicalId,
          dryRun,
        }
      );
    }

    if (ghostDiag.length > 0) {
      console.log(
        `[reconcile] all-source ghost dedup complete (source=${runSource}, id=${runId})`,
        {
          groups: ghostDiag.map((d) => ({
            ticker: d.ticker,
            canonical: d.canonicalId,
            source: d.canonicalSource,
            richness: d.canonicalRichness,
            ghosts: d.ghostCount,
            ghostIds: d.ghostIds,
          })),
          totalArchivedNow: cleanedAllSourceGhosts,
        }
      );
    }

    // Merge count into cleanedDuplicateBackfill for reporting (backward-compat)
    cleanedDuplicateBackfill += cleanedAllSourceGhosts;
    if (cleanedAllSourceGhostIds.length > 0) {
      cleanedDuplicateBackfillIds.push(...cleanedAllSourceGhostIds.slice(0, Math.max(0, 10 - cleanedDuplicateBackfillIds.length)));
    }
    // ── end all-source ghost pass ─────────────────────────────────────────────

    // ── Broker protection enforcement pass ───────────────────────────────────
    const ACTIVE_ORDER_STATUSES = new Set([
      "new",
      "accepted",
      "pending_new",
      "pending_replace",
      "held",
      "partially_filled",
      "accepted_for_bidding",
    ]);

    const closeSideFromPos = (pos: any): "buy" | "sell" => {
      const rawQty = Number(pos?.qty ?? 0);
      const side = String(pos?.side || "").toLowerCase();
      if (side === "short" || rawQty < 0) return "buy";
      return "sell";
    };

    const hasActiveTakeProfit = (symbol: string, closeSide: "buy" | "sell", orders: any[]) =>
      orders.some((o: any) => {
        if (up(o?.symbol) !== symbol) return false;
        if (String(o?.side || "").toLowerCase() !== closeSide) return false;
        const type = String(o?.type || "").toLowerCase();
        const status = String(o?.status || "").toLowerCase();
        if (!ACTIVE_ORDER_STATUSES.has(status)) return false;
        return type === "limit";
      });

    const pickLinkedOpenTrade = (symbol: string): any | null => {
      const candidates = trades.filter(
        (t) => isOperationallyOpenTrade(t) && up(t?.ticker ?? t?.symbol) === symbol
      );
      if (candidates.length === 0) return null;
      return candidates
        .map((t) => ({
          trade: t,
          richness:
            (t?.source === "AUTO" || t?.source === "AUTO-ENTRY" ? 8 : 0) +
            (t?.signalId ? 4 : 0) +
            (t?.stopOrderId ? 2 : 0) +
            (t?.takeProfitOrderId ? 1 : 0),
        }))
        .sort((a, b) => b.richness - a.richness)[0]?.trade;
    };

    const emergencyStopPrice = (entry: number, closeSide: "buy" | "sell") =>
      Number((closeSide === "sell" ? entry * 0.98 : entry * 1.02).toFixed(2));

    let repairedStops = 0;
    let flattenedUnprotected = 0;
    let unresolvedCriticalCount = 0;

    const repairAttemptedAt = new Date().toISOString();
    const workingOrders = Array.isArray(brokerTruth.openOrders) ? [...brokerTruth.openOrders] : [];

    for (const pos of brokerTruth.positions) {
      checkDeadline();

      const symbol = up(pos?.symbol);
      const brokerQty = Math.abs(Number(pos?.qty ?? 0));
      if (!symbol || !(brokerQty > 0)) continue;

      let linkedTrade = pickLinkedOpenTrade(symbol);
      if (!linkedTrade && !dryRun) {
        linkedTrade = {
          id: crypto.randomUUID(),
          ticker: symbol,
          side: Number(pos?.qty ?? 0) < 0 ? "SHORT" : "LONG",
          qty: brokerQty,
          status: "OPEN",
          source: "broker_backfill",
          paper: true,
          note: "Backfilled from broker truth during stop-protection reconcile",
          createdAt: pos?.created_at || nowIso,
          openedAt: pos?.created_at || nowIso,
          updatedAt: nowIso,
          entryPrice: Number(pos?.avg_entry_price || 0),
          avgFillPrice: Number(pos?.avg_entry_price || 0),
          filledQty: brokerQty,
          stopPrice: null,
          autoEntryStatus: "INVALID",
          alpacaStatus: "position_open",
          brokerStatus: "position_open",
          protectionStatus: "MISSING_STOP",
          protectionRepairReason: "broker_position_without_app_trade",
        };
        trades.push(linkedTrade);
        backfilled += 1;
        if (backfilledTickers.length < 10) backfilledTickers.push(symbol);
      }

      const closeSide = closeSideFromPos(pos);
      const tradeSide: "LONG" | "SHORT" = closeSide === "sell" ? "LONG" : "SHORT";
      const symbolOrders = workingOrders.filter((o: any) => up(o?.symbol) === symbol);
      const activeStop = findProtectiveStopOrder({
        ticker: symbol,
        tradeSide,
        openOrders: symbolOrders,
      });
      const tpOnly = !activeStop && hasActiveTakeProfit(symbol, closeSide, symbolOrders);

      if (activeStop) {
        if (!dryRun && linkedTrade) {
          linkedTrade.stopOrderId = linkedTrade.stopOrderId || activeStop.id;
          linkedTrade.protectionStatus = "VERIFIED";
          linkedTrade.protectionRepairOutcome = "already_protected";
          linkedTrade.protectionRepairReason = tpOnly
            ? "tp_only_resolved_by_broker_scan"
            : "active_stop_detected";
          linkedTrade.updatedAt = nowIso;
        }
        continue;
      }

      if (!dryRun && linkedTrade) {
        linkedTrade.protectionStatus = "MISSING_STOP";
        linkedTrade.protectionRepairAttemptedAt = repairAttemptedAt;
        linkedTrade.protectionRepairOutcome = "repair_attempting";
        linkedTrade.protectionRepairReason = tpOnly
          ? "tp_only_bracket_state"
          : "no_active_stop_at_broker";
        linkedTrade.updatedAt = nowIso;
      }

      const entryPrice = Number(pos?.avg_entry_price ?? linkedTrade?.entryPrice ?? 0);
      const stopPrice = entryPrice > 0 ? emergencyStopPrice(entryPrice, closeSide) : 0;

      let repairOk = false;
      let repairOrderId: string | null = null;
      let repairFailureReason = "repair_not_attempted";

      if (!dryRun && stopPrice > 0) {
        try {
          const created = await createOrder({
            symbol,
            qty: String(brokerQty),
            side: closeSide,
            type: "stop",
            stop_price: String(stopPrice),
            time_in_force: "gtc",
          });
          repairOrderId = String((created as any)?.id || "") || null;
          if (repairOrderId) {
            const verify = await verifyStopAtBroker({
              symbol,
              side: tradeSide,
              stopOrderId: repairOrderId,
            });
            if (verify.verified) {
              repairOk = true;
              repairedStops += 1;
              workingOrders.push({
                id: verify.stopOrderId || repairOrderId,
                symbol,
                side: closeSide,
                type: "stop",
                status: "new",
                stop_price: stopPrice,
              });
            } else {
              repairFailureReason = verify.reason || verify.detail || "stop_not_verified";
            }
          } else {
            repairFailureReason = "stop_order_missing_id";
          }
        } catch (err: any) {
          repairFailureReason = String(err?.message || err || "stop_repair_failed");
        }
      } else if (dryRun) {
        repairFailureReason = "dry_run";
      } else {
        repairFailureReason = "missing_entry_price";
      }

      if (repairOk) {
        if (!dryRun && linkedTrade) {
          linkedTrade.stopOrderId = repairOrderId;
          linkedTrade.stopPrice = stopPrice;
          linkedTrade.protectionStatus = "VERIFIED";
          linkedTrade.protectionRepairOutcome = "repaired_stop";
          linkedTrade.protectionRepairReason = "stop_repair_success";
          linkedTrade.flattenReason = null;
          linkedTrade.updatedAt = nowIso;
        }
        continue;
      }

      if (dryRun) {
        unresolvedCriticalCount += 1;
        continue;
      }

      const flat = await forceFlattenPosition(symbol);
      if (flat.ok) {
        flattenedUnprotected += 1;
        if (linkedTrade) {
          linkedTrade.status = "ERROR";
          linkedTrade.autoEntryStatus = "AUTO_ERROR";
          linkedTrade.closeReason = linkedTrade.closeReason || "flattened_unprotected_position";
          linkedTrade.flattenReason = `repair_failed:${repairFailureReason}`;
          linkedTrade.closedAt = linkedTrade.closedAt || nowIso;
          linkedTrade.protectionStatus = "FLATTENED_UNPROTECTED";
          linkedTrade.protectionRepairOutcome = "flattened_after_repair_failure";
          linkedTrade.protectionRepairReason = repairFailureReason;
          linkedTrade.updatedAt = nowIso;
        }
      } else {
        unresolvedCriticalCount += 1;
        if (linkedTrade) {
          linkedTrade.protectionStatus = "FLATTEN_FAILED";
          linkedTrade.protectionRepairOutcome = "flatten_failed_after_repair_failure";
          linkedTrade.protectionRepairReason = `${repairFailureReason};${flat.error || flat.step}`;
          linkedTrade.flattenReason = `${flat.step}:${flat.error || "unknown"}`;
          linkedTrade.updatedAt = nowIso;
        }
      }
    }

    const shouldPersistProtectionPass =
      repairedStops > 0 || flattenedUnprotected > 0 || unresolvedCriticalCount > 0;

    if (!dryRun && (closed > 0 || synced > 0 || backfilled > 0 || repairedOpenedAt > 0 || cleanedPending > 0 || cleanedStaleBackfill > 0 || cleanedDuplicateBackfill > 0 || shouldPersistProtectionPass)) {
      await writeTrades(trades);
    }

    const finalBrokerTruth = dryRun ? brokerTruth : await fetchBrokerTruth();
    const finalPositions = Array.isArray(finalBrokerTruth.positions) ? finalBrokerTruth.positions : [];
    const finalOrders = Array.isArray(finalBrokerTruth.openOrders) ? finalBrokerTruth.openOrders : [];

    let openPositions = 0;
    let protectedPositions = 0;
    for (const pos of finalPositions) {
      const symbol = up(pos?.symbol);
      const brokerQty = Math.abs(Number(pos?.qty ?? 0));
      if (!symbol || !(brokerQty > 0)) continue;
      openPositions += 1;
      const closeSide = closeSideFromPos(pos);
      const tradeSide: "LONG" | "SHORT" = closeSide === "sell" ? "LONG" : "SHORT";
      const symbolOrders = finalOrders.filter((o: any) => up(o?.symbol) === symbol);
      const activeStop = findProtectiveStopOrder({ ticker: symbol, tradeSide, openOrders: symbolOrders });
      if (activeStop) protectedPositions += 1;
    }
    const missingStopCount = Math.max(0, openPositions - protectedPositions);
    unresolvedCriticalCount += missingStopCount;

    console.log(
      `[reconcile] completed (source=${runSource}, id=${runId})`,
      {
        brokerPositions: brokerTruth.positionsCount,
        dbOpenTrades: openTrades.length,
        closed,
        synced,
        backfilled,
        repairedOpenedAt,
        cleanedPending,
        cleanedStaleBackfill,
        cleanedDuplicateBackfill,
      }
    );

    const result: ReconcileOpenTradesResult = {
      ok: true,
      dryRun,
      checked: openTrades.length,
      closed,
      synced,
      backfilled,
      backfilledTickers,
      repairedOpenedAt,
      cleanedPending,
      cleanedPendingIds,
      cleanedPendingTickers,
      cleanedStaleBackfill,
      cleanedStaleBackfillIds,
      cleanedDuplicateBackfill,
      cleanedDuplicateBackfillIds,
      cleanedDuplicateBackfillTickers,
      openPositions,
      protectedPositions,
      missingStopCount,
      repairedStops,
      flattenedUnprotected,
      unresolvedCriticalCount,
      broker: {
        positionsCount: finalBrokerTruth.positionsCount,
        openOrdersCount: finalBrokerTruth.openOrdersCount,
        fetchedAt: finalBrokerTruth.fetchedAt,
      },
      results,
    };

    // Record telemetry (non-fatal if it fails)
    try {
      await recordReconcile({
        ts: new Date().toISOString(),
        source: runSource,
        runId: runId,
        checked: openTrades.length,
        closed,
        synced,
        ok: true,
      });
    } catch (e) {
      console.warn("[reconcile] telemetry recording failed:", e);
    }

    return result;
  } catch (err: any) {
    console.error(`[reconcile] failed (source=${runSource}, id=${runId})`, err);

    // Record failure telemetry (non-fatal if it fails)
    try {
      await recordReconcile({
        ts: new Date().toISOString(),
        source: runSource,
        runId: runId,
        checked: 0,
        closed: 0,
        synced: 0,
        ok: false,
      });
    } catch (e) {
      console.warn("[reconcile] telemetry recording failed:", e);
    }

    return {
      ok: false,
      dryRun,
      checked: 0,
      closed: 0,
      synced: 0,
      backfilled: 0,
      backfilledTickers: [],
      repairedOpenedAt: 0,
      cleanedPending: 0,
      cleanedPendingIds: [],
      cleanedPendingTickers: [],
      cleanedStaleBackfill: 0,
      cleanedStaleBackfillIds: [],
      cleanedDuplicateBackfill: 0,
      cleanedDuplicateBackfillIds: [],
      cleanedDuplicateBackfillTickers: [],
      openPositions: 0,
      protectedPositions: 0,
      missingStopCount: 0,
      repairedStops: 0,
      flattenedUnprotected: 0,
      unresolvedCriticalCount: 0,
      broker: {
        positionsCount: 0,
        openOrdersCount: 0,
        fetchedAt: new Date().toISOString(),
      },
      results: [],
      error: "reconcile_failed",
      detail: err?.message || String(err),
    };
  }
}
