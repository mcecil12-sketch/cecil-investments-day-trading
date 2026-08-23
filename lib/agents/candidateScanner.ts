import { prisma } from "@/lib/prisma";
import { getPriceHistory, getSp500Series } from "@/lib/agents/marketData";
import { scorePriceSeries } from "@/lib/agents/technicals";
import { getCurrentHoldings, totalPortfolioValue } from "@/lib/agents/holdings";
import { getHoldingSector, type SectorRotationOutput, type SectorScore } from "@/lib/agents/sectorRotation";
import { closestPlanFundsForProxy } from "@/lib/agents/fundMappings";
import { getEarningsSurpriseTrendScores, type EarningsSurpriseTrendCoverage } from "@/lib/agents/earningsSurpriseTrend";
import {
  MOMENTUM_TREND_WEIGHT,
  EARNINGS_SURPRISE_TREND_WEIGHT,
  SECTOR_LEADERSHIP_WEIGHT,
  STATIC_CANDIDATE_UNIVERSE,
  CANDIDATE_NAMES,
  getMergedCandidateUniverse,
} from "@/lib/agents/scoringShared";
import { formatPercent } from "@/lib/format";

export type CandidateAccountType = "taxable" | "401k" | "both";

/** Re-exported from scoringShared.ts (the canonical source, shared with the monthly scan agent) so existing imports of this symbol from candidateScanner.ts keep working unchanged. */
export { STATIC_CANDIDATE_UNIVERSE };

/** How many of the top-scoring candidates to surface across all scanned sectors. */
const MAX_TOP_CANDIDATES = 15;

export interface CandidateEntry {
  symbol: string;
  name: string;
  sector: string;
  /**
   * 0-100 composite. The target composite is momentum/trend (35%) +
   * earnings surprise trend (30%) + sector leadership (25%) + sentiment/news
   * (10%); sentiment/news has no data source in this app yet, so the three
   * implemented factors are renormalized to fill 100%: momentum/trend at
   * 35/90 = 38.9%, earnings surprise trend at 30/90 = 33.3%, sector
   * leadership at 25/90 = 27.8%. See MOMENTUM_TREND_WEIGHT /
   * EARNINGS_SURPRISE_TREND_WEIGHT / SECTOR_LEADERSHIP_WEIGHT below.
   */
  score: number;
  /** This symbol's own 1-year return minus the S&P 500's 1-year return over the same window, in percentage points. Computed per-symbol, not shared. */
  vsSpx: number;
  momentum1Y: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  /** 0-100 earnings-surprise-trend factor (see earningsSurpriseTrend.ts) — 50 is neutral, used both for a genuinely flat signal and for insufficient-coverage fallback (see earningsSurpriseCoverage). */
  earningsSurpriseTrend: number;
  earningsSurpriseCoverage: EarningsSurpriseTrendCoverage;
  rationale: string;
  accountType: CandidateAccountType;
}

export interface SectorAlignmentEntry {
  sector: string;
  rotationRank: number;
  currentExposure: number;
  recommendedExposure: string;
  topCandidate: string;
}

export interface CandidateScannerOutput {
  generatedAt: string;
  topCandidates: CandidateEntry[];
  sectorAlignment: SectorAlignmentEntry[];
  sectorsWithoutUniverse: string[];
  skipped: Array<{ symbol: string; reason: string }>;
}

function recommendedExposureLabel(currentExposure: number): string {
  if (currentExposure < 0.02) return "Underweight — build toward 5-10%";
  if (currentExposure < 0.08) return "Light — room to add toward 10%+";
  if (currentExposure > 0.2) return "Already overweight — hold, don't add";
  return "Adequate — maintain current allocation";
}

function earningsRationaleClause(entry: Pick<CandidateEntry, "earningsSurpriseTrend" | "earningsSurpriseCoverage">): string {
  switch (entry.earningsSurpriseCoverage) {
    case "sue":
      return `earnings surprise trend ${entry.earningsSurpriseTrend}/100`;
    case "raw_surprise_fallback":
      return `earnings surprise trend ${entry.earningsSurpriseTrend}/100 (low confidence — limited quarterly history)`;
    case "insufficient_data":
      return "no usable reported-vs-estimated EPS data available";
    case "no_coverage":
      return "no reported earnings history available";
    case "not_yet_fetched":
      return "earnings history not yet fetched this week";
  }
}

function buildRationale(
  entry: Pick<
    CandidateEntry,
    | "symbol"
    | "score"
    | "vsSpx"
    | "momentum1Y"
    | "aboveSma50"
    | "aboveSma200"
    | "earningsSurpriseTrend"
    | "earningsSurpriseCoverage"
  >,
  sector: SectorScore,
  planFunds: string[],
): string {
  const parts = [
    `Score ${entry.score}/100, outperforming the S&P 500 by ${entry.vsSpx > 0 ? "+" : ""}${entry.vsSpx} points on 1-year return, 52-week momentum ${formatPercent(entry.momentum1Y)}`,
    `trading ${entry.aboveSma50 ? "above" : "below"} its 50-day average and ${entry.aboveSma200 ? "above" : "below"} its 200-day average`,
    `${sector.sector} ranks #${sector.rank} in current sector rotation`,
    earningsRationaleClause(entry),
  ];
  let rationale = `${parts.join(", ")}.`;
  if (planFunds.length > 0) {
    rationale += ` Closest 401k equivalent: ${planFunds.join(", ")}.`;
  }
  return rationale;
}

