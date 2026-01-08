// app/api/scan/route.ts
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { AlpacaBar, fetchRecentBars } from "@/lib/alpaca";
import { bumpScanRun, bumpScanSkip, bumpTodayFunnel } from "@/lib/funnelRedis";

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

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Default filters tuned to surface more candidates by easing price/volume gates.
const DEFAULT_MIN_PRICE = 3;
const DEFAULT_MIN_AVG_VOLUME = 300_000;
const DEFAULT_LIMIT = 600;
const MAX_SIGNALS_PER_SCAN = 50;
const AI_SEED_MIN_BARS = 20;

  const AI_SEED_OPENING_MINUTES = Number(process.env.AI_SEED_OPENING_MINUTES ?? 12);
  const AI_SEED_OPENING_PER_MIN_FLOOR_SHARES = Number(process.env.AI_SEED_OPENING_PER_MIN_FLOOR_SHARES ?? 25000);
  const AI_SEED_OPENING_ALLOW_SPIKE = String(process.env.AI_SEED_OPENING_ALLOW_SPIKE ?? "1") === "1";
  const AI_SEED_SPIKE_MULT = Number(process.env.AI_SEED_SPIKE_MULT ?? 2.0);
  const AI_SEED_GPT_LIMIT = Number(process.env.AI_SEED_GPT_LIMIT ?? 60);
  const AI_SEED_PRESCORE_MIN = Number(process.env.AI_SEED_PRESCORE_MIN ?? 0);

const AI_SEED_MIN_REL_VOL = 0.3;
const MIN_RANGE_PCT = Number(process.env.MIN_RANGE_PCT ?? 0.05);
const AI_SEED_MAX_VWAP_DISTANCE = 2;
const AI_SEED_MIN_TREND_DELTA = -0.005;
const MIN_AVG_VOL_SHARES = Number(process.env.MIN_AVG_VOL_SHARES ?? 600);
const MIN_AVG_DOLLAR_VOL = Number(process.env.MIN_AVG_DOLLAR_VOL ?? 500_000);

const AI_SEED_REQUIRE_SETUP = (process.env.AI_SEED_REQUIRE_SETUP ?? "0") === "1";
const AI_SEED_REQUIRE_RANGE = (process.env.AI_SEED_REQUIRE_RANGE ?? "0") === "1";
const AI_SEED_MAX_POST = Number(process.env.AI_SEED_MAX_POST ?? 20);
const AI_SEED_MAX_QUEUE = Number(process.env.AI_SEED_MAX_QUEUE ?? 10);

type RejectKey =
  | "volumeTooLow"
  | "dollarVolumeTooLow"
  | "liquidityTooLow"
  | "vwapTooFar"
  | "trendMismatch"
  | "missingBars"
  | "marketClosed"
  | "other";

type GateResult =
  | { ok: false; reason: RejectKey; note?: string }
  | { ok: true };

type BarDiagnostics = {
  barCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  avgVolume: number;
  volumeSum: number;
  ageMinutes: number | null;
};

function createRejectTracker(sampleLimit = 12) {
  const counts: Record<RejectKey, number> = {
    volumeTooLow: 0,
    dollarVolumeTooLow: 0,
    liquidityTooLow: 0,
    vwapTooFar: 0,
    trendMismatch: 0,
    missingBars: 0,
    marketClosed: 0,
    other: 0,
  };
  const samples: Array<{ ticker: string; reason: RejectKey; note?: string; bars?: BarDiagnostics }> = [];
  const seenTickers: string[] = [];
  let processedCount = 0;

  function bump(
    ticker: string,
    reason: RejectKey,
    note?: string,
    bars?: BarDiagnostics
  ) {
    counts[reason] = (counts[reason] ?? 0) + 1;
    if (samples.length < sampleLimit) {
      samples.push({ ticker, reason, note, bars });
    }
  }

  function trackTicker(ticker: string) {
    processedCount += 1;
    if (seenTickers.length < 12) seenTickers.push(ticker);
  }

  return {
    counts,
    samples,
    bump,
    trackTicker,
    get processedCount() {
      return processedCount;
    },
    get seenTickers() {
      return seenTickers;
    },
  };
}

