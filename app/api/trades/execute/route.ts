import { NextResponse } from "next/server";

const API_KEY = process.env.ALPACA_API_KEY ?? process.env.ALPACA_API_KEY_ID;
const API_SECRET = process.env.ALPACA_API_SECRET ?? process.env.ALPACA_API_SECRET_KEY;
const TRADING_BASE_URL_RAW = process.env.ALPACA_TRADING_BASE_URL ?? process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
const TRADING_BASE_URL = TRADING_BASE_URL_RAW.replace(/\/v2\/?$/, "");

/**
 * Expected payload from frontend:
 * {
 *   id: string;          // trade id in your app
 *   ticker: string;
 *   side: "LONG" | "SHORT";
 *   size: number;        // shares
 *   entryPrice: number;  // optional (for limit)
 *   type?: "MKT" | "LMT";
 * }
 */
export async function POST(req: Request) {
  if (!API_KEY || !API_SECRET) {
    return NextResponse.json(
      { error: "Alpaca API keys not configured" },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { id, ticker, side, size, entryPrice, type = "MKT" } = body;

  if (!ticker || !side || !size) {
    return NextResponse.json(
      { error: "Missing fields: ticker, side, size" },
      { status: 400 }
    );
  }

  const alpacaSide = side === "LONG" ? "buy" : "sell";

  const orderPayload: any = {
    symbol: ticker.toUpperCase(),
    qty: size,
    side: alpacaSide,
    type: type === "LMT" ? "limit" : "market",
    time_in_force: "day",
    client_order_id: id,
  };

  if (type === "LMT" && entryPrice) {
    orderPayload.limit_price = entryPrice;
  }

  try {
    const res = await fetch(`${TRADING_BASE_URL}/v2/orders`, {
      method: "POST",
      headers: {
        "APCA-API-KEY-ID": API_KEY,
        "APCA-API-SECRET-KEY": API_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderPayload),
    });

    const json = await res.json();

    if (!res.ok) {
      console.error("Alpaca order error", res.status, json);
      return NextResponse.json(
        { error: "Order rejected", brokerResponse: json },
        { status: res.status }
      );
    }

    return NextResponse.json(
      {
        status: "submitted",
        brokerResponse: json,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Alpaca order exception", err);
    return NextResponse.json(
      { error: "Exception submitting order" },
      { status: 500 }
    );
  }
}
