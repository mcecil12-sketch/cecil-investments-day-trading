// app/api/scan/route.ts
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { AlpacaBar, fetchRecentBars } from "@/lib/alpaca";
import { bumpFunnel } from "@/lib/funnelMetrics";

const DEFAULT_WATCHLIST = ["SPY", "QQQ", "TSLA", "NVDA", "META", "AMD"];

type ScanMode = "vwap" | "breakout" | "compression" | "premarket-vwap" | "ai-seed"; // keep in sync with existing union

type PatternType =
  | "VWAP_PULLBACK"
  | "BREAKOUT"
  | "COMPRESSION"
  | "PREMARKET_VWAP"
  | "AI_SEED";

type Side = "LONG" | "SHORT";

interface PatternFeatures {
  vwapDistancePct?: number;
  pullbackPct?: number;
  breakoutStrength?: number;
  compressionScore?: number;
  premarketGapPct?: number;
  avgVol?: number;
}

interface CandidateSignal {
  ticker: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  patternType: PatternType;
  mode: ScanMode;
  features: PatternFeatures;
  patternScore: number;
  reasoning?: string;
  source?: string;
}

/**
 * Turn raw pattern features into a single numeric score.
 * This is intentionally simple – GPT will still do the heavy lifting.
 */
function scorePattern(pattern: PatternType, f: PatternFeatures): number {
  let score = 0;

  switch (pattern) {
    case "VWAP_PULLBACK": {
      const d = f.vwapDistancePct ?? 0;
      const p = f.pullbackPct ?? 0;
      score += Math.max(0, 10 - Math.abs(d) * 50);
      score += Math.max(0, p * 50);
      break;
    }
    case "BREAKOUT": {
      const b = f.breakoutStrength ?? 0;
      score += b * 100;
      break;
    }
    case "COMPRESSION": {
      const c = f.compressionScore ?? 0;
      score += c * 100;
      break;
    }
    case "PREMARKET_VWAP": {
      const g = f.premarketGapPct ?? 0;
      score += Math.max(0, Math.abs(g) * 50);
      break;
    }
    case "AI_SEED": {
      // Use volume as a simple proxy for quality; higher is better
      const vol = f.avgVol ?? 0;
      score += Math.max(0, vol);
      break;
    }
  }

  return score;
}

// Default filters tuned to surface more candidates by easing price/volume gates.
const DEFAULT_MIN_PRICE = 3;
const DEFAULT_MIN_AVG_VOLUME = 300_000;
const DEFAULT_LIMIT = 600;
const MAX_SIGNALS_PER_SCAN = 50;

