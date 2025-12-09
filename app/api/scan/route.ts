// app/api/scan/route.ts
import { NextResponse } from "next/server";
import { AlpacaBar, fetchRecentBars } from "@/lib/alpaca";

const DEFAULT_WATCHLIST = ["SPY", "QQQ", "TSLA", "NVDA", "META", "AMD"];

type ScanMode = "pullback" | "breakout" | "compression" | "premarket-vwap";

const DEFAULT_MIN_PRICE = 5;
const DEFAULT_MIN_AVG_VOLUME = 1_000_000;
const DEFAULT_LIMIT = 400;

// Prefer both ID/SECRET envs; fall back to generic keys
const ALPACA_API_KEY =
  process.env.ALPACA_API_KEY ||
  process.env.ALPACA_API_KEY_ID ||
  process.env.ALPACA_KEY_ID ||
  "";
const ALPACA_SECRET_KEY =
  process.env.ALPACA_API_SECRET_KEY ||
  process.env.ALPACA_SECRET_KEY ||
  process.env.ALPACA_API_SECRET ||
  "";
const ALPACA_BASE_URL =
  process.env.ALPACA_BASE_URL ||
  process.env.ALPACA_PAPER_BASE_URL ||
  "https://paper-api.alpaca.markets";

const NEXT_PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

type Mode = "pullback" | "breakout" | "compression" | "premarket-vwap";

type OutgoingSignal = {
  ticker: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  reasoning: string;
  source: string;
  mode: Mode;
};

type AlpacaAsset = {
  symbol: string;
  status: string;
  tradable: boolean;
  class: string;
  asset_class?: string;
};

let universeCache: { symbols: string[]; fetchedAt: number } | null = null;
const UNIVERSE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function typicalPrice(bar: AlpacaBar): number {
  return (bar.h + bar.l + bar.c) / 3;
}

function computeVWAP(bars: AlpacaBar[]): number {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const tp = typicalPrice(b);
    pv += tp * b.v;
    v += b.v;
  }
  if (v === 0) return bars[bars.length - 1]?.c ?? 0;
  return pv / v;
}

async function fetchUniverseSymbols(): Promise<string[]> {
  const now = Date.now();
  if (universeCache && now - universeCache.fetchedAt < UNIVERSE_CACHE_TTL_MS) {
    return universeCache.symbols;
  }

  if (!ALPACA_API_KEY || !ALPACA_SECRET_KEY) {
    console.warn("[SCAN] Missing Alpaca credentials, using default watchlist only.");
    universeCache = {
      symbols: DEFAULT_WATCHLIST,
      fetchedAt: now,
    };
    return universeCache.symbols;
  }

  const url = `${ALPACA_BASE_URL}/v2/assets?status=active&asset_class=us_equity`;
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    console.error("[SCAN] Failed to fetch Alpaca assets", res.status, await res.text());
    universeCache = {
      symbols: DEFAULT_WATCHLIST,
      fetchedAt: now,
    };
    return universeCache.symbols;
  }

  const assets = (await res.json()) as AlpacaAsset[];
  const symbols = assets
    .filter(
      (a) =>
        a.tradable &&
        a.status === "active" &&
        ((a.class ?? a.asset_class ?? "") === "us_equity")
    )
    .map((a) => a.symbol);

  const merged = Array.from(new Set([...DEFAULT_WATCHLIST, ...symbols]));
  universeCache = { symbols: merged, fetchedAt: now };
  return merged;
}

// --- Mode-specific detectors -------------------------------------------------

function detectPullback(symbol: string, bars: AlpacaBar[]): OutgoingSignal | null {
  if (bars.length < 30) return null;
  const last = bars[bars.length - 1];
  const vwap = computeVWAP(bars);
  const distancePct = ((last.c - vwap) / vwap) * 100;

  const first = bars[0];
  const trendUp = last.c > first.c * 1.01; // >1% up over window

  const nearVwap = distancePct > -0.5 && distancePct < 0.5;

  if (!(trendUp && nearVwap)) return null;

  const entry = last.c;
  const riskPerShare = entry * 0.01; // 1% stop
  const stop = entry - riskPerShare;
  const target = entry + riskPerShare * 2; // 2R

  return {
    ticker: symbol,
    side: "LONG",
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    reasoning: `VWAP pullback in established uptrend. Price ~ VWAP (${distancePct.toFixed(
      2
    )}%) with higher highs over the last window.`,
    source: "scan:vwap-pullback",
    mode: "pullback",
  };
}

function detectBreakout(symbol: string, bars: AlpacaBar[]): OutgoingSignal | null {
  if (bars.length < 30) return null;
  const last = bars[bars.length - 1];

  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v);

  const lookback = 20;
  const recentCloses = closes.slice(-lookback);
  const recentVols = vols.slice(-lookback);

  const maxClose = Math.max(...recentCloses);
  const avgVol = recentVols.reduce((sum, v) => sum + v, 0) / recentVols.length || 0;

  const isBreakout = last.c >= maxClose * 0.999; // basically at new high
  const isHighVolume = last.v >= avgVol * 1.5;

  if (!(isBreakout && isHighVolume)) return null;

  const entry = last.c;
  const riskPerShare = entry * 0.015; // 1.5% stop
  const stop = entry - riskPerShare;
  const target = entry + riskPerShare * 3; // ~3R

  return {
    ticker: symbol,
    side: "LONG",
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    reasoning: "Breakout to new short-term high on elevated volume (≥ 1.5x average).",
    source: "scan:breakout",
    mode: "breakout",
  };
}

