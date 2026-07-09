import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { submitOrder } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

type ApproveBody = {
  tradeId: string;
};

function mapDirection(side?: string): "buy" | "sell" {
  return (side || "LONG").toUpperCase() === "LONG" ? "buy" : "sell";
}

function parseNumber(value: any): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: ApproveBody;
  try {
    body = (await req.json()) as ApproveBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (!body?.tradeId) {
    return NextResponse.json({ ok: false, error: "tradeId is required" }, { status: 400 });
  }

  const trades = await readTrades<any>();
  const idx = trades.findIndex((t) => t?.id === body.tradeId);
  if (idx === -1) {
    return NextResponse.json({ ok: false, error: "Trade not found" }, { status: 404 });
  }

  const trade = trades[idx];
  const tickerRaw = trade?.ticker;
  const ticker = typeof tickerRaw === "string" ? tickerRaw.toUpperCase() : tickerRaw;
  const side = (trade?.side ?? "").toString().toUpperCase();
  const entryPrice = parseNumber(trade?.entryPrice);
  const stopPrice = parseNumber(trade?.stopPrice);

  if (!ticker || !side || !entryPrice || !stopPrice) {
    return NextResponse.json(
      { ok: false, error: "Trade missing ticker/side/entryPrice/stopPrice" },
      { status: 400 }
    );
  }

  if (side !== "LONG" && side !== "SHORT") {
    return NextResponse.json({ ok: false, error: "Invalid trade side" }, { status: 400 });
  }

  // === DIRECTION INTEGRITY GUARDS ===
  // Validate stop price geometry is correct for direction
  if (side === "SHORT") {
    if (stopPrice <= entryPrice) {
      return NextResponse.json(
        { 
          ok: false, 
          error: `SHORT direction integrity violation: stopPrice (${stopPrice}) must be > entryPrice (${entryPrice})` 
        },
        { status: 400 }
      );
    }
  } else if (side === "LONG") {
    if (stopPrice >= entryPrice) {
      return NextResponse.json(
        { 
          ok: false, 
          error: `LONG direction integrity violation: stopPrice (${stopPrice}) must be < entryPrice (${entryPrice})` 
        },
        { status: 400 }
      );
    }
  }

  let qty = parseNumber(
    trade?.quantity ?? trade?.size ?? trade?.qty ?? trade?.positionSize ?? trade?.shares
  );

  if (!qty || qty <= 0) {
    const riskDollars =
      parseNumber(trade?.riskDollars) ??
      parseNumber(trade?.initialDollarRisk) ??
      parseNumber(trade?.oneR) ??
      parseNumber(trade?.dollarRisk);
    const diff = Math.abs(entryPrice - stopPrice);
    if (riskDollars && diff > 0) {
      qty = Math.max(1, Math.floor(riskDollars / diff));
    }
  }

  if (!qty || qty <= 0) {
    return NextResponse.json({ ok: false, error: "Quantity could not be determined" }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  const updatedTradeBase = {
    ...trade,
    quantity: qty,
    submitToBroker: true,
    updatedAt: nowIso,
  };

  try {
    const order = await submitOrder({
      symbol: ticker,
      qty,
      side: mapDirection(side),
      type: "market",
      timeInForce: "day",
    });

    const updatedTrade = {
      ...updatedTradeBase,
      status: "OPEN",
      brokerOrderId: order.id,
      brokerStatus: order.status,
      brokerRaw: order,
      alpacaOrderId: order.id,
      alpacaStatus: order.status,
      openedAt: nowIso,
      error: undefined,
    };

    trades[idx] = updatedTrade;
    await writeTrades(trades);

    return NextResponse.json({ ok: true, trade: updatedTrade }, { status: 200 });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const failedTrade = {
      ...updatedTradeBase,
      status: "ERROR",
      error: message,
    };
    trades[idx] = failedTrade;
    await writeTrades(trades);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