function getBaseUrlFromEnv(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/+$/, "")}`;
  }
  return "http://localhost:3000";
}

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
  process.env.NEXT_PUBLIC_BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

type OutgoingSignal = {
  ticker: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  reasoning: string;
  source: string;
  mode: ScanMode;
  rawMeta?: Record<string, any>;
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

function toOutgoing(candidate: CandidateSignal): OutgoingSignal {
  const { ticker, side, entryPrice, stopPrice, targetPrice, patternType, mode, reasoning, source } =
    candidate;
  return {
    ticker,
    side,
    entryPrice,
    stopPrice,
    targetPrice,
    reasoning:
      reasoning ??
      `${patternType} candidate scored ${candidate.patternScore.toFixed(2)} in ${mode} mode.`,
    source: source ?? `scan:${patternType.toLowerCase()}`,
    mode,
    rawMeta: {
      patternType,
      patternScore: candidate.patternScore,
      features: candidate.features,
    },
  };
}

// Feature extractors — fewer hard gates, compute continuous pattern signals
function detectVwapPullbackFeatures(bars: AlpacaBar[]) {
  if (bars.length < 10) return null;
  const last = bars[bars.length - 1];
  const first = bars[0];
  const vwap = computeVWAP(bars);
  const distancePct = ((last.c - vwap) / vwap) * 100;
  const pullbackPct = Math.abs(vwap - last.c) / vwap;
  const trendUp = last.c > first.c * 1.002; // very light trend check

  if (!trendUp) return null;

  const entryPrice = last.c;
  const stopPrice = entryPrice * 0.99;
  const targetPrice = entryPrice * 1.02;

  return {
    side: "LONG" as const,
    entryPrice,
    stopPrice,
    targetPrice,
    vwapDistancePct: distancePct,
    pullbackPct,
  };
}

function detectBreakoutFeatures(bars: AlpacaBar[]) {
  if (bars.length < 20) return null;
  const last = bars[bars.length - 1];
  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v);
  const lookback = 15;
  const recentCloses = closes.slice(-lookback);
  const recentVols = vols.slice(-lookback);
  const maxClose = Math.max(...recentCloses);
  const avgVol = recentVols.reduce((sum, v) => sum + v, 0) / Math.max(1, recentVols.length);

  const breakoutStrength =
    Math.max(0, (last.c - maxClose) / maxClose) + Math.max(0, last.v / avgVol - 1);

  const entryPrice = last.c;
  const stopPrice = entryPrice * 0.985;
  const targetPrice = entryPrice * 1.03;

  return {
    side: "LONG" as const,
    entryPrice,
    stopPrice,
    targetPrice,
    breakoutStrength,
  };
}

function detectCompressionFeatures(bars: AlpacaBar[]) {
  if (bars.length < 10) return null;
  const last7 = bars.slice(-7);
  const ranges = last7.map((b) => b.h - b.l);
  const lastRange = ranges[ranges.length - 1];
  const avgRange = ranges.reduce((sum, r) => sum + r, 0) / Math.max(1, ranges.length);
  const compressionScore = lastRange > 0 ? avgRange / lastRange : 0;

  const last = last7[last7.length - 1];
  const entryPrice = last.c;
  const stopPrice = entryPrice * 0.99;
  const targetPrice = entryPrice * 1.02;

  return {
    side: "LONG" as const,
    entryPrice,
    stopPrice,
    targetPrice,
    compressionScore,
  };
}

function detectPremarketVwapFeatures(bars: AlpacaBar[]) {
  if (bars.length < 20) return null;
  const last = bars[bars.length - 1];
  const vwap = computeVWAP(bars);
  const distancePct = ((last.c - vwap) / vwap) * 100;
  const premarketGapPct = bars[0]?.o
    ? ((last.c - bars[0].o) / bars[0].o) * 100
    : distancePct;

  const entryPrice = last.c;
  const stopPrice = entryPrice * 0.99;
  const targetPrice = entryPrice * 1.02;

  return {
    side: "LONG" as const,
    entryPrice,
    stopPrice,
    targetPrice,
    premarketGapPct,
  };
}

function detectAiSeedCandidate(symbol: string, bars: AlpacaBar[]): CandidateSignal | null {
  if (!bars || bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const avgVol = bars.reduce((sum, b) => sum + b.v, 0) / Math.max(1, bars.length);
  const entryPrice = last.c;
  const stopPrice = entryPrice * 0.99;
  const targetPrice = entryPrice * 1.02;
  const features: PatternFeatures = { avgVol };
  return {
    ticker: symbol,
    side: "LONG",
    entryPrice,
    stopPrice,
    targetPrice,
    patternType: "AI_SEED",
    mode: "ai-seed",
    features,
    patternScore: scorePattern("AI_SEED", features),
    reasoning: "AI seed candidate based on liquidity.",
    source: "scan:ai-seed",
  };
}

// --- Main handler ------------------------------------------------------------

export async function GET(req: Request) {
  const url = new URL(req.url);
  const search = url.searchParams;

  bumpFunnel({ scansRun: 1 });

  const hdrs = headers();
  const authCookie = hdrs.get("cookie") || "";
  const baseUrl = getBaseUrlFromEnv();

  const rawMode = (search.get("mode") || "").toLowerCase();
  const mode: ScanMode =
    rawMode === "breakout"
      ? "breakout"
      : rawMode === "compression" || rawMode === "nr7"
      ? "compression"
      : rawMode === "premarket" || rawMode === "premarket-vwap"
      ? "premarket-vwap"
      : rawMode === "ai-seed"
      ? "ai-seed"
      : "vwap"; // default/alias for vwap

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

  let candidates: CandidateSignal[] = [];
  let postedCount = 0;

  for (let i = 0; i < slicedUniverse.length; i += chunkSize) {
    const chunk = slicedUniverse.slice(i, i + chunkSize);

    const promises: Promise<CandidateSignal | null>[] = chunk.map(async (symbol) => {
      try {
        const bars = await fetchRecentBars(symbol, "1Min", 60);
        if (!bars || bars.length === 0) return null;

        const last = bars[bars.length - 1];
        const avgVol = bars.reduce((sum, b) => sum + b.v, 0) / bars.length || 0;

        if (last.c < minPrice) return null;
        if (avgVol < minVolume) return null;

        if (mode === "vwap") {
          const res = detectVwapPullbackFeatures(bars);
          if (res && res.entryPrice && res.stopPrice && res.targetPrice && res.side) {
            const features: PatternFeatures = {
              vwapDistancePct: res.vwapDistancePct,
              pullbackPct: res.pullbackPct,
            };
            const patternScore = scorePattern("VWAP_PULLBACK", features);
            return {
              ticker: symbol,
              side: res.side,
              entryPrice: res.entryPrice,
              stopPrice: res.stopPrice,
              targetPrice: res.targetPrice,
              patternType: "VWAP_PULLBACK" as const,
              mode,
              features,
              patternScore,
            };
          }
        } else if (mode === "breakout") {
          const res = detectBreakoutFeatures(bars);
          if (res && res.entryPrice && res.stopPrice && res.targetPrice && res.side) {
            const features: PatternFeatures = { breakoutStrength: res.breakoutStrength };
            const patternScore = scorePattern("BREAKOUT", features);
            return {
              ticker: symbol,
              side: res.side,
              entryPrice: res.entryPrice,
              stopPrice: res.stopPrice,
              targetPrice: res.targetPrice,
              patternType: "BREAKOUT" as const,
              mode,
              features,
              patternScore,
            };
          }
        } else if (mode === "compression") {
          const res = detectCompressionFeatures(bars);
          if (res && res.entryPrice && res.stopPrice && res.targetPrice && res.side) {
            const features: PatternFeatures = { compressionScore: res.compressionScore };
            const patternScore = scorePattern("COMPRESSION", features);
            return {
              ticker: symbol,
              side: res.side,
              entryPrice: res.entryPrice,
              stopPrice: res.stopPrice,
              targetPrice: res.targetPrice,
              patternType: "COMPRESSION" as const,
              mode,
              features,
              patternScore,
            };
          }
        } else if (mode === "premarket-vwap") {
          const res = detectPremarketVwapFeatures(bars);
          if (res && res.entryPrice && res.stopPrice && res.targetPrice && res.side) {
            const features: PatternFeatures = { premarketGapPct: res.premarketGapPct };
            const patternScore = scorePattern("PREMARKET_VWAP", features);
            return {
              ticker: symbol,
              side: res.side,
              entryPrice: res.entryPrice,
              stopPrice: res.stopPrice,
              targetPrice: res.targetPrice,
              patternType: "PREMARKET_VWAP" as const,
              mode,
              features,
              patternScore,
            };
          }
        } else if (mode === "ai-seed") {
          const candidate = detectAiSeedCandidate(symbol, bars);
          if (candidate) return candidate;
        }
        return null;
      } catch (err) {
        console.error("[SCAN] Error scanning symbol", symbol, err);
        return null;
      }
    });

    const results = await Promise.all(promises);
    candidates.push(...results.filter((s): s is CandidateSignal => s != null));

    if (i + chunkSize < slicedUniverse.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Sort by pattern strength and take top N, dropping zero/negative scores
  candidates.sort((a, b) => b.patternScore - a.patternScore);
  const filtered = candidates.filter((c) => c.patternScore > 0);
  const topCandidates = filtered.slice(0, MAX_SIGNALS_PER_SCAN);

  const posted: OutgoingSignal[] = [];
  for (const candidate of topCandidates) {
    try {
      const payload = toOutgoing(candidate);
      const res = await fetch(`${baseUrl}/api/signals`, {
        method: "POST",
        body: JSON.stringify(payload),
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          cookie: authCookie,
        },
      });

      if (!res.ok) {
        console.error(
          "[SCAN] Failed to POST signal",
          candidate.ticker,
          res.status,
          await res.text()
        );
        continue;
      }

      postedCount += 1;
      posted.push(payload);
    } catch (err) {
      console.error("[SCAN] Failed posting candidate", candidate.ticker, err);
    }
  }

  const result = {
    status: "ok",
    mode,
    universeSize: universe.length,
    scannedCount: slicedUniverse.length,
    candidateCount: candidates.length,
    postedCount,
    sample: topCandidates.slice(0, 5),
  };

  if (result.candidateCount) {
    bumpFunnel({ candidatesFound: result.candidateCount });
  }

  if (result.postedCount) {
    bumpFunnel({ signalsPosted: result.postedCount });
  }

  return NextResponse.json({
    ...result,
    scansRun: 1,
    candidatesFound: candidates.length,
    signalsPosted: posted.length,
    gptQueued: posted.length,
  });
}
