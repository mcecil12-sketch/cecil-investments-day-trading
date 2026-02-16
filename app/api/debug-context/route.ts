export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { fetchRecentBarsWithUrl, hasAlpacaCreds, ALPACA_FEED, alpacaHeaders, tradingUrl } from "@/lib/alpaca";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { computeVWAP } from "@/lib/scannerUtils";

function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function fetchLastTradingSessionClose(): Promise<{ date: string; close: string } | null> {
  try {
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 10); // Look back 10 calendar days
    const startStr = isoDateOnly(start);
    const endStr = isoDateOnly(now);
    const url = `${tradingUrl("/calendar")}?start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`;
    const res = await fetch(url, {
      headers: alpacaHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const calendar = (await res.json()) as Array<{ date: string; open: string; close: string }>;
    if (!Array.isArray(calendar) || calendar.length === 0) return null;
    const last = calendar[calendar.length - 1];
    if (!last?.date || !last?.close) return null;
    return { date: last.date, close: last.close };
  } catch (err) {
    console.warn("[debug-context] calendar lookup failed", err);
    return null;
  }
}

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
    const entryPriceRaw = searchParams.get("entryPrice");
    const fallbackRequested = searchParams.get("fallback") === "1" || searchParams.get("mode") === "last-session";

    const now = new Date();
    const clock = await fetchAlpacaClock().catch(() => null);
    const marketOpen = Boolean(clock?.is_open);

    let anchorMode = "rolling";
    let startIso: string;
    let endIso: string;
    let endDate: Date;
    let startDate: Date;

    // === ROLLING WINDOW (default) ===
    endDate = endOverride
      ? new Date(endOverride)
      : marketOpen
      ? now
      : clock?.next_open
      ? new Date(clock.timestamp)
      : now;

    startDate = startOverride
      ? new Date(startOverride)
      : new Date(endDate.getTime() - windowMinutes * 60_000);
    startIso = startDate.toISOString();
    endIso = endDate.toISOString();
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
    let barsArray = Array.isArray(bars) ? bars : [];

    // === FALLBACK LOGIC ===
    // If fallback requested, market closed, or insufficient bars, try last-session window
    const shouldTryLastSession = fallbackRequested || !marketOpen || barsArray.length < 20;
    if (shouldTryLastSession) {
      const lastSession = await fetchLastTradingSessionClose();
      if (lastSession?.close) {
        const lastSessionClose = new Date(lastSession.close);
        const lastSessionStart = new Date(lastSessionClose.getTime() - windowMinutes * 60_000);
        const lastSessionStartIso = lastSessionStart.toISOString();
        const lastSessionEndIso = lastSessionClose.toISOString();

        const lastSessionResult = await fetchWindow(lastSessionStartIso, lastSessionEndIso);
        const lastSessionBars = Array.isArray(lastSessionResult.bars) ? lastSessionResult.bars : [];

        // Prefer last-session if it has bars (especially if rolling had none or very few)
        if (lastSessionBars.length > 0) {
          bars = lastSessionBars;
          barsArray = lastSessionBars;
          barsUrlAttempted = lastSessionResult.url;
          anchorMode = "last-session";
          startIso = lastSessionStartIso;
          endIso = lastSessionEndIso;
        }
      }
    }

    // === COMPUTE METADATA ===
    const firstBar = barsArray[0] ?? null;
    const lastBar = barsArray[barsArray.length - 1] ?? null;
    const volumeSum = barsArray.reduce((sum, bar) => sum + (bar?.v ?? 0), 0);
    const avgVolume = barsArray.length ? volumeSum / barsArray.length : 0;
    const ageMinutes =
      lastBar && lastBar.t ? Math.max(0, (Date.now() - Date.parse(lastBar.t)) / 60000) : null;
    const vwap = computeVWAP(barsArray);

    // === CONTEXT WARNING ===
    let contextWarning: string | null = null;
    if (entryPriceRaw && vwap > 0) {
      const entryPrice = Number(entryPriceRaw);
      if (Number.isFinite(entryPrice) && entryPrice > 0) {
        const pctDiff = Math.abs((vwap - entryPrice) / entryPrice);
        if (pctDiff > 0.2) {
          contextWarning = `VWAP (${vwap.toFixed(2)}) deviates >20% from entryPrice (${entryPrice.toFixed(2)})`;
        }
      }
    }

    return NextResponse.json(
      {
        ok: true,
        ticker,
        timeframe,
        serverNow: new Date().toISOString(),
        anchorMode,
        startIso,
        endIso,
        alpacaClock: clock,
        barsUrlAttempted,
        barsUsed: barsArray.length,
        firstBar,
        lastBar,
        vwap: vwap > 0 ? vwap : null,
        barsMeta: {
          firstTimestamp: firstBar?.t ?? null,
          lastTimestamp: lastBar?.t ?? null,
          ageMinutes,
          volumeSum,
          avgVolume,
        },
        contextWarning,
        env: {
          hasAlpacaKey: hasAlpacaCreds(),
          hasAlpacaSecret: hasAlpacaCreds(),
          alpacaDataFeed: ALPACA_FEED,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: String(err?.message || err),
        name: err?.name || "Error",
        code: err?.code ?? null,
        stack: err?.stack ? String(err.stack).split("\n") : undefined,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
