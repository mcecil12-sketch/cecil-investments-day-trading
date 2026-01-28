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
  | { ok: true; qty: number; stopOrderId: string; cancelled: string[] }
  | { ok: false; error: string; detail?: string };

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

    const stopOrder = await createOrder({
      symbol: ticker,
      qty,
      side: stopSide,
      type: "stop",
      time_in_force: "day",
      stop_price: normResult.stop,
      extended_hours: false,
    });

    return { ok: true, qty, stopOrderId: String((stopOrder as any)?.id || ""), cancelled };
  } catch (err: any) {
    return { ok: false, error: "stop_sync_error", detail: err?.message ?? String(err) };
  }
}
