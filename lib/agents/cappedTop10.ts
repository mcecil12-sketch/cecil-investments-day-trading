/**
 * Capped top 10 for Group 3. Alongside the pure top 10 (by composite rank) we
 * compute a variant that allows at most CAPPED_MAX_PER_SECTOR names per
 * sector, using the sector already on each candidate. The monthly scan ranks
 * only the top 3 sectors, so the list is usually 9 names (3 per sector); the
 * empty 10th slot is deliberately left unfilled and the 9 are equal-weighted
 * (decided Oct 22, 2026, over filling it). Decided Oct 22, 2026: this is
 * the version real money holds from the Nov 2, 2026 rebalance (see
 * group3Variant.ts); the pure top 10 is tracked alongside as the shadow.
 * It does not touch composite scores or ranks.
 */
export const CAPPED_MAX_PER_SECTOR = 3;
export const CAPPED_TOP_N = 10;


export interface CappedInput {
  symbol: string;
  sector: string;
  /** 1 = best composite score; defines the walk order. */
  rank: number;
}

export interface CappedResult {
  symbol: string;
  /**
   * 1-based rank in the capped ordering: walk the full ranked list best-first
   * and keep a name only while its sector has fewer than MAX_PER_SECTOR names
   * kept so far. Names over the cap (the "overflow") get null — the next-ranked
   * name from a sector still under the cap takes their place. Null for overflow.
   */
  cappedRank: number | null;
  /** cappedRank is 1..CAPPED_TOP_N. */
  inCappedTop10: boolean;
}

export function computeCappedTop10(candidates: CappedInput[], maxPerSector = CAPPED_MAX_PER_SECTOR, topN = CAPPED_TOP_N): CappedResult[] {
  const sorted = [...candidates].sort((a, b) => a.rank - b.rank);
  const perSector = new Map<string, number>();
  let next = 1;
  const bySymbol = new Map<string, CappedResult>();
  for (const c of sorted) {
    const used = perSector.get(c.sector) ?? 0;
    if (used < maxPerSector) {
      perSector.set(c.sector, used + 1);
      bySymbol.set(c.symbol, { symbol: c.symbol, cappedRank: next, inCappedTop10: next <= topN });
      next++;
    } else {
      bySymbol.set(c.symbol, { symbol: c.symbol, cappedRank: null, inCappedTop10: false });
    }
  }
  return candidates.map((c) => bySymbol.get(c.symbol)!);
}

export function sectorCounts(items: Array<{ sector: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.sector] = (out[i.sector] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
