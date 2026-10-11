import { prisma } from "@/lib/prisma";
import { getCurrentHoldings } from "@/lib/agents/holdings";
import { buildStockSectorIndex, getHoldingSector } from "@/lib/agents/sectorRotation";
import { getMergedCandidateUniverse } from "@/lib/agents/scoringShared";
import { computeCappedTop10 } from "@/lib/agents/cappedTop10";
import { groupIntoMonthlyRankings } from "@/lib/agents/recommendationPerformance";
import { sectorWeightsByValue, sectorWeightsEqual, type SectorWeights } from "@/lib/portfolio/sectorExposure";

export interface SectorExposureView {
  /** Monthly batch the two top-10 variants come from (null if none logged yet). */
  batchTag: string | null;
  pureTop10: SectorWeights | null;
  cappedTop10: SectorWeights | null;
  /** Unified portfolio: every account's current holdings (401k funds, taxable, LTI shares as VZ), cash excluded. */
  portfolio: SectorWeights | null;
  /** Caveats shown with the view (cash excluded, unknown-sector holdings, recomputed batches). */
  notes: string[];
}

/**
 * Display-only. Sector comes from the app's existing classification: the scan's
 * own sector for candidates, getHoldingSector (fund map + candidate universe)
 * for holdings. Anything unmapped is "Unknown" — notably target-date funds,
 * bond funds and other multi-asset funds.
 */
export async function loadSectorExposureView(): Promise<SectorExposureView> {
  const notes: string[] = ["Cash and money-market balances are excluded from the portfolio view."];

  let batchTag: string | null = null;
  let pureTop10: SectorWeights | null = null;
  let cappedTop10: SectorWeights | null = null;
  try {
    const rows = await prisma.candidateRecommendationLog.findMany({ where: { group: "GROUP_3" }, orderBy: { recommendedAt: "asc" } });
    const latest = groupIntoMonthlyRankings(rows).at(-1);
    if (latest) {
      batchTag = latest.monthKey;
      const batch = rows.filter((r) => r.batchTag === latest.monthKey && r.rank != null).sort((a, b) => a.rank! - b.rank!);
      pureTop10 = sectorWeightsEqual(batch.filter((r) => r.rank! <= 10).map((r) => ({ symbol: r.symbol, sector: r.sector || null })));
      // Use the stored shadow variant; recompute (same pure function) for batches logged before it existed.
      const stored = batch.some((r) => r.inCappedTop10 != null);
      const capped = stored
        ? batch.filter((r) => r.inCappedTop10 === true)
        : computeCappedTop10(batch.map((r) => ({ symbol: r.symbol, sector: r.sector, rank: r.rank! })))
            .filter((c) => c.inCappedTop10)
            .map((c) => batch.find((r) => r.symbol === c.symbol)!);
      cappedTop10 = sectorWeightsEqual(capped.map((r) => ({ symbol: r.symbol, sector: r.sector || null })));
      if (!stored) notes.push("The capped variant for this batch was recomputed (batch predates the stored shadow columns).");
    }
  } catch (err) {
    console.error("sector exposure (top 10 variants) failed:", err instanceof Error ? err.message : err);
  }

  let portfolio: SectorWeights | null = null;
  try {
    const index = buildStockSectorIndex(await getMergedCandidateUniverse());
    const holdings = await getCurrentHoldings();
    portfolio = sectorWeightsByValue(holdings.map((h) => ({ symbol: h.symbol, value: h.currentValue, sector: getHoldingSector(h.symbol, h.name, index) })));
  } catch (err) {
    console.error("sector exposure (portfolio) failed:", err instanceof Error ? err.message : err);
  }
  if (portfolio?.unknownSymbols.length) notes.push(`Sector unknown (not guessed): ${portfolio.unknownSymbols.join(", ")}.`);
  return { batchTag, pureTop10, cappedTop10, portfolio, notes };
}
