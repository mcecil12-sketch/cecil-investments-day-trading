export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { fetchRecentBarsWithUrl, hasAlpacaCreds, ALPACA_FEED } from "@/lib/alpaca";

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);

    const ticker = (u.searchParams.get("ticker") || "SPY").toUpperCase();
    const timeframe = u.searchParams.get("timeframe") || "1Min";

    const { url, json } = await fetchRecentBarsWithUrl({
      ticker,
      timeframe,
      limit: 90,
    });

    const bars = json?.bars || json?.[ticker] || [];

    return NextResponse.json({
      ok: true,
      ticker,
      timeframe,
      barsUrlAttempted: url,
      barsUsed: Array.isArray(bars) ? bars.length : 0,
      firstBar: Array.isArray(bars) ? bars[0] : null,
      lastBar: Array.isArray(bars) ? bars[bars.length - 1] : null,
      env: {
        hasAlpacaKey: hasAlpacaCreds(),
        hasAlpacaSecret: hasAlpacaCreds(),
        alpacaDataFeed: ALPACA_FEED,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: String(err?.message || err),
        name: err?.name || "Error",
        code: err?.code ?? null,
        stack: err?.stack ? String(err.stack).split("\n") : undefined,
      },
      { status: 500 }
    );
  }
}
