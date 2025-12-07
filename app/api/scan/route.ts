import { NextResponse } from "next/server";
import { fetchRecentBars, AlpacaBar } from "@/lib/alpaca";

// Initial watchlist; tweak as you like
const WATCHLIST = ["SPY", "QQQ", "TSLA", "NVDA", "META", "AMD"];

type Side = "LONG" | "SHORT";

// Shape we send into /api/signals (matches your IncomingSignal spec)
type OutgoingSignal = {
  ticker: string;
  side: Side;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  reasoning: string;
  source: string;
  trendScore?: number;
  liquidityScore?: number;
  playbookScore?: number;
  volumeScore?: number;
  catalystScore?: number;
};

// --- Helpers ------------------------------------------------------------

function typicalPrice(bar: AlpacaBar): number {
  return (bar.h + bar.l + bar.c) / 3;
}

/**
 * Compute VWAP over a series of bars.
 */
function computeVWAP(bars: AlpacaBar[]): number | null {
  if (!bars.length) return null;
  let pvSum = 0;
  let volSum = 0;
  for (const bar of bars) {
    if (!Number.isFinite(bar.v) || bar.v <= 0) continue;
    const price = typicalPrice(bar);
    pvSum += price * bar.v;
    volSum += bar.v;
  }
  if (volSum <= 0) return null;
  return pvSum / volSum;
}

/**
 * Very simple trend score using last N closes.
 *  - 1.0 = clean uptrend (for longs) / clean downtrend (for shorts)
 *  - 0.5 = choppy
 *  - <0.5 = against trend
 */
function computeTrendScore(
  bars: AlpacaBar[],
  side: Side,
  lookback: number = 10
): number {
  if (bars.length < lookback + 1) return 0.5;
  const sliced = bars.slice(-lookback);
  let upMoves = 0;
  let downMoves = 0;

  for (let i = 1; i < sliced.length; i++) {
    const prev = sliced[i - 1].c;
    const curr = sliced[i].c;
    if (curr > prev) upMoves++;
    else if (curr < prev) downMoves++;
  }

  const total = upMoves + downMoves || 1;
  const upFrac = upMoves / total;
  const downFrac = downMoves / total;

  if (side === "LONG") {
    if (upFrac >= 0.7) return 1.0;
    if (upFrac >= 0.55) return 0.8;
    if (upFrac >= 0.45) return 0.5;
    return 0.3;
  } else {
    if (downFrac >= 0.7) return 1.0;
    if (downFrac >= 0.55) return 0.8;
    if (downFrac >= 0.45) return 0.5;
    return 0.3;
  }
}

/**
 * Crude volume score based on last bar vs recent average.
 */
function computeVolumeScore(bars: AlpacaBar[]): number {
  if (bars.length < 10) return 0.5;
  const last = bars[bars.length - 1];
  const recent = bars.slice(-20, -1);
  const avgVol =
    recent.reduce((sum, b) => sum + (b.v || 0), 0) /
    (recent.length || 1);

  if (!avgVol || !last.v) return 0.5;
  const rvol = last.v / avgVol;

  if (rvol >= 2.5) return 1.0;
  if (rvol >= 1.5) return 0.8;
  if (rvol >= 1.1) return 0.6;
  if (rvol >= 0.8) return 0.5;
  return 0.3;
}

/**
 * A+ playbook score for VWAP pullback.
 * We’ll keep this simple:
 *  - strong bounce/rejection at VWAP → 1.0
 *  - decent tag → 0.7–0.9
 *  - marginal → 0.4–0.6
 */
function computeVWAPPullbackScore(
  last: AlpacaBar,
  vwap: number,
  side: Side
): number {
  const close = last.c;
  const low = last.l;
  const high = last.h;
  const distPct = Math.abs((close - vwap) / vwap) * 100;

  if (side === "LONG") {
    // We like: price was above VWAP, dipped into/just below, closed back above/near.
    const taggedVWAP = low <= vwap && close >= vwap;
    if (taggedVWAP && distPct <= 0.1) return 1.0;
    if (taggedVWAP && distPct <= 0.3) return 0.9;
    if (taggedVWAP && distPct <= 0.5) return 0.7;
    return 0.4;
  } else {
    // SHORT: price was below VWAP, spiked into/just above, closed back below/near.
    const taggedVWAP = high >= vwap && close <= vwap;
    if (taggedVWAP && distPct <= 0.1) return 1.0;
    if (taggedVWAP && distPct <= 0.3) return 0.9;
    if (taggedVWAP && distPct <= 0.5) return 0.7;
    return 0.4;
  }
}

/**
 * Very simple VWAP pullback playbook:
 *  - Use last ~40 1-min bars.
 *  - Compute full-session VWAP over those bars.
 *  - LONG: trend up, price tags VWAP from above and closes near/above.
 *  - SHORT: trend down, price tags VWAP from below and closes near/below.
 */
