import { prisma } from "@/lib/prisma";
import { getEarningsSurpriseTrendScores, type EarningsSurpriseTrendCoverage } from "@/lib/agents/earningsSurpriseTrend";

export interface MonthlyScanEarningsResult {
  score: number;
  coverage: EarningsSurpriseTrendCoverage;
  /** The reported fiscal quarter this score is based on — null when there's no reported quarter at all yet. Persisted into MonthlyScanOutput's per-symbol dataAvailability for auditability. */
  fiscalDateEndingUsed: Date | null;
}

/**
 * Group 3's quarterly-triggered earnings-surprise-trend recompute.
 *
 * Earnings data only changes ~4x/year (one report per fiscal quarter),
 * regardless of how often this agent's scoring loop runs. Recomputing the
 * earnings-surprise-trend sub-score every month a symbol hasn't reported
 * would re-score identical inputs and falsely imply a fresher signal than
 * actually exists — so this factor only recomputes when
 * EarningsHistory.fiscalDateEnding has advanced past what was last scored
 * (tracked per symbol in MonthlyScanEarningsState). Batched: one query for
 * every symbol's latest reported fiscal date, one query for existing state,
 * diff to find which symbols actually need a fresh score, then one batched
 * getEarningsSurpriseTrendScores call for just those — not one call per
 * symbol.
 */
export async function getMonthlyScanEarningsScores(symbols: string[]): Promise<Map<string, MonthlyScanEarningsResult>> {
  const [latestReportedRows, states] = await Promise.all([
    prisma.earningsHistory.findMany({
      where: { symbol: { in: symbols }, reportedEPS: { not: null } },
      select: { symbol: true, fiscalDateEnding: true },
      orderBy: { fiscalDateEnding: "desc" },
    }),
    prisma.monthlyScanEarningsState.findMany({ where: { symbol: { in: symbols } } }),
  ]);

  const latestReportedBySymbol = new Map<string, Date>();
  for (const row of latestReportedRows) {
    if (!latestReportedBySymbol.has(row.symbol)) latestReportedBySymbol.set(row.symbol, row.fiscalDateEnding);
  }
  const stateBySymbol = new Map(states.map((s) => [s.symbol, s]));

  const needsRefresh: string[] = [];
  for (const symbol of symbols) {
    const state = stateBySymbol.get(symbol);
    const latestReported = latestReportedBySymbol.get(symbol) ?? null;
    const lastScored = state?.lastScoredFiscalDateEnding ?? null;
    if (!state || latestReported == null || lastScored == null || latestReported.getTime() !== lastScored.getTime()) {
      needsRefresh.push(symbol);
    }
  }

  const freshScores = needsRefresh.length > 0 ? await getEarningsSurpriseTrendScores(needsRefresh) : new Map();

  const upserts = needsRefresh.map((symbol) => {
    const fresh = freshScores.get(symbol)!;
    const fiscalDateEndingUsed = latestReportedBySymbol.get(symbol) ?? null;
    return prisma.monthlyScanEarningsState.upsert({
      where: { symbol },
      create: {
        symbol,
        lastScoredFiscalDateEnding: fiscalDateEndingUsed,
        lastEarningsSurpriseScore: fresh.score,
        lastEarningsSurpriseCoverage: fresh.coverage,
      },
      update: {
        lastScoredFiscalDateEnding: fiscalDateEndingUsed,
        lastEarningsSurpriseScore: fresh.score,
        lastEarningsSurpriseCoverage: fresh.coverage,
      },
    });
  });
  if (upserts.length > 0) await prisma.$transaction(upserts);

  const result = new Map<string, MonthlyScanEarningsResult>();
  for (const symbol of symbols) {
    if (needsRefresh.includes(symbol)) {
      const fresh = freshScores.get(symbol)!;
      result.set(symbol, {
        score: fresh.score,
        coverage: fresh.coverage,
        fiscalDateEndingUsed: latestReportedBySymbol.get(symbol) ?? null,
      });
    } else {
      const state = stateBySymbol.get(symbol)!;
      result.set(symbol, {
        score: state.lastEarningsSurpriseScore!,
        coverage: state.lastEarningsSurpriseCoverage as EarningsSurpriseTrendCoverage,
        fiscalDateEndingUsed: state.lastScoredFiscalDateEnding,
      });
    }
  }
  return result;
}
