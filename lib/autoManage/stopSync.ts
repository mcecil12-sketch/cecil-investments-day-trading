import { alpacaRequest, createOrder, getOrder, getPositions } from "@/lib/alpaca";
import { normalizeStopPrice, tickForEquityPrice } from "@/lib/tickSize";

type Side = "LONG" | "SHORT";

type TradeLike = {
  id: string;
  ticker: string;
  side: Side | string;
  quantity?: number;
  qty?: number;
  size?: number;
  positionSize?: number;
  shares?: number;
  brokerRaw?: any;
  alpacaOrderId?: string | null;
  brokerOrderId?: string | null;
  stopOrderId?: string | null;
  stopPrice?: number;
};

export type StopSyncResult =
  | { ok: true; qty: number; stopOrderId: string; cancelled: string[]; quantizationNote?: string }
  | { ok: false; error: string; detail?: string; quantizationNote?: string };

const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function normalizeTicker(t: any) {
  return typeof t === "string" ? t.toUpperCase() : String(t || "").toUpperCase();
}

function normalizeSide(s: any): Side | null {
  const up = String(s || "").toUpperCase();
  if (up === "LONG" || up === "SHORT") return up as Side;
  return null;
}

function isTightening(side: Side, currentStop: number, nextStop: number) {
  if (side === "LONG") return nextStop > currentStop;
  return nextStop < currentStop;
}

async function cancelOrderId(orderId: string) {
  const resp = await alpacaRequest({ method: "DELETE", path: `/v2/orders/${encodeURIComponent(orderId)}` });
  return resp.ok || resp.status === 404;
}

/**
 * Check if a stop order is active in Alpaca.
 * Returns true if order exists and status is "pending" or "accepted".
 * Returns false if not found, canceled, expired, filled, or in error state.
 */
async function isStopOrderActive(orderId: string): Promise<boolean> {
  if (!orderId) return false;
  try {
    const order = await getOrder(orderId);
    const status = String((order as any)?.status || "").toLowerCase();
    // Active states: pending, accepted, held
    return status === "pending" || status === "accepted" || status === "held";
  } catch (err) {
    // Order not found or error fetching
    return false;
  }
}

export type StopRescueResult =
  | { ok: true; stopOrderId: string; reason: string }
  | { ok: false; error: string; detail?: string };

/**
 * Rescue stop: create a standalone GTC stop order when trade is OPEN and broker position exists
 * but there's no active protective stop (missing, canceled, expired, or filled).
 *
 * Requirements:
 * - Do NOT cancel or replace anything
 * - Only persist stopOrderId after Alpaca confirms acceptance
 * - Minimally invasive: add as a guard, not a refactor
 */
export async function rescueStop(trade: TradeLike): Promise<StopRescueResult> {
  const ticker = normalizeTicker(trade.ticker);
  const side = normalizeSide(trade.side);
  const stopPrice = num(trade.stopPrice);

  if (!ticker || !side) return { ok: false, error: "invalid_trade_ticker_or_side" };
  if (stopPrice == null) return { ok: false, error: "missing_stopPrice" };

  let qty = Number(trade.quantity ?? trade.qty ?? trade.size ?? trade.positionSize ?? trade.shares) || 0;

  if (!qty || qty <= 0) {
    try {
      const positions = await getPositions(ticker);
      const normalized = Array.isArray(positions)
        ? positions.find((p) => p?.symbol?.toUpperCase() === ticker)
        : positions;
      qty = Number((normalized as any)?.qty ?? 0);
    } catch (err) {
      return { ok: false, error: "unable_to_determine_qty", detail: String(err) };
    }
  }

  if (!qty || qty <= 0) {
    return { ok: false, error: "no_open_position" };
  }

  const stopSide = side === "SHORT" ? "buy" : "sell";

  try {
    // Normalize stop price to ensure tick compliance
    const entryPrice = stopPrice; // Use stop price as reference for tick sizing
    const tick = tickForEquityPrice(entryPrice);
    const normResult = normalizeStopPrice({
      side,
      entryPrice,
      stopPrice,
      tick,
    });

    if (!normResult.ok) {
      return {
        ok: false,
        error: "stop_normalization_failed",
        detail: `reason=${normResult.reason} original=${stopPrice} normalized=${normResult.stop || "N/A"}`,
      };
    }

    // Create standalone GTC stop order
    const stopOrder = await createOrder({
      symbol: ticker,
      qty,
      side: stopSide,
      type: "stop",
      time_in_force: "gtc", // GTC: good-til-canceled
      stop_price: normResult.stop,
      extended_hours: false,
    });

    const stopOrderId = String((stopOrder as any)?.id || "");
    if (!stopOrderId) {
      return { ok: false, error: "stop_order_missing_id" };
    }

    return {
      ok: true,
      stopOrderId,
      reason: "standalone_gtc_stop_created",
    };
  } catch (err: any) {
    return { ok: false, error: "stop_rescue_error", detail: err?.message ?? String(err) };
  }
}