function summarizeBars(bars?: AlpacaBar[]): BarDiagnostics {
  const arr = Array.isArray(bars) ? bars : [];
  const firstBar = arr[0];
  const lastBar = arr[arr.length - 1];
  const volumeSum = arr.reduce((sum, bar) => sum + (bar?.v ?? 0), 0);
  const avgVolume = arr.length ? volumeSum / arr.length : 0;
  const ageMinutes =
    lastBar && lastBar.t
      ? Math.max(0, (Date.now() - Date.parse(lastBar.t)) / 60000)
      : null;
  return {
    barCount: arr.length,
    firstTimestamp: firstBar?.t ?? null,
    lastTimestamp: lastBar?.t ?? null,
    avgVolume,
    volumeSum,
    ageMinutes,
  };
}

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

function evaluateAiSeedGates(bars: AlpacaBar[]): GateResult {
  if (!bars || bars.length === 0) {
    return { ok: false, reason: "missingBars" };
  }
  if (bars.length < AI_SEED_MIN_BARS) {
    return { ok: false, reason: "missingBars", note: `bars=${bars.length}` };
  }

  const last = bars[bars.length - 1];
  const avgVolShares = avg(bars.map((b) => Number(b.v ?? 0)));
  const avgDollarVol = avg(
    bars.map(
      (b) => Number(b.v ?? 0) * Number((b.vw ?? b.c ?? 0) || 0)
    )
  );
  const failsDollarVol = avgDollarVol < MIN_AVG_DOLLAR_VOL;
  const failsSharesVol = avgVolShares < MIN_AVG_VOL_SHARES;
  if (last.c < DEFAULT_MIN_PRICE) {
    return { ok: false, reason: "other", note: `price=${last.c.toFixed(2)}` };
  }
  if (failsSharesVol) {
    return {
      ok: false,
      reason: "volumeTooLow",
      note: `avgVolShares=${Math.round(avgVolShares)} minShares=${MIN_AVG_VOL_SHARES}`,
    };
  }
  if (failsDollarVol) {
    return {
      ok: false,
      reason: "dollarVolumeTooLow",
      note: `avgDollarVol=${Math.round(avgDollarVol)} minDollar=${MIN_AVG_DOLLAR_VOL}`,
    };
  }

  const relVol = avgVolShares > 0 ? last.v / avgVolShares : 0;
  if (relVol < AI_SEED_MIN_REL_VOL) {
    return { ok: false, reason: "liquidityTooLow", note: `relVol=${relVol.toFixed(2)}` };
  }

  const rangePct = ((last.h - last.l) / last.c) * 100;
  if (rangePct < MIN_RANGE_PCT * 100 && AI_SEED_REQUIRE_RANGE) {
    return { ok: false, reason: "other", note: `rangePct=${rangePct.toFixed(2)}` };
  }

  const vwap = computeVWAP(bars);
  if (vwap > 0) {
    const distPct = Math.abs((last.c - vwap) / vwap) * 100;
    if (distPct > AI_SEED_MAX_VWAP_DISTANCE) {
      return {
        ok: false,
        reason: "vwapTooFar",
        note: `vwDist=${distPct.toFixed(2)}`,
      };
    }
  }

  const prev = bars[bars.length - 2];
  if (prev && last.c - prev.c < AI_SEED_MIN_TREND_DELTA * prev.c) {
    const deltaPct = ((last.c - prev.c) / prev.c) * 100;
    return { ok: false, reason: "trendMismatch", note: `trend=${deltaPct.toFixed(2)}%` };
  }

  return { ok: true };
}

