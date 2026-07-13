import { prisma } from "@/lib/prisma";
import type { ImportBatchStatus } from "@/lib/generated/prisma";
import { ensureSp500PriceCache } from "@/lib/benchmark/priceCache";
import { getPriceHistory, type PricePoint } from "@/lib/agents/marketData";

const USABLE_STATUSES: ImportBatchStatus[] = ["COMPLETE", "PARTIAL"];

export interface RelativeStrengthEntry {
  symbol: string;
  name: string | null;
  currentValue: number;
  currentPrice: number;
  /** 0-100, momentum (60%) + trend strength (40%). */
  score: number;
  /** score minus the S&P 500's score over the same window. */
  relativeScore: number;
  /** 52-week price return, e.g. 0.18 = +18%. */
  momentum: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  sma50: number | null;
  sma200: number | null;
  accountIds: string[];
}

export interface RelativeStrengthOutput {
  generatedAt: string;
  sp500: {
    score: number;
    momentum: number | null;
    aboveSma50: boolean | null;
    aboveSma200: boolean | null;
  };
  topHoldings: RelativeStrengthEntry[];
  underperformers: RelativeStrengthEntry[];
  candidates: RelativeStrengthEntry[];
  skipped: Array<{ symbol: string; reason: string }>;
}

interface ScoredSeries {
  currentPrice: number;
  momentum: number | null;
  sma50: number | null;
  sma200: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  score: number;
}

function computeReturn(startValue: number, endValue: number): number | null {
  if (!Number.isFinite(startValue) || startValue === 0) return null;
  return (endValue - startValue) / startValue;
}

function sma(points: PricePoint[], window: number): number | null {
  if (points.length < window) return null;
  const slice = points.slice(-window);
  return slice.reduce((sum, p) => sum + p.close, 0) / window;
}

/** Return over the ~52 weeks ending at the series' last point. */
function momentum52w(points: PricePoint[]): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const targetTime = last.date.getTime() - 364 * 24 * 60 * 60 * 1000;
  let start = points[0];
  for (const p of points) {
    if (p.date.getTime() <= targetTime) start = p;
    else break;
  }
  return computeReturn(start.close, last.close);
}

function momentumTo100(momentum: number | null): number {
  if (momentum == null) return 50;
  const clamped = Math.max(-0.5, Math.min(0.5, momentum));
  return (clamped + 0.5) * 100;
}

/** 0-100: half credit for trading above the 50-day SMA, half for the 200-day. Missing SMAs (short history) score neutral rather than penalized. */
function trendStrengthScore(currentPrice: number, sma50: number | null, sma200: number | null): number {
  const part50 = sma50 == null ? 25 : currentPrice > sma50 ? 50 : 0;
  const part200 = sma200 == null ? 25 : currentPrice > sma200 ? 50 : 0;
  return part50 + part200;
}

function scoreSeries(rawPoints: PricePoint[]): ScoredSeries {
  const points = [...rawPoints].sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = points[points.length - 1];
  const momentum = momentum52w(points);
  const sma50 = sma(points, 50);
  const sma200 = sma(points, 200);
  const trend = trendStrengthScore(last.close, sma50, sma200);
  const momentumScore = momentumTo100(momentum);
  const score = Math.max(0, Math.min(100, Math.round(momentumScore * 0.6 + trend * 0.4)));

  return {
    currentPrice: last.close,
    momentum,
    sma50,
    sma200,
    aboveSma50: sma50 == null ? null : last.close > sma50,
    aboveSma200: sma200 == null ? null : last.close > sma200,
    score,
  };
}

interface CurrentHolding {
  symbol: string;
  name: string | null;
  currentValue: number;
  accountIds: string[];
}

/**
 * Each account's latest usable snapshot, aggregated by instrument symbol
 * across accounts (a position held in two accounts nets to one entry).
 * Cash/money-market instruments are excluded — momentum and moving averages
 * aren't a meaningful signal for them.
 */
async function getCurrentHoldings(): Promise<CurrentHolding[]> {
  const accounts = await prisma.account.findMany();
  const byInstrument = new Map<
    string,
    { symbol: string; name: string | null; currentValue: number; accountIds: Set<string> }
  >();

  for (const account of accounts) {
    const batch = await prisma.importBatch.findFirst({
      where: { accountId: account.id, status: { in: USABLE_STATUSES } },
      orderBy: [{ asOfDate: "desc" }, { uploadedAt: "desc" }],
      select: { id: true },
    });
    if (!batch) continue;

    const holdings = await prisma.holding.findMany({
      where: { importBatchId: batch.id },
      include: { instrument: true },
    });

    for (const holding of holdings) {
      if (holding.instrument.type === "CASH") continue;
      const key = holding.instrument.symbol;
      const entry = byInstrument.get(key) ?? {
        symbol: key,
        name: holding.instrument.name,
        currentValue: 0,
        accountIds: new Set<string>(),
      };
      entry.currentValue += holding.currentValue;
      entry.accountIds.add(account.id);
      byInstrument.set(key, entry);
    }
  }

  return Array.from(byInstrument.values()).map((entry) => ({
    ...entry,
    accountIds: Array.from(entry.accountIds),
  }));
}

async function getSp500Series(): Promise<PricePoint[]> {
  await ensureSp500PriceCache();
  const rows = await prisma.benchmarkPrice.findMany({
    orderBy: { date: "desc" },
    take: 300,
  });
  return rows.map((row) => ({ date: row.date, close: row.close })).reverse();
}

/**
 * Scores every current holding 0-100 on momentum (60%) + trend strength vs.
 * its 50/200-day moving averages (40%), relative to the S&P 500 over the
 * same window, and buckets the results into top performers, underperformers,
 * and next-tier candidates to watch.
 */
export async function runRelativeStrengthAgent(): Promise<RelativeStrengthOutput> {
  const [sp500Points, holdings] = await Promise.all([getSp500Series(), getCurrentHoldings()]);
  const sp500 = scoreSeries(sp500Points);

  const scored: RelativeStrengthEntry[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];

  for (const holding of holdings) {
    try {
      const { points } = await getPriceHistory(holding.symbol);
      const s = scoreSeries(points);
      scored.push({
        symbol: holding.symbol,
        name: holding.name,
        currentValue: holding.currentValue,
        currentPrice: s.currentPrice,
        score: s.score,
        relativeScore: s.score - sp500.score,
        momentum: s.momentum,
        aboveSma50: s.aboveSma50,
        aboveSma200: s.aboveSma200,
        sma50: s.sma50,
        sma200: s.sma200,
        accountIds: holding.accountIds,
      });
    } catch (err) {
      skipped.push({ symbol: holding.symbol, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const sortedDesc = [...scored].sort((a, b) => b.score - a.score);
  const topHoldings = sortedDesc.slice(0, 3);
  const rest = sortedDesc.slice(3);
  const bottomCount = Math.min(3, rest.length);
  const underperformers = rest.slice(rest.length - bottomCount).reverse();
  const candidates = rest.slice(0, rest.length - bottomCount).slice(0, 3);

  return {
    generatedAt: new Date().toISOString(),
    sp500: {
      score: sp500.score,
      momentum: sp500.momentum,
      aboveSma50: sp500.aboveSma50,
      aboveSma200: sp500.aboveSma200,
    },
    topHoldings,
    underperformers,
    candidates,
    skipped,
  };
}