export async function syncStopForTrade(trade: TradeLike, nextStopPrice: number): Promise<StopSyncResult> {
  const ticker = normalizeTicker(trade.ticker);
  const side = normalizeSide(trade.side);
  const currentStop = num(trade.stopPrice);

  if (!ticker || !side) return { ok: false, error: "invalid_trade_ticker_or_side" };
  if (typeof nextStopPrice !== "number" || Number.isNaN(nextStopPrice)) return { ok: false, error: "invalid_nextStopPrice" };
  if (currentStop == null) return { ok: false, error: "missing_current_stopPrice" };

  if (!isTightening(side, currentStop, nextStopPrice)) {
    return { ok: false, error: "not_tightening" };
  }

  const alpacaOrderId = (trade.alpacaOrderId || trade.brokerOrderId || null) as string | null;

  const toCancel = new Set<string>();
  if (trade.stopOrderId) toCancel.add(String(trade.stopOrderId));

  if (alpacaOrderId) {
    try {
      const parent = await getOrder(alpacaOrderId);
      const legs = (parent as any)?.legs || [];
      const stopLeg = (legs as any[]).find(
        (leg: any) =>
          leg &&
          typeof leg.stop_price !== "undefined" &&
          leg.side &&
          String(leg.side).toLowerCase() !== String((parent as any)?.side ?? "").toLowerCase()
      );
      if (stopLeg?.id) toCancel.add(String(stopLeg.id));
    } catch {}
  }

  const cancelled: string[] = [];
  try {
    for (const stopId of toCancel) {
      const ok = await cancelOrderId(stopId);
      if (!ok) return { ok: false, error: "cancel_failed", detail: stopId };
      cancelled.push(stopId);
    }

    const qtyFromTrade =
      Number(trade.quantity ?? trade.qty ?? trade.size ?? trade.positionSize ?? trade.shares) ||
      Number(trade.brokerRaw?.qty ?? trade.brokerRaw?.quantity ?? 0);

    let qty = qtyFromTrade;

    if (!qty || qty <= 0) {
      const positions = await getPositions(ticker);
      const normalized = Array.isArray(positions)
        ? positions.find((p) => p?.symbol?.toUpperCase() === ticker)
        : positions;
      qty = Number((normalized as any)?.qty ?? 0);
    }

    if (!qty || qty <= 0) {
      return { ok: false, error: "unable_to_determine_qty" };
    }

    const stopSide = side === "SHORT" ? "buy" : "sell";

    // Normalize stop price to ensure tick compliance
    const entryPrice = num(trade.stopPrice) ?? 0; // Use current stop as fallback for directional check
    const tick = tickForEquityPrice(entryPrice);
    const normResult = normalizeStopPrice({
      side,
      entryPrice,
      stopPrice: nextStopPrice,
      tick,
    });

    if (!normResult.ok) {
      return {
        ok: false,
        error: "stop_normalization_failed",
        detail: `reason=${normResult.reason} original=${nextStopPrice} normalized=${normResult.stop || "N/A"}`,
      };
    }

    // Check if quantization changed the price significantly
    const quantizationDiff = Math.abs(normResult.stop - nextStopPrice);
    let quantizationNote: string | undefined;
    if (quantizationDiff > 0.0001) {
      quantizationNote = `price_adjusted_for_tick_compliance: ${nextStopPrice} -> ${normResult.stop} (diff: ${quantizationDiff.toFixed(6)})`;
    }

    const stopOrder = await createOrder({
      symbol: ticker,
      qty,
      side: stopSide,
      type: "stop",
      time_in_force: "day",
      stop_price: normResult.stop,
      extended_hours: false,
    });

    return { 
      ok: true, 
      qty, 
      stopOrderId: String((stopOrder as any)?.id || ""), 
      cancelled,
      quantizationNote,
    };
  } catch (err: any) {
    return { ok: false, error: "stop_sync_error", detail: err?.message ?? String(err) };
  }
}