function detectAiSeedCandidate(
  symbol: string,
  bars: AlpacaBar[],
  reject: (ticker: string, reason: string, note?: string) => void
): CandidateSignal | null {
  const gate = evaluateAiSeedGates(bars);
  if (!gate.ok) {
    reject(symbol, gate.reason, gate.note);
    return null;
  }

  const last = bars[bars.length - 1];
  const avgVol = avg(bars.map((b) => Number(b.v ?? 0)));
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

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const search = url.searchParams;
  const scanSource = req.headers.get("x-scan-source") ?? "unknown";
  const scanRunId = req.headers.get("x-scan-run-id") ?? null;
  const scannerToken = req.headers.get("x-scanner-token") ?? "";

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
const aiSeedMode = mode === "ai-seed";
const debugScan = req.headers.get("x-debug-scan") === "1";
const totals = {
  totalCandidates: 0,
  candidatesAfterBasicFilters: 0,
  signalsCreated: 0,
  signalsPosted: 0,
};
const rejectsAggregated: Record<RejectKey, number> = {
  volumeTooLow: 0,
  dollarVolumeTooLow: 0,
  liquidityTooLow: 0,
  vwapTooFar: 0,
  trendMismatch: 0,
  missingBars: 0,
  marketClosed: 0,
  other: 0,
};
const aiSeedTracker = createRejectTracker(40);

const mapReasonToKey = (reason: string): RejectKey => {
  switch (reason) {
    case "volumeTooLow":
    case "dollarVolumeTooLow":
    case "liquidityTooLow":
    case "vwapTooFar":
    case "trendMismatch":
    case "missingBars":
    case "marketClosed":
    case "other":
      return reason as RejectKey;
    case "noBars":
    case "missingBarFields":
      return "missingBars";
    default:
      return "other";
  }
};

function clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n));
  }

  function computePreScore(args: {
    relVol: number;
    distToVwapPct: number;
    vwapSlopePct: number;
    atrPct: number;
    spreadAbs: number;
    price: number;
  }) {
    const relVolScore = clamp((args.relVol / 5) * 30, 0, 30);
    const vwapProxScore = clamp((1 - Math.min(Math.abs(args.distToVwapPct), 2.0) / 2.0) * 25, 0, 25);
    const trendScore = clamp((Math.max(args.vwapSlopePct, 0) / 0.25) * 20, 0, 20);
    const volScore = clamp((Math.min(args.atrPct, 6) / 6) * 15, 0, 15);
    const spreadScore = clamp((1 - Math.min(args.spreadAbs, 0.6) / 0.6) * 10, 0, 10);
    const priceBonus =
      args.price >= 10 && args.price <= 150 ? 5 : args.price >= 5 ? 2 : 0;
    const score = relVolScore + vwapProxScore + trendScore + volScore + spreadScore + priceBonus;
    return Math.round(score);
  }

  function minutesSinceOpenFromBars(bars: any[]) {
    if (!bars || !bars.length) return 999;
    const first = bars[0];
    const last = bars[bars.length - 1];
    const t0 = new Date(first.t).getTime();
    const t1 = new Date(last.t).getTime();
        if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) return 999;
    return Math.floor((t1 - t0) / 60000);
  }

const reject = (
  ticker: string,
  reason: string,
  note?: string,
  bars?: BarDiagnostics
) => {
  if (!aiSeedMode) return;
  const key = mapReasonToKey(reason);
  aiSeedTracker.bump(ticker, key, note, bars);
  rejectsAggregated[key] = (rejectsAggregated[key] ?? 0) + 1;
};

const buildSummary = () => {
  if (!aiSeedMode) return null;
  return {
    mode,
    source: scanSource,
    runId: scanRunId,
    totals,
    rejects: rejectsAggregated,
    signalsCreated: totals.signalsCreated,
    signalsPosted: totals.signalsPosted,
    rejectSamples: aiSeedTracker.samples,
  };
};

