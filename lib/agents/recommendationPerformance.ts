import { prisma } from "@/lib/prisma";
import { getPriceHistory, getSp500Series, type PricePoint } from "@/lib/agents/marketData";
import { computeReturn } from "@/lib/agents/technicals";
import { convictionMidpoint, resolvePortfolioBaseValue } from "@/lib/agents/positionSizing";

export interface PickQualityPoint {
  date: Date;
  /** Equal-weighted average of each active recommendation's own price return since its recommendedAt — no position sizing. Null if no symbol had price data at this date. */
  pickReturn: number | null;
  /** Average of the S&P 500's return over each active recommendation's own window (same start/end dates as its pick return), so the comparison is apples-to-apples per pick. */
  spxReturn: number | null;
  activeCount: number;
}

export interface SimulatedPortfolioPoint {
  date: Date;
  portfolioValue: number;
  pnl: number;
  pnlPct: number;
  /** Number of positions with a priced return contributing to this point's P&L. */
  activeCount: number;
}

export interface RecommendationPerformanceResult {
  pickQuality: PickQualityPoint[];
  simulatedPortfolio: SimulatedPortfolioPoint[];
  baseValue: number;
  trackedSince: Date | null;
  totalRecommendations: number;
}

function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Latest close at or before `date` from a points array (sorted ascending internally). */
function closeOnOrBefore(points: PricePoint[], date: Date): number | null {
  const sorted = [...points].sort((a, b) => a.date.getTime() - b.date.getTime());
  let found: number | null = null;
  for (const p of sorted) {
    if (p.date.getTime() > date.getTime()) break;
    found = p.close;
  }
  return found;
}

function returnOverWindow(points: PricePoint[], fromDate: Date, toDate: Date): number | null {
  const startClose = closeOnOrBefore(points, fromDate);
  const endClose = closeOnOrBefore(points, toDate);
  if (startClose == null || endClose == null) return null;
  return computeReturn(startClose, endClose);
}

/**
 * Builds both Dashboard "Recommendation Performance" views from
 * CandidateRecommendationLog and existing market data — no new scoring
 * logic, purely a read-only aggregation over already-logged rows.
 *
 * View 1 (pick quality): each logged recommendation's own price return
 * since its recommendedAt, averaged equal-weighted across every
 * recommendation active as of a given date, vs the S&P 500's return over
 * that same per-recommendation window.
 *
 * View 2 (simulated portfolio): a paper portfolio anchored to the real
 * "Total Portfolio Value" (see resolvePortfolioBaseValue) where each
 * recommendation gets a slice sized at the midpoint of its conviction
 * band, held from its recommendedAt forward.
 *
 * Tracking starts at each recommendation's own recommendedAt — no
 * backfilling or estimating pre-recommendation performance.
 */
export async function getRecommendationPerformance(
  totalCurrentValue?: number | null,
): Promise<RecommendationPerformanceResult> {
  const baseValue = resolvePortfolioBaseValue(totalCurrentValue);
  const rows = await prisma.candidateRecommendationLog.findMany({
    orderBy: { recommendedAt: "asc" },
  });

  if (rows.length === 0) {
    return {
      pickQuality: [],
      simulatedPortfolio: [],
      baseValue,
      trackedSince: null,
      totalRecommendations: 0,
    };
  }

  const uniqueSymbols = [...new Set(rows.map((r) => r.symbol))];
  const priceBySymbol = new Map<string, PricePoint[]>();
  await Promise.all(
    uniqueSymbols.map(async (symbol) => {
      try {
        const { points } = await getPriceHistory(symbol);
        priceBySymbol.set(symbol, points);
      } catch {
        // Skip — this symbol just won't contribute to the aggregate until its price history is fetchable again.
      }
    }),
  );

  const spxPoints = await getSp500Series();

  const earliestRecommendedAt = toUtcMidnight(rows[0].recommendedAt);
  const timeline = spxPoints
    .map((p) => toUtcMidnight(p.date))
    .filter((d) => d.getTime() >= earliestRecommendedAt.getTime());

  const today = toUtcMidnight(new Date());
  if (timeline.length === 0 || timeline[timeline.length - 1].getTime() < today.getTime()) {
    timeline.push(today);
  }

  const pickQuality: PickQualityPoint[] = [];
  const simulatedPortfolio: SimulatedPortfolioPoint[] = [];

  for (const date of timeline) {
    const activeRows = rows.filter((r) => toUtcMidnight(r.recommendedAt).getTime() <= date.getTime());
    if (activeRows.length === 0) continue;

    const pickReturns: number[] = [];
    const spxReturns: number[] = [];
    let pnl = 0;
    let sizedCount = 0;

    for (const row of activeRows) {
      const points = priceBySymbol.get(row.symbol);
      const stockReturn = points ? returnOverWindow(points, row.recommendedAt, date) : null;
      const spxReturn = returnOverWindow(spxPoints, row.recommendedAt, date);

      if (stockReturn != null) pickReturns.push(stockReturn);
      if (spxReturn != null) spxReturns.push(spxReturn);

      if (stockReturn != null) {
        const allocation = convictionMidpoint(row.score) * baseValue;
        pnl += allocation * stockReturn;
        sizedCount += 1;
      }
    }

    pickQuality.push({
      date,
      pickReturn: pickReturns.length > 0 ? average(pickReturns) : null,
      spxReturn: spxReturns.length > 0 ? average(spxReturns) : null,
      activeCount: activeRows.length,
    });

    simulatedPortfolio.push({
      date,
      portfolioValue: baseValue + pnl,
      pnl,
      pnlPct: pnl / baseValue,
      activeCount: sizedCount,
    });
  }

  return {
    pickQuality,
    simulatedPortfolio,
    baseValue,
    trackedSince: rows[0].recommendedAt,
    totalRecommendations: rows.length,
  };
}
