import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { alpacaRequest, createOrder, getOrder, getPositions } from "@/lib/alpaca";
import { normalizeStopPrice, tickForEquityPrice } from "@/lib/tickSize";

type ApplyStopBody = {
  tradeId: string;
  stopPrice: number;
};

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: ApplyStopBody;
  try {
    body = (await req.json()) as ApplyStopBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { tradeId, stopPrice } = body || ({} as any);
  if (!tradeId || typeof stopPrice !== "number" || Number.isNaN(stopPrice)) {
    return NextResponse.json({ ok: false, error: "Missing tradeId/stopPrice" }, { status: 400 });
  }

  const trades = await readTrades();
  const idx = trades.findIndex((t) => t.id === tradeId);
  if (idx === -1) {
    return NextResponse.json({ ok: false, error: "Trade not found", tradeId, totalTrades: trades.length }, { status: 404 });
  }

  const trade = trades[idx];

  const nowIso = new Date().toISOString();

  const tickerRaw = trade?.ticker;
  const ticker = typeof tickerRaw === "string" ? tickerRaw.toUpperCase() : tickerRaw;
  const side = (trade?.side ?? "").toUpperCase();
  if (!ticker || !side) {
    return NextResponse.json(
      { ok: false, error: "Trade missing ticker/side" },
      { status: 400 }
    );
  }
  if (side !== "LONG" && side !== "SHORT") {
    return NextResponse.json({ ok: false, error: "Invalid trade side" }, { status: 400 });
  }

  const alpacaOrderId = (trade.alpacaOrderId || trade.brokerOrderId || null) as string | null;

  const existingStops = new Set<string>();
  if (trade.stopOrderId) {
    existingStops.add(trade.stopOrderId);
  }

  if (alpacaOrderId) {
    try {
      const parent = await getOrder(alpacaOrderId);
      const legs = parent.legs || [];
      const stopLeg = (legs as any[]).find(
        (leg: any) =>
          leg &&
          typeof leg.stop_price !== "undefined" &&
          leg.side &&
          leg.side.toLowerCase() !== (parent.side ?? "").toLowerCase()
      );
      if (stopLeg?.id) {
        existingStops.add(stopLeg.id);
      }
    } catch (err) {
      console.warn("[apply-stop] unable to fetch parent order, continuing", err);
    }
  }

  try {
    for (const stopId of existingStops) {
      const resp = await alpacaRequest({
        method: "DELETE",
        path: `/v2/orders/${stopId}`,
      });
      if (!resp.ok && resp.status !== 404) {
        throw new Error(resp.text || `cancel failed ${resp.status}`);
      }
    }

    const qtyFromTrade =
      Number(trade.quantity ?? trade.qty ?? trade.size ?? trade.positionSize ?? trade.shares) ||
      Number(trade.brokerRaw?.qty ?? trade.brokerRaw?.quantity ?? 0);
    let qty = qtyFromTrade;
    if (!qty || qty <= 0) {
      const positions = await getPositions(trade.ticker);
      const normalized = Array.isArray(positions)
        ? positions.find((p) => p?.symbol?.toUpperCase() === trade.ticker?.toUpperCase())
        : positions;
      qty = Number((normalized as any)?.qty ?? 0);
    }
    if (!qty || qty <= 0) {
      return NextResponse.json(
        { ok: false, error: "Unable to determine quantity for stop" },
        { status: 400 }
      );
    }

    const stopSide = trade.side?.toUpperCase() === "SHORT" ? "buy" : "sell";
    
    // Normalize stop price to ensure tick compliance
    const entryPrice = Number(trade.entryPrice ?? 0);
    const tick = tickForEquityPrice(entryPrice);
    const normResult = normalizeStopPrice({
      side: side as "LONG" | "SHORT",
      entryPrice,
      stopPrice,
      tick,
    });

    if (!normResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "stop_price_normalization_failed",
          reason: normResult.reason,
          original: stopPrice,
          normalized: normResult.stop,
        },
        { status: 400 }
      );
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

    const updatedTrade = {
      ...trade,
      quantity: qty,
      stopPrice: normResult.stop,
      stopOrderId: stopOrder.id,
      lastStopAppliedAt: nowIso,
      updatedAt: nowIso,
      error: undefined,
    };

    trades[idx] = updatedTrade;
    await writeTrades(trades);

    return NextResponse.json({ ok: true, trade: updatedTrade }, { status: 200 });
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    const updatedTrade = {
      ...trade,
      error: detail,
      updatedAt: nowIso,
    };
    trades[idx] = updatedTrade;
    await writeTrades(trades);
    return NextResponse.json(
      { ok: false, error: "Failed to apply stop", detail },
      { status: 500 }
    );
  }
}