function buildVWAPPullbackSignal(
  symbol: string,
  bars: AlpacaBar[]
): OutgoingSignal | null {
  if (bars.length < 30) return null;

  const vwap = computeVWAP(bars);
  if (!vwap || !Number.isFinite(vwap)) return null;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  const lastClose = last.c;
  const prevClose = prev.c;

  // If lastClose > prevClose, consider this a LONG attempt first
  const isBullishBar = lastClose > prevClose;
  const isBearishBar = lastClose < prevClose;

  // Liquidity: we assume WATCHLIST are all liquid — hardcode high
  const liquidityScore = 0.9;

  // Volume score from RVOL-style calc
  const volumeScore = computeVolumeScore(bars);

  // For now, assume no specific news/catalyst
  const catalystScore = 0.0;

  // Risk: 0.25% of price
  const riskPct = 0.25 / 100;

  if (isBullishBar) {
    // LONG VWAP pullback
    const side: Side = "LONG";

    const taggedVWAP = last.l <= vwap && last.c >= vwap;
    if (!taggedVWAP) {
      return null;
    }

    const trendScore = computeTrendScore(bars, side);
    const playbookScore = computeVWAPPullbackScore(last, vwap, side);

    const entryPrice = lastClose;
    const stopPrice = vwap * (1 - riskPct);
    const riskPerShare = entryPrice - stopPrice;
    if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) {
      return null;
    }

    const targetPrice = entryPrice + riskPerShare * 4; // 4R default

    return {
      ticker: symbol,
      side,
      entryPrice,
      stopPrice,
      targetPrice,
      reasoning:
        "VWAP pullback LONG: intraday uptrend, price pulled into VWAP and bounced with momentum.",
      source: "Alpaca-VWAP-Scan",
      trendScore,
      liquidityScore,
      playbookScore,
      volumeScore,
      catalystScore,
    };
  }

  if (isBearishBar) {
    // SHORT VWAP pullback
    const side: Side = "SHORT";

    const taggedVWAP = last.h >= vwap && last.c <= vwap;
    if (!taggedVWAP) {
      return null;
    }

    const trendScore = computeTrendScore(bars, side);
    const playbookScore = computeVWAPPullbackScore(last, vwap, side);

    const entryPrice = lastClose;
    const stopPrice = vwap * (1 + riskPct);
    const riskPerShare = stopPrice - entryPrice;
    if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) {
      return null;
    }

    const targetPrice = entryPrice - riskPerShare * 4; // 4R

    return {
      ticker: symbol,
      side,
      entryPrice,
      stopPrice,
      targetPrice,
      reasoning:
        "VWAP pullback SHORT: intraday downtrend, price popped into VWAP and rejected with momentum.",
      source: "Alpaca-VWAP-Scan",
      trendScore,
      liquidityScore,
      playbookScore,
      volumeScore,
      catalystScore,
    };
  }

  // If bar is basically doji / no direction, skip
  return null;
}

async function postSignalsToBackend(signals: OutgoingSignal[]) {
  if (!signals.length) return { ok: true, posted: 0 };

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_BASE_URL || "http://localhost:3000";

  const res = await fetch(`${baseUrl}/api/signals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signals),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("POST /api/signals from /api/scan failed:", text);
    throw new Error(`Failed to POST signals: ${res.status}`);
  }

  const json = await res.json().catch(() => ({}));
  return { ok: true, posted: signals.length, response: json };
}

// --- Route handler ------------------------------------------------------

/**
 * GET /api/scan
 *
 * For each symbol in WATCHLIST:
 *  - Fetch recent 1-min bars from Alpaca
 *  - Evaluate VWAP pullback playbook
 *  - Generate at most one OutgoingSignal per symbol
 *  - POST signals into /api/signals (which will compute A+ score)
 */
export async function GET() {
  try {
    const signals: OutgoingSignal[] = [];

    for (const symbol of WATCHLIST) {
      try {
        const bars = await fetchRecentBars(symbol, "1Min", 60);
        const signal = buildVWAPPullbackSignal(symbol, bars);
        if (signal) {
          signals.push(signal);
        }
      } catch (err) {
        console.error(`Error scanning ${symbol}`, err);
      }
    }

    const postResult = await postSignalsToBackend(signals);

    return NextResponse.json(
      {
        status: "ok",
        watchlist: WATCHLIST,
        generatedCount: signals.length,
        postedCount: postResult.posted,
        signals,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("GET /api/scan error", err);
    return NextResponse.json(
      {
        status: "error",
        message:
          err?.message ||
          "Failed to scan market. Check Alpaca keys and server logs.",
      },
      { status: 500 }
    );
  }
}
