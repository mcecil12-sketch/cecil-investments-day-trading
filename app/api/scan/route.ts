import { NextResponse } from "next/server";
import { fetchRecentBars, AlpacaBar } from "@/lib/alpaca";

const DEFAULT_WATCHLIST = ["SPY", "QQQ", "TSLA", "NVDA", "META", "AMD"];
const CHUNK_SIZE = 25;
const CHUNK_DELAY_MS = 400;

type Side = "LONG" | "SHORT";

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

type AlpacaAsset = {
  symbol: string;
  status: string;
  tradable: boolean;
  class?: string;
  easy_to_borrow?: boolean;
  marginable?: boolean;
  shortable?: boolean;
};

const ALPACA_ASSETS_URL =
  (process.env.ALPACA_BASE_URL ||
    process.env.ALPACA_PAPER_BASE_URL ||
    "https://paper-api.alpaca.markets/v2") + "/assets?status=active&asset_class=us_equity";

async function fetchAssets(): Promise<string[]> {
  try {
    const res = await fetch(ALPACA_ASSETS_URL, {
      headers: {
        "APCA-API-KEY-ID":
          process.env.ALPACA_API_KEY_ID || process.env.ALPACA_KEY_ID || "",
        "APCA-API-SECRET-KEY":
          process.env.ALPACA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY || "",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("[SCAN] failed to fetch assets", res.status, text);
      return DEFAULT_WATCHLIST;
    }
    const assets = (await res.json()) as AlpacaAsset[];
    return assets
      .filter(
        (a) =>
          a.tradable &&
          a.status === "active" &&
          (a.class ?? "").toLowerCase() === "us_equity"
      )
      .map((a) => a.symbol.toUpperCase());
  } catch (err) {
    console.error("[SCAN] assets fetch error", err);
    return DEFAULT_WATCHLIST;
  }
}

function typicalPrice(bar: AlpacaBar): number {
  return (bar.h + bar.l + bar.c) / 3;
}

function computeVWAP(bars: AlpacaBar[]): number {
  let sumPV = 0;
  let sumVol = 0;

  for (const b of bars) {
    const tp = typicalPrice(b);
    const vol = b.v ?? 0;
    sumPV += tp * vol;
    sumVol += vol;
  }

  if (sumVol === 0) return bars[bars.length - 1]?.c ?? 0;
  return sumPV / sumVol;
}

function avgVolume(bars: AlpacaBar[]): number {
  if (!bars.length) return 0;
  const total = bars.reduce((acc, b) => acc + (b.v ?? 0), 0);
  return total / bars.length;
}

function detectPullbackSignalsForSymbol(symbol: string, bars: AlpacaBar[]): OutgoingSignal[] {
  const signals: OutgoingSignal[] = [];

  if (!bars || bars.length < 20) {
    return signals;
  }

  const vwap = computeVWAP(bars);
  const lastBar = bars[bars.length - 1];
  const firstBar = bars[0];

  const lastPrice = lastBar.c;
  const firstPrice = firstBar.c;

  const avgVol = avgVolume(bars);
  const lastVol = lastBar.v ?? 0;

  const trendUp = lastPrice > firstPrice * 1.002;
  const trendDown = lastPrice < firstPrice * 0.998;

  const nearBand = 0.005;
  const diffFromVwap = Math.abs(lastPrice - vwap) / vwap;
  const nearVwap = diffFromVwap <= nearBand;

  const volPickup = avgVol > 0 ? lastVol / avgVol : 1;

  // LONG idea
  if (trendUp && nearVwap && volPickup >= 0.7) {
    const entryPrice = lastPrice;
    const stopPrice = entryPrice * 0.992;
    const targetPrice = entryPrice * 1.016;

    signals.push({
      ticker: symbol,
      side: "LONG",
      entryPrice,
      stopPrice,
      targetPrice,
      reasoning: `Uptrend with price pulling back near VWAP (diff ${(diffFromVwap * 100).toFixed(
        2
      )}%), volume: ${volPickup.toFixed(2)}x avg.`,
      source: "VWAP_PULLBACK",
      trendScore: trendUp ? 8 : 5,
      liquidityScore: 9,
      playbookScore: 8,
      volumeScore: volPickup >= 1 ? 8 : 6,
      catalystScore: 5,
    });
  }

  // SHORT idea
  if (trendDown && nearVwap && volPickup >= 0.7) {
    const entryPrice = lastPrice;
    const stopPrice = entryPrice * 1.008;
    const targetPrice = entryPrice * 0.984;

    signals.push({
      ticker: symbol,
      side: "SHORT",
      entryPrice,
      stopPrice,
      targetPrice,
      reasoning: `Downtrend with price bouncing near VWAP (diff ${(diffFromVwap * 100).toFixed(
        2
      )}%), volume: ${volPickup.toFixed(2)}x avg.`,
      source: "VWAP_PULLBACK",
      trendScore: trendDown ? 8 : 5,
      liquidityScore: 9,
      playbookScore: 8,
      volumeScore: volPickup >= 1 ? 8 : 6,
      catalystScore: 5,
    });
  }

  return signals;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET() {
  try {
    console.log("[SCAN] Starting VWAP pullback scan…");

    const universe = await fetchAssets();
    // basic prefilter: keep default watchlist plus any asset we fetched
    const symbols = Array.from(new Set([...DEFAULT_WATCHLIST, ...universe]));

    const allSignals: OutgoingSignal[] = [];
    let postedCount = 0;

    for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
      const chunk = symbols.slice(i, i + CHUNK_SIZE);

      for (const symbol of chunk) {
        try {
          const bars = await fetchRecentBars(symbol, "1Min", 60);
          if (!bars.length) continue;

          // volume/price prefilter from bars (last bar)
          const last = bars[bars.length - 1];
          const avgVol = avgVolume(bars);
          if (last.c < 5) continue;
          if (avgVol < 1_000_000) continue;

          const symbolSignals = detectPullbackSignalsForSymbol(symbol, bars);
          allSignals.push(...symbolSignals);
        } catch (err) {
          console.error("[SCAN] error on symbol", symbol, err);
        }
      }

      if (i + CHUNK_SIZE < symbols.length) {
        await sleep(CHUNK_DELAY_MS);
      }
    }

    for (const sig of allSignals) {
      try {
        await fetch(
          `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000"}/api/signals`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(sig),
          }
        );
        postedCount += 1;
      } catch (err) {
        console.error("[SCAN] Failed to POST signal for", sig.ticker, err);
      }
    }

    console.log("[SCAN] Completed. Generated:", allSignals.length, "Posted:", postedCount);

    return NextResponse.json({
      status: "ok",
      universeCount: symbols.length,
      generatedCount: allSignals.length,
      postedCount,
      signals: allSignals,
    });
  } catch (err) {
    console.error("[SCAN] Error while scanning:", err);
    return NextResponse.json(
      {
        status: "error",
        message: "Failed to run VWAP pullback scan",
      },
      { status: 500 }
    );
  }
}