function detectCompression(symbol: string, bars: AlpacaBar[]): OutgoingSignal | null {
  if (bars.length < 10) return null;

  const last7 = bars.slice(-7);
  const ranges = last7.map((b) => b.h - b.l);
  const lastRange = ranges[ranges.length - 1];

  const smallest = ranges.every((r) => lastRange <= r);

  if (!smallest) return null;

  const last = last7[last7.length - 1];
  const vwap = computeVWAP(bars);
  const entry = last.c;
  const riskPerShare = entry * 0.01;
  const stop = entry - riskPerShare;
  const target = entry + riskPerShare * 2;

  return {
    ticker: symbol,
    side: "LONG",
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    reasoning:
      "NR7/inside-bar style compression: last bar has the tightest range of the last 7, sitting near VWAP.",
    source: "scan:compression",
    mode: "compression",
  };
}

function detectPremarketVWAP(symbol: string, bars: AlpacaBar[]): OutgoingSignal | null {
  if (bars.length < 20) return null;
  const last = bars[bars.length - 1];
  const vwap = computeVWAP(bars);
  const distancePct = ((last.c - vwap) / vwap) * 100;

  const nearVwap = distancePct > -0.5 && distancePct < 0.5;

  if (!nearVwap) return null;

  const entry = last.c;
  const riskPerShare = entry * 0.01;
  const stop = entry - riskPerShare;
  const target = entry + riskPerShare * 2;

  return {
    ticker: symbol,
    side: "LONG",
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    reasoning:
      "Pre-market VWAP alignment: price coiled around VWAP with potential for opening drive.",
    source: "scan:premarket-vwap",
    mode: "premarket-vwap",
  };
}

// --- Main handler ------------------------------------------------------------

export async function GET(req: Request) {
  const url = new URL(req.url);
  const search = url.searchParams;

  const rawMode = (search.get("mode") || "").toLowerCase();
  const mode: ScanMode =
    rawMode === "breakout"
      ? "breakout"
      : rawMode === "compression" || rawMode === "nr7"
      ? "compression"
      : rawMode === "premarket" || rawMode === "premarket-vwap"
      ? "premarket-vwap"
      : "pullback"; // default/alias for vwap

  const limit =
    Number(search.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  const minPrice =
    Number(search.get("minPrice") ?? DEFAULT_MIN_PRICE) || DEFAULT_MIN_PRICE;
  const minVolume =
    Number(search.get("minVolume") ?? DEFAULT_MIN_AVG_VOLUME) ||
    DEFAULT_MIN_AVG_VOLUME; // avg vol filter
  const chunkSize = Number(search.get("chunkSize") ?? "50");
  const delayMs = Number(search.get("delayMs") ?? "500");

  const universe = await fetchUniverseSymbols();
  const slicedUniverse = universe.slice(0, Math.max(1, Math.min(limit, universe.length)));

  let generated: OutgoingSignal[] = [];
  let postedCount = 0;

  for (let i = 0; i < slicedUniverse.length; i += chunkSize) {
    const chunk = slicedUniverse.slice(i, i + chunkSize);

    const promises = chunk.map(async (symbol) => {
      try {
        const bars = await fetchRecentBars(symbol, "1Min", 60);
        if (!bars || bars.length === 0) return null;

        const last = bars[bars.length - 1];
        const avgVol = bars.reduce((sum, b) => sum + b.v, 0) / bars.length || 0;

        if (last.c < minPrice) return null;
        if (avgVol < minVolume) return null;

        let signal: OutgoingSignal | null = null;

        switch (mode) {
          case "breakout":
            signal = detectBreakout(symbol, bars);
            break;
          case "compression":
            signal = detectCompression(symbol, bars);
            break;
          case "premarket-vwap":
            signal = detectPremarketVWAP(symbol, bars);
            break;
          case "pullback":
          default:
            signal = detectPullback(symbol, bars);
            break;
        }

        if (!signal) return null;

        // Post into /api/signals so AI scoring & storage run as usual
        const res = await fetch(`${NEXT_PUBLIC_BASE_URL}/api/signals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signal),
          cache: "no-store",
        });

        if (!res.ok) {
          console.error(
            "[SCAN] Failed to POST signal",
            symbol,
            res.status,
            await res.text()
          );
          return null;
        }

        postedCount += 1;
        return signal;
      } catch (err) {
        console.error("[SCAN] Error scanning symbol", symbol, err);
        return null;
      }
    });

    const results = await Promise.all(promises);
    generated.push(...results.filter((s): s is OutgoingSignal => !!s));

    if (i + chunkSize < slicedUniverse.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return NextResponse.json({
    status: "ok",
    mode,
    universeSize: universe.length,
    scannedCount: slicedUniverse.length,
    generatedCount: generated.length,
    postedCount,
    signals: generated,
  });
}
