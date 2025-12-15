import { NextResponse } from "next/server";
import { fetchRecentBars } from "@/lib/alpaca";
import { buildSignalContext } from "@/lib/signalContext";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = (url.searchParams.get("ticker") || "SPY").toUpperCase();
    const timeframe = url.searchParams.get("timeframe") || "1Min";

    const bars = await fetchRecentBars(ticker, timeframe, 30);
    const ctx = await buildSignalContext({ ticker, timeframe, limit: 90 });

    return NextResponse.json({
      ok: true,
      ticker,
      timeframe,
      barsUsed: bars.length,
      firstBar: bars[0] || null,
      lastBar: bars.length ? bars[bars.length - 1] : null,
      barKeys: bars.length ? Object.keys(bars[bars.length - 1] as any) : [],
      computedContext: ctx,
      env: {
        hasAlpacaKey: !!process.env.ALPACA_API_KEY,
        hasAlpacaSecret: !!process.env.ALPACA_API_SECRET,
        alpacaDataFeed: process.env.ALPACA_DATA_FEED || null,
      },
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.log("[debug-context] error:", msg);
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        name: err?.name || null,
        code: err?.code || null,
        stack: (err?.stack || "").split("\n").slice(0, 8),
        env: {
          hasAlpacaKey: !!process.env.ALPACA_API_KEY,
          hasAlpacaSecret: !!process.env.ALPACA_API_SECRET,
          alpacaDataFeed: process.env.ALPACA_DATA_FEED || null,
        },
      },
      { status: 200 }
    );
  }
}
