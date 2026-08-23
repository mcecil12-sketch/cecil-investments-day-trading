import { prisma } from "@/lib/prisma";
import { getPriceHistory, getSp500Series } from "@/lib/agents/marketData";
import { scorePriceSeries } from "@/lib/agents/technicals";
import type { SectorRotationOutput, SectorScore } from "@/lib/agents/sectorRotation";
import { closestPlanFundsForProxy } from "@/lib/agents/fundMappings";
import {
  MOMENTUM_TREND_WEIGHT,
  EARNINGS_SURPRISE_TREND_WEIGHT,
  SECTOR_LEADERSHIP_WEIGHT,
  CANDIDATE_NAMES,
  getMergedCandidateUniverse,
} from "@/lib/agents/scoringShared";
import { getMonthlyScanEarningsScores } from "@/lib/agents/monthlyScanEarnings";
import type { EarningsSurpriseTrendCoverage } from "@/lib/agents/earningsSurpriseTrend";
import type { CandidateAccountType } from "@/lib/agents/candidateScanner";
import { formatPercent } from "@/lib/format";

/**
 * Group 3 needs visibility well past SELL_RANK_THRESHOLD (20, see
 * monthlyScanBanding.ts) so backfill candidates below the sell line are
 * still inspectable — unlike Group 1's MAX_TOP_CANDIDATES (15), which only
 * needs to cover its own display list.
 */
export const MAX_TRACKED_CANDIDATES = 30;

export interface MonthlyScanCandidateEntry {
  symbol: string;
  name: string;
  sector: string;
  /** 1 = strongest composite score this run. */
  rank: number;
  score: number;
  vsSpx: number;
  momentum1Y: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  earningsSurpriseTrend: number;
  earningsSurpriseCoverage: EarningsSurpriseTrendCoverage;
  rationale: string;
  accountType: CandidateAccountType;
  /** What data this score was actually frozen against, for point-in-time auditability — never retroactively updated once written. */
  dataAvailability: {
    earningsFiscalDateEndingUsed: string | null;
    earningsCoverage: EarningsSurpriseTrendCoverage;
    sectorRotationRunId: string;
    sectorRotationAsOf: string;
  };
}

export interface MonthlyScanOutput {
  generatedAt: string;
  /** "cron" = the real monthly cycle (piggybacked on refresh-candidate-universe); "manual" = an on-demand test/rerun. Only "cron" runs count toward Group 3's trading-readiness banner. */
  triggerSource: "cron" | "manual";
  rankedCandidates: MonthlyScanCandidateEntry[];
  sectorsWithoutUniverse: string[];
  skipped: Array<{ symbol: string; reason: string }>;
}

function buildRationale(
  entry: Pick<
    MonthlyScanCandidateEntry,
    "symbol" | "score" | "vsSpx" | "momentum1Y" | "aboveSma50" | "aboveSma200" | "earningsSurpriseTrend" | "earningsSurpriseCoverage"
  >,
  sector: SectorScore,
  planFunds: string[],
): string {
  const parts = [
    `Score ${entry.score}/100, outperforming the S&P 500 by ${entry.vsSpx > 0 ? "+" : ""}${entry.vsSpx} points on 1-year return, 52-week momentum ${formatPercent(entry.momentum1Y)}`,
    `trading ${entry.aboveSma50 ? "above" : "below"} its 50-day average and ${entry.aboveSma200 ? "above" : "below"} its 200-day average`,
    `${sector.sector} ranks #${sector.rank} in current sector rotation`,
    `earnings surprise trend ${entry.earningsSurpriseTrend}/100 (${entry.earningsSurpriseCoverage})`,
  ];
  let rationale = `${parts.join(", ")}.`;
  if (planFunds.length > 0) rationale += ` Closest 401k equivalent: ${planFunds.join(", ")}.`;
  return rationale;
}

/**
 * Group 3 — monthly-cadence scan with rank-based buy/sell banding (see
 * monthlyScanBanding.ts), intended to become the human-actionable
 * recommendation source for the "For Kennedy" taxable account once it has
 * one full live monthly cycle (see triggerSource above).
 *
 * Momentum and sector-leadership reuse the exact same building blocks as the
 * weekly Candidate Scanner (Group 1) — scorePriceSeries and the latest
 * completed Sector Rotation run — just called monthly instead of weekly.
 * Earnings-surprise-trend is the one factor with different cadence logic:
 * see getMonthlyScanEarningsScores for the quarterly-triggered recompute.
 *
 * Filtered to taxable-eligible candidates (accountType !== "401k") since
 * this feeds a taxable account's trading decisions.
 */
export async function runMonthlyScanAgent(triggerSource: "cron" | "manual"): Promise<MonthlyScanOutput> {
  const latestSectorRun = await prisma.agentRun.findFirst({
    where: { agentType: "SECTOR_ROTATION", status: "COMPLETE" },
    orderBy: { startedAt: "desc" },
  });

  if (!latestSectorRun?.output) {
    return { generatedAt: new Date().toISOString(), triggerSource, rankedCandidates: [], sectorsWithoutUniverse: [], skipped: [] };
  }

  const sectorOutput = latestSectorRun.output as unknown as SectorRotationOutput;
  const topSectors = sectorOutput.topSectors.slice(0, 3);

  const [sp500Points, universeMap] = await Promise.all([getSp500Series(), getMergedCandidateUniverse()]);
  const sp500Momentum = scorePriceSeries(sp500Points).momentum ?? 0;

  const candidateSymbols = Array.from(
    new Set(topSectors.flatMap((sector) => universeMap[sector.sector]?.symbols ?? [])),
  );
  const earningsScores = await getMonthlyScanEarningsScores(candidateSymbols);

  const skipped: Array<{ symbol: string; reason: string }> = [];
  const sectorsWithoutUniverse: string[] = [];
  const scored: Array<Omit<MonthlyScanCandidateEntry, "rank">> = [];

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
        // "both"/"taxable" only — same construction as candidateScanner.ts, which
        // never produces "401k" here; this feeds a taxable account, so every
        // candidate this loop produces is already taxable-eligible by construction.
        const accountType: CandidateAccountType = planFunds.length > 0 ? "both" : "taxable";

        const entry: Omit<MonthlyScanCandidateEntry, "rank"> = {
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
          rationale: "",
          accountType,
          dataAvailability: {
            earningsFiscalDateEndingUsed: earnings.fiscalDateEndingUsed?.toISOString() ?? null,
            earningsCoverage: earnings.coverage,
            sectorRotationRunId: latestSectorRun.id,
            sectorRotationAsOf: sectorOutput.generatedAt,
          },
        };
        entry.rationale = buildRationale(entry, sector, planFunds);
        scored.push(entry);
      } catch (err) {
        skipped.push({ symbol, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const rankedCandidates: MonthlyScanCandidateEntry[] = scored
    .slice(0, MAX_TRACKED_CANDIDATES)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));

  return { generatedAt: new Date().toISOString(), triggerSource, rankedCandidates, sectorsWithoutUniverse, skipped };
}

