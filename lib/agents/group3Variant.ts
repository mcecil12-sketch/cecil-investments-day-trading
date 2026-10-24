import { computeCappedTop10 } from "@/lib/agents/cappedTop10";
import { groupIntoMonthlyRankings } from "@/lib/agents/recommendationPerformance";
import type { MonthlyRanking } from "@/lib/agents/monthlyScanBanding";

/**
 * Which Group 3 list real money follows. Decided Oct 22, 2026 after the
 * pure top 10 ran 7 of 10 names in one sector and trailed the S&P by about
 * 13 points in October while the capped list trailed by about 3: real money
 * holds the capped list from the Nov 1, 2026 scan (trades Nov 2), and the pure top 10
 * is tracked alongside as the shadow. Both are always computed.
 */
export type Group3Variant = "pure" | "capped";
export const GROUP3_HELD_VARIANT: Group3Variant = "capped";
/** First monthly scan batch (UTC date) whose list real money follows under GROUP3_HELD_VARIANT; trades execute the next market day (Nov 2, 2026). */
export const GROUP3_HELD_VARIANT_SINCE = "2026-11-01";

/** The variant real money followed for a given monthly batch date. */
export function heldVariantForBatch(batchDate: Date): Group3Variant {
  return batchDate.toISOString().slice(0, 10) >= GROUP3_HELD_VARIANT_SINCE ? GROUP3_HELD_VARIANT : "pure";
}

export const GROUP3_VARIANT_LABEL: Record<Group3Variant, string> = {
  pure: "Pure top 10 (by composite rank)",
  capped: "Capped list (max 3 per sector; usually 9 names, equal weight)",
};

export interface Group3LogRow {
  symbol: string;
  batchTag: string;
  recommendedAt: Date;
  score: number;
  rank?: number | null;
  sector?: string | null;
}

/**
 * Monthly rankings for the capped variant, in the shape the banding replay
 * expects: only the month's capped names, in capped order (usually 9). Recomputed from each batch's ranks
 * and sectors, so months logged before the capped columns existed (Sep and
 * Oct 2026) replay the same way as later ones.
 */
export function groupIntoCappedMonthlyRankings(rows: Group3LogRow[]): MonthlyRanking[] {
  const sectorByKey = new Map<string, string>();
  for (const r of rows) sectorByKey.set(`${r.batchTag}|${r.symbol}`, r.sector ?? "Unclassified");
  return groupIntoMonthlyRankings(rows).map((month) => {
    const ranked = month.rankedSymbols.map((s, i) => ({
      symbol: s.symbol,
      score: s.score,
      rank: i + 1,
      sector: sectorByKey.get(`${month.monthKey}|${s.symbol}`) ?? "Unclassified",
    }));
    const capped = computeCappedTop10(ranked);
    const cappedRankBySymbol = new Map(capped.filter((c) => c.inCappedTop10).map((c) => [c.symbol, c.cappedRank!]));
    // Only the capped names: anything not on the list is treated as off the list
    // (sold), so a 9-name month never backfills a 10th from the overflow.
    const top = ranked
      .filter((r) => cappedRankBySymbol.has(r.symbol))
      .sort((a, b) => cappedRankBySymbol.get(a.symbol)! - cappedRankBySymbol.get(b.symbol)!);
    return { ...month, rankedSymbols: top.map(({ symbol, score }) => ({ symbol, score })) };
  });
}

export function group3RankingsFor(variant: Group3Variant, rows: Group3LogRow[]): MonthlyRanking[] {
  return variant === "capped" ? groupIntoCappedMonthlyRankings(rows) : groupIntoMonthlyRankings(rows);
}

export interface HeldMonth {
  monthKey: string;
  date: Date;
  variant: Group3Variant;
  /** The 10 names real money holds for this month under `variant`. */
  top10: string[];
}

/**
 * What real money actually held each month: pure lists before
 * GROUP3_HELD_VARIANT_SINCE, the held variant after. Under the hard top-10
 * rule the holding each month is exactly that month's list of 10.
 */
export function heldMonths(rows: Group3LogRow[], topN = 10): HeldMonth[] {
  const pure = groupIntoMonthlyRankings(rows);
  const capped = groupIntoCappedMonthlyRankings(rows);
  return pure.map((month, i) => {
    const variant = heldVariantForBatch(month.date);
    const source = variant === "capped" ? capped[i] : month;
    return { monthKey: month.monthKey, date: month.date, variant, top10: source.rankedSymbols.slice(0, topN).map((s) => s.symbol) };
  });
}

/** Names to sell at the latest scan: held last month (under last month's variant) but not on this month's held list. */
export function latestSellList(rows: Group3LogRow[]): string[] {
  const months = heldMonths(rows);
  if (months.length < 2) return [];
  const current = new Set(months[months.length - 1].top10);
  return months[months.length - 2].top10.filter((s) => !current.has(s));
}
