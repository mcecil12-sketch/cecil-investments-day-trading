import { fetchRecentBarsWithUrl, AlpacaBar, alpacaHeaders } from "@/lib/alpaca";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { getRollingWindowMinutes, resolveEndIso } from "@/lib/barWindow";

export type SignalContext = {
  timeframe: string;
  barsUsed: number;
  vwap: number | null;
  trend: "UP" | "DOWN" | "FLAT";
  trendSlopePct: number;
  avgVolume: number | null;
  lastVolume: number | null;
  relVolume: number;
  relVolumeNote?: string;
  rangePctAvg: number | null;
  liquidityNote: string;
};

function safeNum(n: any): number | null {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function typicalPrice(b: AlpacaBar) {
  return (b.h + b.l + b.c) / 3;
}

function computeVWAP(bars: AlpacaBar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const vol = safeNum((b as any).v) ?? 0;
    if (!Number.isFinite(vol) || vol <= 0) continue;
    pv += typicalPrice(b) * vol;
    v += vol;
  }
  if (v <= 0) return null;
  return pv / v;
}

function computeTrend(bars: AlpacaBar[]) {
  if (bars.length < 6) return { trend: "FLAT" as const, slopePct: 0 };
  const n = Math.min(20, bars.length);
  const slice = bars.slice(-n);
  const first = slice[0]?.c;
  const last = slice[slice.length - 1]?.c;
  if (!first || !last || first <= 0) return { trend: "FLAT" as const, slopePct: 0 };
  const totalPct = (last - first) / first;
  const perBarPct = totalPct / (slice.length - 1);
  let trend: SignalContext["trend"] = "FLAT";
  if (perBarPct > 0.0006) trend = "UP";
  else if (perBarPct < -0.0006) trend = "DOWN";
  return { trend, slopePct: perBarPct * 100 };
}

function computeVolumes(bars: AlpacaBar[]) {
  const vols = bars.map((b) => safeNum((b as any).v)).filter((v): v is number => v !== null);
  if (vols.length < 6) {
    return { avg: null, last: null, rel: 1.0, relNote: "relVol defaulted (insufficient volume bars)" };
  }
  const last = vols[vols.length - 1];
  const sample = vols.slice(-Math.min(30, vols.length));
  const avg = sample.reduce((a, b) => a + b, 0) / sample.length;
  if (!(avg > 0)) {
    return { avg, last, rel: 1.0, relNote: "relVol defaulted (avg volume <= 0)" };
  }
  const rel = last / avg;
  return { avg, last, rel, relNote: null };
}

function computeAvgRangePct(bars: AlpacaBar[]) {
  const sample = bars.slice(-Math.min(30, bars.length));
  const vals: number[] = [];
  for (const b of sample) {
    if (!b.c || b.c <= 0) continue;
    const r = (b.h - b.l) / b.c;
    if (Number.isFinite(r)) vals.push(r);
  }
  if (vals.length < 6) return null;
  return (vals.reduce((a, b) => a + b, 0) / vals.length) * 100;
}

function liquidityNoteFromContext(avgVolume: number | null, price: number | null) {
  if (!avgVolume || !price) return "Unknown liquidity (insufficient bar volume/price).";
  const dollarVol = avgVolume * price;
  if (dollarVol >= 50_000_000) return "High liquidity (est. $50M+ avg bar dollar-volume).";
  if (dollarVol >= 10_000_000) return "Moderate liquidity (est. $10M–$50M avg bar dollar-volume).";
  if (dollarVol >= 2_000_000) return "Low/moderate liquidity (est. $2M–$10M avg bar dollar-volume).";
  return "Low liquidity risk (est. <$2M avg bar dollar-volume).";
}

const DEBUG_SIGNAL_CONTEXT = process.env.DEBUG_SIGNAL_CONTEXT === "1";

function tradingBaseUrl() {
  return (
    process.env.ALPACA_TRADING_BASE_URL ||
    process.env.ALPACA_BASE_URL ||
    "https://paper-api.alpaca.markets"
  ).replace(/\/$/, "");
}

function isoDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function fetchLastTradingSessionClose() {
  try {
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 14);
    const startStr = isoDateOnly(start);
    const endStr = isoDateOnly(now);
    const url = `${tradingBaseUrl()}/v2/calendar?start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`;
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
    if (DEBUG_SIGNAL_CONTEXT) {
      console.warn("[signalContext] calendar lookup failed", err);
    }
    return null;
  }
}

export async function buildSignalContext(params: {
  ticker: string;
  timeframe: string;
  limit?: number;
  endTimeIso?: string;
}): Promise<SignalContext> {
  const limit = params.limit ?? 120;
  const endIso = resolveEndIso(params.endTimeIso);
  const windowMinutes = getRollingWindowMinutes(params.timeframe);

  const { json, url, bars } = await fetchRecentBarsWithUrl({
    ticker: params.ticker,
    timeframe: params.timeframe,
    adjustment: "raw",
    end: endIso,
    limit,
    windowMinutes,
  });

  let finalBars = (bars ?? json?.bars ?? []) as AlpacaBar[];
  let fallbackEndIso: string | null = null;
  let fallbackAttempts = 0;
  let fallbackUsed = false;

  const stepMs = 360 * 60_000;
  const maxAttempts = 30;
  let cursor = Number.isFinite(Number(endIso)) ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(cursor)) cursor = Date.now();

  if (finalBars.length === 0) {
    for (let attempt = 0; attempt < maxAttempts && finalBars.length === 0; attempt++) {
      cursor -= stepMs;
      const attemptIso = new Date(cursor).toISOString();
      const attemptResp = await fetchRecentBarsWithUrl({
        ticker: params.ticker,
        timeframe: params.timeframe,
        adjustment: "raw",
        end: attemptIso,
        limit,
        windowMinutes,
      });
      fallbackAttempts = attempt + 1;
      const attemptBars = (attemptResp.bars ?? attemptResp.json?.bars ?? []) as AlpacaBar[];
      if (attemptBars.length > 0) {
        finalBars = attemptBars;
        fallbackUsed = true;
        fallbackEndIso = attemptIso;
        break;
      }
    }
  }

  if (DEBUG_SIGNAL_CONTEXT) {
    const lastBarTime = finalBars.length ? finalBars[finalBars.length - 1].t : null;
    console.log("[signalContext]", {
      ticker: params.ticker,
      timeframe: params.timeframe,
      barsUsed: finalBars.length,
      endIso,
      windowMinutes,
      lastBarTime,
      url,
      fallbackUsed,
      fallbackAttempts,
      fallbackEndIso,
    });
  }

  const vwap = computeVWAP(finalBars);
  const { trend, slopePct } = computeTrend(finalBars);
  const { avg, last, rel, relNote } = computeVolumes(finalBars);
  const rangePctAvg = computeAvgRangePct(finalBars);
  const lastClose = finalBars.length ? finalBars[finalBars.length - 1].c : null;
  const liquidityNote = liquidityNoteFromContext(avg, lastClose ?? null);

  return {
    timeframe: params.timeframe,
    barsUsed: finalBars.length,
    vwap: vwap ?? null,
    trend,
    trendSlopePct: slopePct,
    avgVolume: avg ?? null,
    lastVolume: last ?? null,
    relVolume: Number.isFinite(rel) ? rel : 1.0,
    relVolumeNote: relNote ?? undefined,
    rangePctAvg,
    liquidityNote,
  };
}