/**
 * Scans a fixed candidate universe of stocks/ETFs within the top 3
 * Sector-Rotation-ranked sectors, scoring each against the S&P 500 using the
 * same momentum/trend composite as the Relative Strength agent
 * (scorePriceSeries), and surfaces only the candidates that beat the S&P
 * 500 baseline. Reads the latest completed Sector Rotation run rather than
 * recomputing it, since this agent's whole purpose is to build on that
 * signal.
 */
export async function runCandidateScannerAgent(): Promise<CandidateScannerOutput> {
  const latestSectorRun = await prisma.agentRun.findFirst({
    where: { agentType: "SECTOR_ROTATION", status: "COMPLETE" },
    orderBy: { startedAt: "desc" },
  });

  if (!latestSectorRun?.output) {
    return {
      generatedAt: new Date().toISOString(),
      topCandidates: [],
      sectorAlignment: [],
      sectorsWithoutUniverse: [],
      skipped: [],
    };
  }

  const sectorOutput = latestSectorRun.output as unknown as SectorRotationOutput;
  const topSectors = sectorOutput.topSectors.slice(0, 3);

  const [sp500Points, holdings, universeMap] = await Promise.all([
    getSp500Series(),
    getCurrentHoldings(),
    getMergedCandidateUniverse(),
  ]);
  const sp500Momentum = scorePriceSeries(sp500Points).momentum ?? 0;
  const portfolioValue = totalPortfolioValue(holdings);

  // One batched DB read for every symbol that could turn up across the scanned
  // sectors, rather than a per-symbol round trip inside the loop below.
  const candidateSymbols = Array.from(
    new Set(topSectors.flatMap((sector) => universeMap[sector.sector]?.symbols ?? [])),
  );
  const earningsScores = await getEarningsSurpriseTrendScores(candidateSymbols);

  const skipped: Array<{ symbol: string; reason: string }> = [];
  const sectorsWithoutUniverse: string[] = [];
  const scored: CandidateEntry[] = [];

  for (const sector of topSectors) {
    const universe = universeMap[sector.sector];
    if (!universe) {
      sectorsWithoutUniverse.push(sector.sector);
      continue;
    }

    for (const symbol of universe.symbols) {
      try {
        const { points } = await getPriceHistory(symbol);
        const priceScored = scorePriceSeries(points);

        // Per-symbol excess return vs. the S&P 500 over the same window —
        // each candidate's own 1-year return minus the S&P's own 1-year
        // return, not a shared/derived score delta.
        const vsSpx = Math.round(((priceScored.momentum ?? 0) - sp500Momentum) * 1000) / 10;
        if (vsSpx <= 0) continue;

        const earnings = earningsScores.get(symbol)!;

        const compositeScore = Math.max(
          0,
          Math.min(
            100,
            Math.round(
              priceScored.score * MOMENTUM_TREND_WEIGHT +
                earnings.score * EARNINGS_SURPRISE_TREND_WEIGHT +
                sector.score * SECTOR_LEADERSHIP_WEIGHT,
            ),
          ),
        );

        const planFunds = closestPlanFundsForProxy(symbol);
        const accountType: CandidateAccountType = planFunds.length > 0 ? "both" : "taxable";

        scored.push({
          symbol,
          name: CANDIDATE_NAMES[symbol] ?? symbol,
          sector: sector.sector,
          score: compositeScore,
          vsSpx,
          momentum1Y: priceScored.momentum,
          aboveSma50: priceScored.aboveSma50,
          aboveSma200: priceScored.aboveSma200,
          earningsSurpriseTrend: earnings.score,
          earningsSurpriseCoverage: earnings.coverage,
          rationale: buildRationale(
            {
              symbol,
              score: compositeScore,
              vsSpx,
              momentum1Y: priceScored.momentum,
              aboveSma50: priceScored.aboveSma50,
              aboveSma200: priceScored.aboveSma200,
              earningsSurpriseTrend: earnings.score,
              earningsSurpriseCoverage: earnings.coverage,
            },
            sector,
            planFunds,
          ),
          accountType,
        });
      } catch (err) {
        skipped.push({ symbol, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const topCandidates = scored.slice(0, MAX_TOP_CANDIDATES);

  const exposureBySector = new Map<string, number>();
  for (const holding of holdings) {
    const sector = getHoldingSector(holding.symbol, holding.name) ?? "Unclassified";
    exposureBySector.set(sector, (exposureBySector.get(sector) ?? 0) + holding.currentValue);
  }

  const sectorAlignment: SectorAlignmentEntry[] = topSectors.map((sector) => {
    const currentValue = exposureBySector.get(sector.sector) ?? 0;
    const currentExposure = portfolioValue > 0 ? currentValue / portfolioValue : 0;
    const sectorCandidates = scored.filter((c) => c.sector === sector.sector);
    const topCandidate = sectorCandidates[0]?.symbol ?? universeMap[sector.sector]?.sectorEtf ?? "—";

    return {
      sector: sector.sector,
      rotationRank: sector.rank,
      currentExposure,
      recommendedExposure: recommendedExposureLabel(currentExposure),
      topCandidate,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    topCandidates,
    sectorAlignment,
    sectorsWithoutUniverse,
    skipped,
  };
}
