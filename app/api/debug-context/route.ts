export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { fetchRecentBarsWithUrl, hasAlpacaCreds, ALPACA_FEED } from "@/lib/alpaca";
import { fetchAlpacaClock } from "@/lib/alpacaClock";

function isoMinutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);

    const ticker = (u.searchParams.get("ticker") || "SPY").toUpperCase();
    const timeframe = u.searchParams.get("timeframe") || "1Min";

    const windowMinutes = Number(u.searchParams.get("windowMinutes") ?? "30");
    const endIso = new Date().toISOString();
    const startIso = isoMinutesAgo(windowMinutes);
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

    const clock = await fetchAlpacaClock().catch(() => null);

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
