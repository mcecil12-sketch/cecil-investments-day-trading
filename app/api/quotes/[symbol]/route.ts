import { NextResponse } from "next/server";

const API_KEY = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_API_SECRET;
const DATA_BASE_URL =
  process.env.ALPACA_DATA_BASE_URL ?? "https://data.alpaca.markets";

export async function GET(
  _req: Request,
  { params }: { params: { symbol: string } }
) {
  const symbol = params.symbol.toUpperCase();

  if (!API_KEY || !API_SECRET) {
    return NextResponse.json(
      { error: "Alpaca API keys not configured" },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(
      `${DATA_BASE_URL}/v2/stocks/${encodeURIComponent(
        symbol
      )}/quotes/latest`,
      {
        headers: {
          "APCA-API-KEY-ID": API_KEY,
          "APCA-API-SECRET-KEY": API_SECRET,
        },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error("Quote error", res.status, text);
      return NextResponse.json(
        { error: "Failed to fetch quote" },
        { status: res.status }
      );
    }

    const json = await res.json();

    const last =
      json.quote?.ap ??
      json.quote?.bp ??
      json.quote?.lp ??
      null;

    return NextResponse.json(
      {
        symbol,
        last,
        raw: json,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Quote fetch exception", err);
    return NextResponse.json(
      { error: "Exception fetching quote" },
      { status: 500 }
    );
  }
}
