import { prisma } from "@/lib/prisma";
import { getPriceHistory, getSp500Series, type PricePoint } from "@/lib/agents/marketData";
import { computeReturn } from "@/lib/agents/technicals";
import { convictionMidpoint, resolvePortfolioBaseValue } from "@/lib/agents/positionSizing";
import { TIMEFRAME_DAYS, type TimeframeKey } from "@/lib/timeframes";
import { buildBandedMonthlyPositions, type MonthlyRanking } from "@/lib/agents/monthlyScanBanding";
import type { RecommendationGroup } from "@/lib/generated/prisma";

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
  /** Number of currently-open positions with a live priced return contributing to this point's P&L. Closed positions' realized P&L is folded into pnl/portfolioValue too (see buildRealizationEvents) but isn't counted here — this reflects live, still-open exposure only. */
  activeCount: number;
}

export interface RecommendationPerformanceResult {
  /** Pick Quality re-based to each timeframe's own window start (not sliced-after-the-fact from the "All" series) — an average-of-returns can't be re-based algebraically once positions are mixed, so each variant is computed from its own per-position pass. */
  pickQualityByTimeframe: Record<TimeframeKey, PickQualityPoint[]>;
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
  rank?: number | null;
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

/**
 * Group 3 analog of groupIntoWeeklyBatches: collapses raw GROUP_3 rows
 * (batchTag "monthly-YYYY-MM") into one MonthlyRanking per batch, sorted by
 * each row's persisted `rank` — the input buildBandedMonthlyPositions
 * replays to derive tracked positions via rank-based banding rather than
 * presence/absence.
 */
export function groupIntoMonthlyRankings(rows: LogRow[]): MonthlyRanking[] {
  const byTag = new Map<string, { date: Date; bySymbol: Map<string, { score: number; rank: number }> }>();
  for (const row of rows) {
    if (row.rank == null) continue;
    let batch = byTag.get(row.batchTag);
    if (!batch) {
      batch = { date: row.recommendedAt, bySymbol: new Map() };
      byTag.set(row.batchTag, batch);
    }
    batch.bySymbol.set(row.symbol, { score: row.score, rank: row.rank });
  }
  return [...byTag.entries()]
    .map(([monthKey, batch]) => ({
      monthKey,
      date: batch.date,
      rankedSymbols: [...batch.bySymbol.entries()]
        .sort((a, b) => a[1].rank - b[1].rank)
        .map(([symbol, v]) => ({ symbol, score: v.score })),
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
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

function subtractDaysUtc(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/** A position can't be re-based before it existed — for positions that entered after the window opened, the window start collapses to the position's own entryDate, so its contribution is just its ordinary since-entry return. */
export function effectiveStartFor(entryDate: Date, windowStart: Date | null): Date {
  if (windowStart == null) return entryDate;
  return entryDate.getTime() > windowStart.getTime() ? entryDate : windowStart;
}

/** Equal-weighted Pick Quality for one date, with every active position's return re-based to `windowStart` (null = since each position's own entryDate, i.e. the "All" view). */
export function buildPickQualityPoint(
  date: Date,
  activePositions: TrackedPosition[],
  priceBySymbol: Map<string, PricePoint[]>,
  spxPoints: PricePoint[],
  windowStart: Date | null,
): PickQualityPoint {
  const pickReturns: number[] = [];
  const spxReturns: number[] = [];

  for (const position of activePositions) {
    const start = effectiveStartFor(position.entryDate, windowStart);
    const points = priceBySymbol.get(position.symbol);
    const stockReturn = points ? returnOverWindow(points, start, date) : null;
    const spxReturn = returnOverWindow(spxPoints, start, date);
    if (stockReturn != null) pickReturns.push(stockReturn);
    if (spxReturn != null) spxReturns.push(spxReturn);
  }

  return {
    date,
    pickReturn: pickReturns.length > 0 ? average(pickReturns) : null,
    spxReturn: spxReturns.length > 0 ? average(spxReturns) : null,
    activeCount: activePositions.length,
  };
}

/** Rebuilds Pick Quality for a single trailing-N-day window, using each date's already-known active positions rather than re-filtering the full position list. */
function computeWindowedPickQuality(
  timeline: Date[],
  activePositionsByDate: Map<number, TrackedPosition[]>,
  priceBySymbol: Map<string, PricePoint[]>,
  spxPoints: PricePoint[],
  days: number,
): PickQualityPoint[] {
  if (timeline.length === 0) return [];
  const windowStart = subtractDaysUtc(timeline[timeline.length - 1], days - 1);
  const points: PickQualityPoint[] = [];
  for (const date of timeline) {
    if (date.getTime() < windowStart.getTime()) continue;
    const activePositions = activePositionsByDate.get(date.getTime());
    if (!activePositions || activePositions.length === 0) continue;
    points.push(buildPickQualityPoint(date, activePositions, priceBySymbol, spxPoints, windowStart));
  }
  return points;
}

export interface RealizationEvent {
  exitDate: Date;
  amount: number;
}

/**
 * Realized dollar P&L for one closed position, sized the same way a live
 * position is (conviction-midpoint allocation × price return), but over its
 * full entryDate-to-exitDate holding period rather than to "today." Null
 * when price history doesn't cover the entry or exit date — the same
 * graceful skip the live per-date loop already applies.
 */
export function computeRealizedPnl(
  position: TrackedPosition,
  priceBySymbol: Map<string, PricePoint[]>,
  baseValue: number,
): number | null {
  if (position.exitDate == null) return null;
  const points = priceBySymbol.get(position.symbol);
  if (!points) return null;
  const stockReturn = returnOverWindow(points, position.entryDate, position.exitDate);
  if (stockReturn == null) return null;
  return convictionMidpoint(position.entryScore) * baseValue * stockReturn;
}

/**
 * One-time realized-P&L events for every closed, priced position, sorted
 * ascending by exitDate. Folded into a running total in
 * getRecommendationPerformance's timeline loop so a sold position's gain or
 * loss stays in portfolioValue for every date after its exit — proceeds
 * treated as moving to cash, held flat — instead of disappearing
 * retroactively the way excluding exited positions from every subsequent
 * date's total would (a survivorship-bias bug: a sold position's P&L is
 * real and permanent, the same way real time-weighted-return reporting
 * keeps a closed position's contribution in the cumulative total).
 */
export function buildRealizationEvents(
  positions: TrackedPosition[],
  priceBySymbol: Map<string, PricePoint[]>,
  baseValue: number,
): RealizationEvent[] {
  const events: RealizationEvent[] = [];
  for (const position of positions) {
    if (position.exitDate == null) continue;
    const amount = computeRealizedPnl(position, priceBySymbol, baseValue);
    if (amount == null) continue;
    events.push({ exitDate: toUtcMidnight(position.exitDate), amount });
  }
  return events.sort((a, b) => a.exitDate.getTime() - b.exitDate.getTime());
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
 * window. Computed separately per timeframe (see pickQualityByTimeframe) —
 * for the 1W/2W/1M variants, each position's return is re-based to the
 * window's own start date (or its entryDate if that's later), since an
 * equal-weighted average can't be re-based after the fact.
 *
 * View 2 (simulated portfolio): a paper portfolio anchored to the real
 * "Total Portfolio Value" (see resolvePortfolioBaseValue) where each
 * position gets a slice sized at the midpoint of its entry conviction
 * band, held from its entryDate forward. A position that exits doesn't
 * drop out of the total: its final dollar P&L as of the exit date is
 * realized into a running bucket (see buildRealizationEvents) that keeps
 * contributing to every later date's portfolioValue, so the simulation's
 * cumulative return reflects the full history of every position ever
 * tracked, not just currently-open ones.
 *
 * Tracking starts at each position's own entryDate — no backfilling or
 * estimating pre-entry performance.
 */
export async function getRecommendationPerformance(
  totalCurrentValue?: number | null,
  group: RecommendationGroup = "GROUP_1",
): Promise<RecommendationPerformanceResult> {
  const baseValue = resolvePortfolioBaseValue(totalCurrentValue);
  const rows = await prisma.candidateRecommendationLog.findMany({
    where: { group },
    orderBy: { recommendedAt: "asc" },
  });

  if (rows.length === 0) {
    return {
      pickQualityByTimeframe: { "1W": [], "2W": [], "1M": [], All: [] },
      simulatedPortfolio: [],
      baseValue,
      trackedSince: null,
      totalPositions: 0,
    };
  }

  // GROUP_1's presence/absence tracking (buildTrackedPositions) and GROUP_3's
  // rank-based banding (buildBandedMonthlyPositions) are different position-
  // construction rules, but both produce the same TrackedPosition shape, so
  // everything downstream (pick quality, simulated portfolio, realized P&L)
  // is identical regardless of which group this call is for.
  const positions =
    group === "GROUP_3" ? buildBandedMonthlyPositions(groupIntoMonthlyRankings(rows)) : buildTrackedPositions(groupIntoWeeklyBatches(rows));

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

  const pickQualityAll: PickQualityPoint[] = [];
  const simulatedPortfolio: SimulatedPortfolioPoint[] = [];
  const activePositionsByDate = new Map<number, TrackedPosition[]>();

  const realizationEvents = buildRealizationEvents(positions, priceBySymbol, baseValue);
  let realizedPnlToDate = 0;
  let nextRealizationIdx = 0;

  for (const date of timeline) {
    const activePositions = positions.filter((p) => {
      const entry = toUtcMidnight(p.entryDate).getTime();
      if (entry > date.getTime()) return false;
      if (p.exitDate == null) return true;
      return toUtcMidnight(p.exitDate).getTime() >= date.getTime();
    });

    // activePositions still includes a closed position through its exitDate
    // inclusive, so its final day's contribution comes from the live loop
    // below — only fold its realized P&L into the running bucket starting
    // the day AFTER exit, so it's counted exactly once.
    while (
      nextRealizationIdx < realizationEvents.length &&
      realizationEvents[nextRealizationIdx].exitDate.getTime() < date.getTime()
    ) {
      realizedPnlToDate += realizationEvents[nextRealizationIdx].amount;
      nextRealizationIdx += 1;
    }

    let livePnl = 0;
    let sizedCount = 0;

    for (const position of activePositions) {
      const points = priceBySymbol.get(position.symbol);
      const stockReturn = points ? returnOverWindow(points, position.entryDate, date) : null;

      if (stockReturn != null) {
        const allocation = convictionMidpoint(position.entryScore) * baseValue;
        livePnl += allocation * stockReturn;
        sizedCount += 1;
      }
    }

    if (activePositions.length > 0) {
      activePositionsByDate.set(date.getTime(), activePositions);
      pickQualityAll.push(buildPickQualityPoint(date, activePositions, priceBySymbol, spxPoints, null));
    }

    // Emitted for every timeline date (even ones with zero currently-open
    // positions) so portfolioValue reflects the full history of every
    // position ever tracked, not just currently-open ones — unlike
    // activePositions/pickQualityAll above, which legitimately have nothing
    // to show when nothing is open.
    const pnl = livePnl + realizedPnlToDate;
    simulatedPortfolio.push({
      date,
      portfolioValue: baseValue + pnl,
      pnl,
      pnlPct: pnl / baseValue,
      activeCount: sizedCount,
    });
  }

  const pickQualityByTimeframe: Record<TimeframeKey, PickQualityPoint[]> = {
    "1W": computeWindowedPickQuality(timeline, activePositionsByDate, priceBySymbol, spxPoints, TIMEFRAME_DAYS["1W"]!),
    "2W": computeWindowedPickQuality(timeline, activePositionsByDate, priceBySymbol, spxPoints, TIMEFRAME_DAYS["2W"]!),
    "1M": computeWindowedPickQuality(timeline, activePositionsByDate, priceBySymbol, spxPoints, TIMEFRAME_DAYS["1M"]!),
    All: pickQualityAll,
  };

  return {
    pickQualityByTimeframe,
    simulatedPortfolio,
    baseValue,
    trackedSince: positions[0].entryDate,
    totalPositions: positions.length,
  };
}
