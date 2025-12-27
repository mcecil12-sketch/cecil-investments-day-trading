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
      ? new Date(clock.timestamp)
      : now;

    const startDate = startOverride
      ? new Date(startOverride)
      : new Date(endDate.getTime() - windowMinutes * 60_000);
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();
    const feed = process.env.ALPACA_DATA_FEED || "sip";

    const fetchWindow = async (start: string, end: string) => {
      return fetchRecentBarsWithUrl({
        ticker,
        timeframe,
        adjustment: "raw",
        start,
        end,
        feed,
      });
    };

    let windowResult = await fetchWindow(startIso, endIso);
    let bars = windowResult.bars;
    let barsUrlAttempted = windowResult.url;

    if (!marketOpen && bars.length === 0) {
      for (const backHours of [6, 12]) {
        const endShift = new Date(endDate.getTime() - backHours * 60 * 60_000);
        const startShift = new Date(endShift.getTime() - windowMinutes * 60_000);
        const attempt = await fetchWindow(startShift.toISOString(), endShift.toISOString());
        if (attempt.bars.length > 0) {
          bars = attempt.bars;
          barsUrlAttempted = attempt.url;
          break;
        }
      }
    }

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
      barsUrlAttempted,
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
