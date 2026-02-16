export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { fetchRecentBarsWithUrl, hasAlpacaCreds, ALPACA_FEED, alpacaHeaders, tradingUrl } from "@/lib/alpaca";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { computeVWAP } from "@/lib/scannerUtils";

// ============= DATE HELPERS =============
function isValidDate(d: any): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

function toIso(d: Date | null): string | null {
  return d && isValidDate(d) ? d.toISOString() : null;
}

function isoDateOnly(date: Date): string | null {
  const iso = toIso(date);
  return iso ? iso.slice(0, 10) : null;
}

async function fetchLastTradingSessionClose(): Promise<{ date: string; open?: string; close: string; httpStatus?: number; url?: string; bodyHead?: string } | null> {
  try {
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 10); // Look back 10 calendar days
    
    const startStr = isoDateOnly(start);
    const endStr = isoDateOnly(now);
    
    if (!startStr || !endStr) {
      console.warn("[debug-context] calendar: could not format date range");
      return null;
    }
    
    const url = `${tradingUrl("/calendar")}?start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`;
    const res = await fetch(url, {
      headers: alpacaHeaders(),
      cache: "no-store",
    });
    
    const responseBody = await res.text();
    
    if (!res.ok) {
      console.warn("[debug-context] calendar: non-200 response", res.status);
      return {
        date: "",
        close: "",
        httpStatus: res.status,
        url,
        bodyHead: responseBody.slice(0, 200),
      };
    }
    
    const calendar = (await JSON.parse(responseBody)) as Array<{ date?: string; open?: string; close?: string }>;
    if (!Array.isArray(calendar) || calendar.length === 0) {
      console.warn("[debug-context] calendar: empty response");
      return null;
    }
    
    const last = calendar[calendar.length - 1];
    if (!last?.date || !last?.close) {
      console.warn("[debug-context] calendar: missing date/close in last entry", last);
      return null;
    }
    
    // Validate that close parses to a valid date
    const closeDate = new Date(last.close);
    if (!isValidDate(closeDate)) {
      console.warn("[debug-context] calendar: invalid close timestamp", last.close);
      return null;
    }
    
    return { date: last.date, close: last.close, url, ...(last.open ? { open: last.open } : {}) };
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
    
    // Parse fallback param robustly
    const fallbackRaw = (searchParams.get("fallback") || "").toLowerCase();
    const modeRaw = (searchParams.get("mode") || "").toLowerCase();
    const wantFallback = ["1", "true", "yes", "on"].includes(fallbackRaw) || modeRaw === "last-session";

    const now = new Date();
    const clock = await fetchAlpacaClock().catch(() => null);
    const marketOpen = Boolean(clock?.is_open);

    let anchorMode = "rolling";
    let startIso: string | null = null;
    let endIso: string | null = null;
    let startMs: number | null = null;
    let endMs: number | null = null;
    let calendarPick: { date: string; open?: string; close: string } | null = null;
    let calendarHttpStatus: number | null = null;
    let calendarUrl: string | null = null;
    let calendarBodyHead: string | null = null;
    let barsUrlAttempted: string | null = null;
    let barsArray: any[] = [];
    let barsFetchReason: string | null = null;
    let calendarParseNote: string | null = null;
    let shouldFallback: boolean = false;
    let fallbackReason: string | null = null;
    const feed = process.env.ALPACA_DATA_FEED || "sip";

    // === BUILD ROLLING WINDOW ===
    let endDate: Date | null = null;
    let startDate: Date | null = null;

    if (endOverride) {
      endDate = new Date(endOverride);
    } else if (marketOpen) {
      endDate = now;
    } else if (clock?.timestamp) {
      endDate = new Date(clock.timestamp);
    } else {
      endDate = now;
    }

    // Validate rolling end date
    if (!isValidDate(endDate)) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_anchor_dates",
          message: "Could not construct valid end date for rolling window",
          anchorMode: "rolling",
          startIso: null,
          endIso: null,
          startRaw: startOverride || "now",
          endRaw: endOverride || "now",
          startMs: null,
          endMs: null,
          ticker,
          timeframe,
          wantFallback,
          shouldFallback: false,
          fallbackReason: null,
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    startDate = startOverride
      ? new Date(startOverride)
      : new Date(endDate.getTime() - windowMinutes * 60_000);

    // Validate rolling start date
    if (!isValidDate(startDate)) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_anchor_dates",
          message: "Could not construct valid start date for rolling window",
          anchorMode: "rolling",
          startIso: null,
          endIso: null,
          startRaw: startOverride || `now-${windowMinutes}m`,
          endRaw: endOverride || "now",
          startMs: null,
          endMs: endDate.getTime(),
          ticker,
          timeframe,
          wantFallback,
          shouldFallback: false,
          fallbackReason: null,
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    startIso = startDate.toISOString();
    endIso = endDate.toISOString();
    startMs = startDate.getTime();
    endMs = endDate.getTime();

    // Fetch rolling window
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
    barsUrlAttempted = windowResult.url;
    barsArray = Array.isArray(bars) ? bars : [];
    barsFetchReason = "rolling window";

    // === DETERMINE IF FALLBACK SHOULD TRIGGER ===
    const barsUsed = barsArray.length;
    if (wantFallback) {
      shouldFallback = true;
      fallbackReason = "wantFallback";
    } else if (!marketOpen) {
      shouldFallback = true;
      fallbackReason = "market_closed";
    } else if (barsUsed < 20) {
      shouldFallback = true;
      fallbackReason = "insufficient_bars";
    }

    // === FALLBACK LOGIC ===
    if (shouldFallback) {
      barsFetchReason = `fallback: ${fallbackReason}`;
      const calendarResult = await fetchLastTradingSessionClose();
      
      if (calendarResult) {
        // Capture calendar error details if present
        if (calendarResult.httpStatus) {
          calendarHttpStatus = calendarResult.httpStatus;
          calendarUrl = calendarResult.url || null;
          calendarBodyHead = calendarResult.bodyHead || null;
          calendarParseNote = `calendar API returned ${calendarResult.httpStatus}`;
        } else if (calendarResult.close) {
          // Success: calendar returned valid data
          try {
            const lastSessionClose = new Date(calendarResult.close);
            if (!isValidDate(lastSessionClose)) {
              calendarParseNote = "calendar close timestamp invalid";
            } else {
              const lastSessionStart = new Date(lastSessionClose.getTime() - windowMinutes * 60_000);
              if (!isValidDate(lastSessionStart)) {
                calendarParseNote = "calculated last-session start is invalid";
              } else {
                const lastSessionStartIso = lastSessionStart.toISOString();
                const lastSessionEndIso = lastSessionClose.toISOString();

                const lastSessionResult = await fetchWindow(lastSessionStartIso, lastSessionEndIso);
                const lastSessionBars = Array.isArray(lastSessionResult.bars) ? lastSessionResult.bars : [];

                // Prefer last-session if it has bars
                if (lastSessionBars.length > 0) {
                  bars = lastSessionBars;
                  barsArray = lastSessionBars;
                  barsUrlAttempted = lastSessionResult.url;
                  anchorMode = "last-session";
                  startIso = lastSessionStartIso;
                  endIso = lastSessionEndIso;
                  startMs = lastSessionStart.getTime();
                  endMs = lastSessionClose.getTime();
                  barsFetchReason = `fallback: ${fallbackReason} -> last-session`;
                  calendarPick = {
                    date: calendarResult.date,
                    close: calendarResult.close,
                    ...(calendarResult.open ? { open: calendarResult.open } : {}),
                  };
                }
              }
            }
          } catch (fallbackErr) {
            calendarParseNote = `last-session parsing error: ${String(fallbackErr).slice(0, 100)}`;
          }
        }
      } else {
        calendarParseNote = "calendar fetch returned null";
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

    // === BUILD RESPONSE ===
    const responseBody: any = {
      ok: true,
      ticker,
      timeframe,
      serverNow: now.toISOString(),
      anchorMode,
      startIso,
      endIso,
      startMs,
      endMs,
      alpacaClock: clock,
      barsUrlAttempted,
      barsUsed: barsArray.length,
      barsFetchReason,
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
      // Fallback diagnostics
      wantFallback,
      shouldFallback,
      fallbackReason,
      calendarPick,
      calendarHttpStatus,
      calendarUrl,
      calendarBodyHead,
      calendarParseNote,
      env: {
        hasAlpacaKey: hasAlpacaCreds(),
        hasAlpacaSecret: hasAlpacaCreds(),
        alpacaDataFeed: ALPACA_FEED,
      },
    };

    return NextResponse.json(responseBody, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "debug_context_fatal",
        message: String(err?.message || err),
        name: err?.name || "Error",
        code: err?.code ?? null,
        stack: err?.stack ? String(err.stack).split("\n").slice(0, 10) : undefined,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
