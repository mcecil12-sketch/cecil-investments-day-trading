export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { fetchRecentBarsWithUrl, hasAlpacaCreds, ALPACA_FEED } from "@/lib/alpaca";
import { fetchAlpacaClock } from "@/lib/alpacaClock";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const ticker = (searchParams.get("ticker") || "SPY").toUpperCase();
    const timeframe = searchParams.get("timeframe") || "1Min";
    const windowMinutes = Math.max(
      15,
      Number(searchParams.get("windowMinutes") || "180") || 180
    );
    const startOverride = searchParams.get("start");
    const endOverride = searchParams.get("end");

    const now = new Date();
    const clock = await fetchAlpacaClock().catch(() => null);
    const marketOpen = Boolean(clock?.is_open);

    const endDate = endOverride
      ? new Date(endOverride)
      : marketOpen
      ? now
      : clock?.next_open
      ? new Date(new Date(clock.next_open).getTime() - 60_000)
      : now;

    const startDate = startOverride
      ? new Date(startOverride)
      : new Date(endDate.getTime() - windowMinutes * 60_000);
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();
    const feed = process.env.ALPACA_DATA_FEED || "sip";

    const result = await fetchRecentBarsWithUrl({
      ticker,
      timeframe,
      adjustment: "raw",
      start: startIso,
      end: endIso,
      windowMinutes,
      feed,
    });

    const { bars, json, url } = result;

    const barsArray = Array.isArray(bars) ? bars : [];
    const firstBar = barsArray[0] ?? null;
    const lastBar = barsArray[barsArray.length - 1] ?? null;
    const volumeSum = barsArray.reduce((sum, bar) => sum + (bar?.v ?? 0), 0);
    const avgVolume = barsArray.length ? volumeSum / barsArray.length : 0;
    const ageMinutes =
      lastBar && lastBar.t ? Math.max(0, (Date.now() - Date.parse(lastBar.t)) / 60000) : null;

    return NextResponse.json({
      ok: true,
      ticker,
      timeframe,
      serverNow: new Date().toISOString(),
      alpacaClock: clock,
      barsUrlAttempted: url,
      barsUsed: barsArray.length,
      firstBar,
      lastBar,
      barsMeta: {
        firstTimestamp: firstBar?.t ?? null,
        lastTimestamp: lastBar?.t ?? null,
        ageMinutes,
        volumeSum,
        avgVolume,
      },
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