const logSummary = () => {
  const summary = buildSummary();
  if (!summary) return null;
  console.log("[scan] ai-seed summary", summary);
  return summary;
};

  if (aiSeedMode) {
    // Market-aware: don’t run ai-seed off-hours when minute bars go thin
    const clockUrl = `${ALPACA_BASE_URL.replace(/\/+$/, "")}/v2/clock`;
    const clock = await fetch(clockUrl, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
      },
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    if ((clock && clock.is_open === false) && !(debugScan && (search.get("force") === "1"))) {
      try {
        await bumpScanSkip(mode, {
          source: scanSource,
          runId: scanRunId,
        });
      } catch (err) {
        console.log("[funnel] bump scansSkipped failed (non-fatal)", err);
      }
      reject("market", "marketClosed", "market closed (skip)");
      const summarySnapshot = logSummary();
      const skipPayload: Record<string, any> = {
        status: "ok",
        mode,
        marketClosed: true,
        note: "ai-seed skipped: market closed (avoid false volumeTooLow after-hours)",
        clock,
      };
      if (debugScan && summarySnapshot) {
        skipPayload.debugSummary = summarySnapshot;
      }
      return NextResponse.json(skipPayload, { headers: { "Cache-Control": "no-store" } });
    }
  }

  await bumpScanRun(mode, {
    source: scanSource,
    runId: scanRunId,
  });

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
  let postDebug: any = null;

  for (let i = 0; i < slicedUniverse.length; i += chunkSize) {
    const chunk = slicedUniverse.slice(i, i + chunkSize);

    const promises: Promise<CandidateSignal | null>[] = chunk.map(async (symbol) => {
      try {
        if (aiSeedMode) {
          aiSeedTracker.trackTicker(symbol);
          totals.totalCandidates += 1;
        }
        const upper = symbol.toUpperCase();
        if (
  upper.includes(".") ||
  upper.endsWith("-WS") ||
  upper.endsWith("-W")  ||
  upper.endsWith("-U")  ||
  upper.endsWith("-R")
        ) {
          reject(symbol, "other", "ticker excluded before bars");
          return null;
        }
        const bars = await fetchRecentBars(symbol, "1Min", 60);
        const lastBar = bars?.[bars.length - 1];
        const barCount = bars?.length ?? 0;
        const barSummary = summarizeBars(bars);
        if (!bars || barCount < AI_SEED_MIN_BARS) {
          reject(
            symbol,
            "missingBars",
            `bars=${barCount} lastBar=${lastBar?.t ?? null}`,
            barSummary
          );
          return null;
        }

        if (
          aiSeedMode &&
          bars.some((b) => b == null || b.v == null || (b.vw == null && b.c == null))
        ) {
          reject(symbol, "missingBarFields", "missing v or (vw/c)", barSummary);
          return null;
        }

        const last = bars[bars.length - 1];
        const avgVol = bars.reduce((sum, b) => sum + b.v, 0) / bars.length || 0;

        if (last.c < minPrice) {
          reject(
            symbol,
            "other",
            `priceTooLow=${last.c.toFixed(2)} minPrice=${minPrice.toFixed(2)}`,
            barSummary
          );
          return null;
        }
        const totalVol = bars.reduce((sum, b) => sum + (b.v ?? 0), 0);
        const avgVolPerMin = bars.length ? totalVol / bars.length : 0;
        const avgVolShares = avgVolPerMin;
        const avgDollarVol = avgVolShares * last.c;
        if (aiSeedMode && avgVolPerMin < 50) {
          reject(
            symbol,
            "volumeTooLow",
            `avgVolShares=${Math.round(avgVolShares)} avgDollarVol=${Math.round(
              avgDollarVol
            )} minShares=${MIN_AVG_VOL_SHARES} minDollar=${MIN_AVG_DOLLAR_VOL}`,
            barSummary
          );
          return null;
        }

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
          const candidate = detectAiSeedCandidate(symbol, bars, reject);
          if (candidate) {
            totals.candidatesAfterBasicFilters += 1;
            return candidate;
          }
          if (AI_SEED_REQUIRE_SETUP) {
            reject(symbol, "notCandidate", "notCandidate");
            return null;
          }
          // Without strict setup enforcement, let GPT judge these candidates.
          return null;
        }
        return null;
      } catch (err) {
        const note =
          err instanceof Error
            ? err.message?.slice(0, 160)
            : typeof err === "string"
            ? err.slice(0, 160)
            : "unknown";
        reject(symbol, "exception", note);
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
  const minutesSinceOpen = minutesSinceOpenFromBars(candidates as any);
  const openingMode = minutesSinceOpen <= AI_SEED_OPENING_MINUTES;

  const enriched = candidates.map((c: any) => {
    const preScore = computePreScore({
      relVol: Number(c.relVol ?? 0),
      distToVwapPct: Number(c.distToVwapPct ?? 0),
      vwapSlopePct: Number(c.vwapSlopePct ?? 0),
      atrPct: Number(c.atrPct ?? 0),
      spreadAbs: Number(c.spreadAbs ?? 0),
      price: Number(c.price ?? 0),
    });
    return { ...c, preScore, openingMode, minutesSinceOpen };
  });

  const ranked = enriched
    .filter((c: any) => (c.preScore ?? 0) >= AI_SEED_PRESCORE_MIN)
    .sort((a: any, b: any) => (b.preScore ?? 0) - (a.preScore ?? 0))
    .slice(0, AI_SEED_GPT_LIMIT);

  candidates = ranked;

candidates.sort((a, b) => b.patternScore - a.patternScore);
  const filtered = candidates.filter((c) => c.patternScore > 0);
  const topCandidates = filtered.slice(0, 
    MAX_SIGNALS_PER_SCAN);

  const posted: OutgoingSignal[] = [];
  let postedSignals = 0;
  let queuedSignals = 0;
  for (const candidate of topCandidates) {
    if (aiSeedMode && (postedSignals >= AI_SEED_MAX_POST || queuedSignals >= AI_SEED_MAX_QUEUE)) {
      break;
    }
    try {
      if (aiSeedMode) {
        totals.signalsCreated += 1;
      }
      const payload = toOutgoing(candidate);
      const res = await fetch(`${baseUrl}/api/signals`, {
        method: "POST",
        body: JSON.stringify(payload),
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          cookie: authCookie,
          ...(scannerToken ? { "x-scanner-token": scannerToken } : {}),
        },
      });

      if (debugScan && postDebug == null) {
        try {
          const txt = await res.clone().text();
          postDebug = {
            url: `${baseUrl}/api/signals`,
            status: res.status,
            ok: res.ok,
            hasScannerToken: Boolean(scannerToken),
            bodyHead: (txt || "").slice(0, 600),
          };
        } catch (e) {
          postDebug = {
            url: `${baseUrl}/api/signals`,
            status: res.status,
            ok: res.ok,
            hasScannerToken: Boolean(scannerToken),
            bodyHead: "read_failed",
          };
        }
      }

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
      if (aiSeedMode) {
        postedSignals += 1;
        queuedSignals += 1;
        totals.signalsPosted += 1;
      }
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

  const aiSeedDebug =
    aiSeedMode
      ? {
          processedCount: aiSeedTracker.processedCount,
          seenTickers: aiSeedTracker.seenTickers,
          rejectCounts: aiSeedTracker.counts,
          rejectSamples: aiSeedTracker.samples,
        }
      : null;

  if (result.candidateCount) {
    await bumpTodayFunnel({ candidatesFound: result.candidateCount });
  }

  if (result.postedCount) {
    await bumpTodayFunnel({ signalsPosted: result.postedCount });
  }

  const summarySnapshot = logSummary();

  return NextResponse.json({
    ...result,
    scansRun: 1,
    candidatesFound: candidates.length,
    signalsPosted: posted.length,
    gptQueued: posted.length,
    aiSeedDebug,
    ...(debugScan && summarySnapshot ? { debugSummary: summarySnapshot } : {}),
  });
}

export async function POST(req: NextRequest) {
  
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const debug = req.headers.get("x-debug-scan") === "1";
return GET(req);
}
