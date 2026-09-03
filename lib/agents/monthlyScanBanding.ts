/**
 * Group 3's turnover/banding logic — rank-based buy/sell/backfill rules,
 * replayed month-over-month to derive tracked positions. Pure functions, no
 * DB access, so the banding behavior can be tested directly against
 * hand-constructed monthly ranking sequences.
 *
 * All four thresholds below are deliberately plain, adjustable constants
 * rather than inlined magic numbers, so they can be tuned once real
 * multi-month data exists without touching the banding logic itself.
 */

/** A symbol ranked at or above this (1 = strongest) is a buy candidate, subject to MAX_PORTFOLIO_SIZE. */
export const BUY_RANK_THRESHOLD = 10;
/** A currently-held symbol is only sold once its rank drops below this — wider than BUY_RANK_THRESHOLD so the gap between the two is the whipsaw-reducing buffer/band. */
export const SELL_RANK_THRESHOLD = 20;
/** If banding leaves fewer than this many positions held, backfill from the next-highest-ranked unheld names up to this size. */
export const TARGET_PORTFOLIO_SIZE = 10;
/** Hard ceiling on held positions — buys are capped here, but the count is never forced down to it by selling; only rank-based sells and attrition reduce it. */
export const MAX_PORTFOLIO_SIZE = 15;

export interface MonthlyRanking {
  monthKey: string;
  date: Date;
  /** Pre-sorted best-to-worst; index + 1 is the symbol's rank this month. */
  rankedSymbols: Array<{ symbol: string; score: number }>;
}

export interface TrackedPosition {
  symbol: string;
  entryDate: Date;
  /** Score at entry — sizing stays anchored to this for the whole holding period, same convention as Group 1's buildTrackedPositions. */
  entryScore: number;
  /** null while the position is still open. */
  exitDate: Date | null;
}

/**
 * Replays every month's ranking in order and derives Group 3's tracked
 * positions via rank-based banding — no separate "current holdings" table is
 * persisted; held state is reconstructed from the full CandidateRecommendationLog
 * (group: GROUP_3) history each time, the same "recompute from history"
 * approach Group 1's buildTrackedPositions already uses.
 *
 * Per month, in order:
 * 1. Sell — any held symbol ranked below SELL_RANK_THRESHOLD this month, or
 *    absent from this month's ranking entirely, is closed.
 * 2. Backfill — if that leaves fewer than TARGET_PORTFOLIO_SIZE held, add the
 *    next-highest-ranked unheld symbols (rank order) until reaching
 *    TARGET_PORTFOLIO_SIZE (capped at MAX_PORTFOLIO_SIZE).
 * 3. Normal buys — any unheld symbol ranked at or above BUY_RANK_THRESHOLD is
 *    added, but never past MAX_PORTFOLIO_SIZE; if the cap would be exceeded,
 *    the buy is skipped rather than force-selling something else to make
 *    room — the portfolio just shrinks back down through ordinary attrition.
 */
export function buildBandedMonthlyPositions(monthlyBatches: MonthlyRanking[]): TrackedPosition[] {
  const sorted = [...monthlyBatches].sort((a, b) => a.date.getTime() - b.date.getTime());

  const positions: TrackedPosition[] = [];
  const open = new Map<string, { entryDate: Date; entryScore: number }>();

  for (const batch of sorted) {
    const rankBySymbol = new Map<string, number>();
    batch.rankedSymbols.forEach((entry, i) => rankBySymbol.set(entry.symbol, i + 1));

    // 1. Sell.
    for (const symbol of [...open.keys()]) {
      const rank = rankBySymbol.get(symbol);
      if (rank == null || rank > SELL_RANK_THRESHOLD) {
        const entry = open.get(symbol)!;
        positions.push({ symbol, entryDate: entry.entryDate, entryScore: entry.entryScore, exitDate: batch.date });
        open.delete(symbol);
      }
    }

    // 2. Backfill — next-highest-ranked unheld names, in rank order.
    if (open.size < TARGET_PORTFOLIO_SIZE) {
      for (const entry of batch.rankedSymbols) {
        if (open.size >= TARGET_PORTFOLIO_SIZE || open.size >= MAX_PORTFOLIO_SIZE) break;
        if (open.has(entry.symbol)) continue;
        open.set(entry.symbol, { entryDate: batch.date, entryScore: entry.score });
      }
    }

    // 3. Normal buys — rank <= BUY_RANK_THRESHOLD, capped at MAX_PORTFOLIO_SIZE.
    for (const entry of batch.rankedSymbols) {
      const rank = rankBySymbol.get(entry.symbol)!;
      if (rank > BUY_RANK_THRESHOLD) break;
      if (open.has(entry.symbol)) continue;
      if (open.size >= MAX_PORTFOLIO_SIZE) continue;
      open.set(entry.symbol, { entryDate: batch.date, entryScore: entry.score });
    }
  }

  for (const [symbol, entry] of open) {
    positions.push({ symbol, entryDate: entry.entryDate, entryScore: entry.entryScore, exitDate: null });
  }

  return positions.sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime());
}

/** Symbols currently held as of the latest month in `monthlyBatches`, in rank order for that month — the buy/hold/backfill table Group 3's UI renders. */
export function currentlyHeldSymbols(monthlyBatches: MonthlyRanking[]): Set<string> {
  const positions = buildBandedMonthlyPositions(monthlyBatches);
  return new Set(positions.filter((p) => p.exitDate == null).map((p) => p.symbol));
}

/**
 * Group 3's "Top 30" analog of buildBandedMonthlyPositions: tracks every
 * ranked symbol from every monthly batch regardless of buy/sell banding, so
 * it answers "was the ranking model itself directionally sound" independent
 * of the execution/banding layer above.
 *
 * Unlike the Top 10 banding replay, there's no grace period on absence — a
 * symbol closes the very first month it's missing from the batch, and a
 * later re-appearance opens a brand-new position with a fresh cost basis.
 * Monthly cadence makes even one missed month a meaningful signal, unlike
 * Group 1's weekly "one miss is noise" rule.
 */
export function buildFullRankTrackedPositions(monthlyBatches: MonthlyRanking[]): TrackedPosition[] {
  const sorted = [...monthlyBatches].sort((a, b) => a.date.getTime() - b.date.getTime());

  const positions: TrackedPosition[] = [];
  const open = new Map<string, { entryDate: Date; entryScore: number }>();

  for (const batch of sorted) {
    const bySymbol = new Map(batch.rankedSymbols.map((entry) => [entry.symbol, entry]));

    for (const symbol of [...open.keys()]) {
      if (!bySymbol.has(symbol)) {
        const entry = open.get(symbol)!;
        positions.push({ symbol, entryDate: entry.entryDate, entryScore: entry.entryScore, exitDate: batch.date });
        open.delete(symbol);
      }
    }

    for (const entry of batch.rankedSymbols) {
      if (!open.has(entry.symbol)) {
        open.set(entry.symbol, { entryDate: batch.date, entryScore: entry.score });
      }
    }
  }

  for (const [symbol, entry] of open) {
    positions.push({ symbol, entryDate: entry.entryDate, entryScore: entry.entryScore, exitDate: null });
  }

  return positions.sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime());
}
