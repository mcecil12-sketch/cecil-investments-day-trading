import { prisma } from "@/lib/prisma";
import { getPriceHistory, getSp500Series, type PricePoint } from "@/lib/agents/marketData";
import { computeReturn } from "@/lib/agents/technicals";
import { convictionMidpoint, resolvePortfolioBaseValue } from "@/lib/agents/positionSizing";

export interface PickQualityPoint {
  date: Date;
  /** Equal-weighted average of each active position's own price return since its entryDate — no position sizing. Null if no symbol had price data at this date. */
  pickReturn: number | null;
  /** Average of the S&P 500's return over each active position's own window (same start/end dates as its pick return), so the comparison is apples-to-apples per pick. */
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
  totalPositions: number;
}

interface LogRow {
  symbol: string;
  batchTag: string;
  recommendedAt: Date;
  score: number;
}

interface WeeklyBatch {
  batchTag: string;
  date: Date;
  rowsBySymbol: Map<string, { score: number }>;
}

export interface TrackedPosition {
  symbol: string;
  entryDate: Date;
  /** Score at entry — sizing stays anchored to this for the whole holding period, even if a later weekly re-appearance carries a different score. */
  entryScore: number;
  /** null while the position is still open (currently present, or within its one-week absence grace period). */
  exitDate: Date | null;
}

/**
 * Collapses raw CandidateRecommendationLog rows into one row per
 * (batchTag, symbol) — same-day reruns of the Candidate Scanner log
 * duplicate rows under the same batchTag, and only the latest one (by
 * recommendedAt, since `rows` arrives pre-sorted ascending) should count
 * toward that week's Top 15. CandidateRecommendationLog itself is untouched;
 * this is purely a display-time collapse.
 */
export function groupIntoWeeklyBatches(rows: LogRow[]): WeeklyBatch[] {
  const byTag = new Map<string, WeeklyBatch>();
  for (const row of rows) {
    let batch = byTag.get(row.batchTag);
    if (!batch) {
      batch = { batchTag: row.batchTag, date: row.recommendedAt, rowsBySymbol: new Map() };
      byTag.set(row.batchTag, batch);
    }
    batch.rowsBySymbol.set(row.symbol, { score: row.score });
  }
  return [...byTag.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Applies the asymmetric entry/exit rule across weekly batches for a single
 * symbol: entry opens immediately on first appearance, a lone missed week is
 * treated as noise (position keeps tracking through it), and the position
 * only closes once the symbol is absent for 2 CONSECUTIVE weekly batches —
 * exiting effective at the last batch it was still given the benefit of the
 * doubt. Reappearance after a close is a brand-new position with a fresh
 * cost basis, not a continuation.
 */
export function buildTrackedPositions(batches: WeeklyBatch[]): TrackedPosition[] {
  const symbols = new Set<string>();
  for (const batch of batches) {
    for (const symbol of batch.rowsBySymbol.keys()) symbols.add(symbol);
  }

  const positions: TrackedPosition[] = [];

  for (const symbol of symbols) {
    let open: { entryIdx: number; entryScore: number } | null = null;
    let missedStreak = 0;

    for (let i = 0; i < batches.length; i++) {
      const row = batches[i].rowsBySymbol.get(symbol);
      if (row) {
        if (!open) open = { entryIdx: i, entryScore: row.score };
        missedStreak = 0;
      } else if (open) {
        missedStreak += 1;
        if (missedStreak === 2) {
          positions.push({
            symbol,
            entryDate: batches[open.entryIdx].date,
            entryScore: open.entryScore,
            exitDate: batches[i - 1].date,
          });
          open = null;
          missedStreak = 0;
        }
      }
    }

    if (open) {
      positions.push({
        symbol,
        entryDate: batches[open.entryIdx].date,
        entryScore: open.entryScore,
        exitDate: null,
      });
    }
  }

  return positions.sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime());
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
 * CandidateRecommendationLog is never written to here; it keeps recording
 * every week's full Top 15 unconditionally as the permanent audit trail.
 *
 * Raw weekly rows are first collapsed into continuous tracked positions
 * (see buildTrackedPositions): a symbol's first appearance opens a
 * position, consecutive weekly re-appearances hold it without resetting
 * cost basis, a single missed week is noise (tracking continues through
 * it), and 2 CONSECUTIVE missed weeks close it — a later re-appearance
 * opens a brand-new position with a fresh cost basis.
 *
 * View 1 (pick quality): each tracked position's own price return since
 * its entryDate, averaged equal-weighted across every position active as
 * of a given date, vs the S&P 500's return over that same per-position
 * window.
 *
 * View 2 (simulated portfolio): a paper portfolio anchored to the real
 * "Total Portfolio Value" (see resolvePortfolioBaseValue) where each
 * position gets a slice sized at the midpoint of its entry conviction
 * band, held from its entryDate forward.
 *
 * Tracking starts at each position's own entryDate — no backfilling or
 * estimating pre-entry performance.
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
      totalPositions: 0,
    };
  }

  const batches = groupIntoWeeklyBatches(rows);
  const positions = buildTrackedPositions(batches);

  const uniqueSymbols = [...new Set(positions.map((p) => p.symbol))];
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

  const earliestEntryDate = toUtcMidnight(positions[0].entryDate);
  const timeline = spxPoints
    .map((p) => toUtcMidnight(p.date))
    .filter((d) => d.getTime() >= earliestEntryDate.getTime());

  const today = toUtcMidnight(new Date());
  if (timeline.length === 0 || timeline[timeline.length - 1].getTime() < today.getTime()) {
    timeline.push(today);
  }

  const pickQuality: PickQualityPoint[] = [];
  const simulatedPortfolio: SimulatedPortfolioPoint[] = [];

  for (const date of timeline) {
    const activePositions = positions.filter((p) => {
      const entry = toUtcMidnight(p.entryDate).getTime();
      if (entry > date.getTime()) return false;
      if (p.exitDate == null) return true;
      return toUtcMidnight(p.exitDate).getTime() >= date.getTime();
    });
    if (activePositions.length === 0) continue;

    const pickReturns: number[] = [];
    const spxReturns: number[] = [];
    let pnl = 0;
    let sizedCount = 0;

    for (const position of activePositions) {
      const points = priceBySymbol.get(position.symbol);
      const stockReturn = points ? returnOverWindow(points, position.entryDate, date) : null;
      const spxReturn = returnOverWindow(spxPoints, position.entryDate, date);

      if (stockReturn != null) pickReturns.push(stockReturn);
      if (spxReturn != null) spxReturns.push(spxReturn);

      if (stockReturn != null) {
        const allocation = convictionMidpoint(position.entryScore) * baseValue;
        pnl += allocation * stockReturn;
        sizedCount += 1;
      }
    }

    pickQuality.push({
      date,
      pickReturn: pickReturns.length > 0 ? average(pickReturns) : null,
      spxReturn: spxReturns.length > 0 ? average(spxReturns) : null,
      activeCount: activePositions.length,
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
    trackedSince: positions[0].entryDate,
    totalPositions: positions.length,
  };
}
