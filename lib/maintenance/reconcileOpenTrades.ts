import { alpacaRequest } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { recordReconcile } from "@/lib/maintenance/reconcileTelemetry";

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
    const openTrades = trades
      .filter((t) => (t?.status || "").toUpperCase() === "OPEN")
      .slice(0, max);

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

    const results: any[] = [];

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
            t.status = "ERROR";
            t.autoEntryStatus = "INVALID";
            t.error = "missing_stop_price";
            t.reason = "missing_stop_price";
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

    // Backfill: Create DB trades for broker positions not represented in DB
    let backfilled = 0;
    const backfilledTickers: string[] = [];
    const dbOpenTickerSet = new Set(openTrades.map((t) => up(t?.ticker)).filter(Boolean));

    for (const pos of brokerTruth.positions) {
      checkDeadline();

      const posTicker = up(pos.symbol);
      if (!posTicker || dbOpenTickerSet.has(posTicker)) {
        continue; // Already exists in DB
      }

      // Broker position not in DB, backfill it
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
        newTrade.status = "ERROR";
        newTrade.error = "missing_stop_price";
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

    if (!dryRun && (closed > 0 || synced > 0 || backfilled > 0 || repairedOpenedAt > 0)) {
      await writeTrades(trades);
    }

    console.log(
      `[reconcile] completed (source=${runSource}, id=${runId})`,
      {
        brokerPositions: brokerTruth.positionsCount,
        dbOpenTrades: openTrades.length,
        closed,
        synced,
        backfilled,
        repairedOpenedAt,
      }
    );

    const result = {
      ok: true,
      dryRun,
      checked: openTrades.length,
      closed,
      synced,
      backfilled,
      backfilledTickers,
      repairedOpenedAt,
      broker: {
        positionsCount: brokerTruth.positionsCount,
        openOrdersCount: brokerTruth.openOrdersCount,
        fetchedAt: brokerTruth.fetchedAt,
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
