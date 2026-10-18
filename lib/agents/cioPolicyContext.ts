import { prisma } from "@/lib/prisma";
import { groupIntoMonthlyRankings } from "@/lib/agents/recommendationPerformance";
import { buildBandedMonthlyPositions, BUY_RANK_THRESHOLD } from "@/lib/agents/monthlyScanBanding";
import { getCurrentHoldings, totalPortfolioValue } from "@/lib/agents/holdings";
import { getVzExposure } from "@/lib/portfolio/vzExposureData";

/**
 * Standing portfolio rules the CIO must respect, built from real data. Without
 * this, the CIO recommended adding a Group 3 sell candidate (PSX) and trimming
 * Verizon exposure that is almost entirely unvested, untradeable LTI (Oct 2026
 * brief). Each part is null when its data can't be loaded; the brief still runs.
 */
export interface CioPolicyContext {
  group3: {
    batchTag: string;
    top10: string[];
    sellCandidates: string[];
    nextScanDate: string;
  } | null;
  verizon: {
    includingLtiValue: number;
    includingLtiPct: number | null;
    tradeableValue: number;
    tradeablePct: number | null;
  } | null;
}

/** The monthly scan cron fires on the 1st of each month (0 6 1 * * UTC). */
export function nextMonthlyScanDate(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

async function loadGroup3(now: Date): Promise<CioPolicyContext["group3"]> {
  const rows = await prisma.candidateRecommendationLog.findMany({ where: { group: "GROUP_3" }, orderBy: { recommendedAt: "asc" } });
  const rankings = groupIntoMonthlyRankings(rows);
  const latest = rankings.at(-1);
  if (!latest) return null;
  return {
    batchTag: latest.monthKey,
    top10: latest.rankedSymbols.slice(0, BUY_RANK_THRESHOLD).map((s) => s.symbol),
    sellCandidates: buildBandedMonthlyPositions(rankings)
      .filter((p) => p.exitDate?.getTime() === latest.date.getTime())
      .map((p) => p.symbol),
    nextScanDate: nextMonthlyScanDate(now),
  };
}

async function loadVerizon(): Promise<CioPolicyContext["verizon"]> {
  const total = totalPortfolioValue(await getCurrentHoldings());
  const exposure = await getVzExposure(total > 0 ? total : null);
  return {
    includingLtiValue: exposure.totalValue,
    includingLtiPct: exposure.percentOfPortfolio,
    tradeableValue: exposure.excludingLti.totalValue,
    tradeablePct: exposure.excludingLti.percentOfPortfolio,
  };
}

export async function buildCioPolicyContext(now: Date = new Date()): Promise<CioPolicyContext> {
  const [group3, verizon] = await Promise.all([loadGroup3(now).catch(() => null), loadVerizon().catch(() => null)]);
  return { group3, verizon };
}
