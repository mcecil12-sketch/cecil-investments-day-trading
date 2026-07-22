import { prisma } from "@/lib/prisma";
import { getPriceHistory, getSp500Series } from "@/lib/agents/marketData";
import { scorePriceSeries } from "@/lib/agents/technicals";
import { getCurrentHoldings, totalPortfolioValue } from "@/lib/agents/holdings";
import { getHoldingSector, type SectorRotationOutput, type SectorScore } from "@/lib/agents/sectorRotation";
import { closestPlanFundsForProxy } from "@/lib/agents/fundMappings";
import { getDynamicCandidateUniverse, type SectorUniverse } from "@/lib/agents/candidateUniverse";
import { formatPercent } from "@/lib/format";

export type CandidateAccountType = "taxable" | "401k" | "both";

/**
 * Hand-picked buy-candidate universe for sectors not yet migrated to the
 * SSGA-derived monthly refresh (see lib/agents/candidateUniverse.ts).
 * Technology, Healthcare, and Energy used to be hardcoded here too; they're
 * now sourced from CandidateUniverse (DB, refreshed monthly) and merged in at
 * runtime in runCandidateScannerAgent — see DYNAMIC_SECTORS.
 */
const STATIC_CANDIDATE_UNIVERSE: Record<string, SectorUniverse> = {
  Financials: { sectorEtf: "XLF", symbols: ["BRK-B", "JPM", "V", "MA", "GS", "MS", "BAC", "AXP", "BX", "KKR"] },
  Industrials: { sectorEtf: "XLI", symbols: ["CAT", "DE", "HON", "UPS", "RTX", "GE", "LMT", "ETN", "EMR", "PH"] },
  Communications: { sectorEtf: "XLC", symbols: ["GOOGL", "META", "NFLX", "DIS", "CMCSA", "T", "VZ", "TMUS"] },
  "Consumer Discretionary": { sectorEtf: "XLY", symbols: ["AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "TGT", "LOW"] },
  "International Developed": { sectorEtf: "EFA", symbols: ["EFA", "VEA", "VXUS"] },
};

/** Display names for the fixed candidate universe above — hardcoded since there's no ticker-name lookup API in this app. */
const CANDIDATE_NAMES: Record<string, string> = {
  NVDA: "NVIDIA", MSFT: "Microsoft", AAPL: "Apple", AVGO: "Broadcom", AMD: "Advanced Micro Devices",
  PLTR: "Palantir Technologies", META: "Meta Platforms", TSM: "Taiwan Semiconductor Manufacturing",
  ASML: "ASML Holding", SMCI: "Super Micro Computer",
  UNH: "UnitedHealth Group", LLY: "Eli Lilly", ABBV: "AbbVie", JNJ: "Johnson & Johnson", MRK: "Merck",
  PFE: "Pfizer", TMO: "Thermo Fisher Scientific", DHR: "Danaher", ISRG: "Intuitive Surgical", DXCM: "Dexcom",
  "BRK-B": "Berkshire Hathaway (Class B)", JPM: "JPMorgan Chase", V: "Visa", MA: "Mastercard",
  GS: "Goldman Sachs", MS: "Morgan Stanley", BAC: "Bank of America", AXP: "American Express",
  BX: "Blackstone", KKR: "KKR & Co.",
  XOM: "Exxon Mobil", CVX: "Chevron", COP: "ConocoPhillips", EOG: "EOG Resources", SLB: "Schlumberger",
  PSX: "Phillips 66", MPC: "Marathon Petroleum", OXY: "Occidental Petroleum", VLO: "Valero Energy", HAL: "Halliburton",
  CAT: "Caterpillar", DE: "Deere & Co.", HON: "Honeywell", UPS: "United Parcel Service", RTX: "RTX Corporation",
  GE: "GE Aerospace", LMT: "Lockheed Martin", ETN: "Eaton", EMR: "Emerson Electric", PH: "Parker Hannifin",
  GOOGL: "Alphabet (Class A)", NFLX: "Netflix", DIS: "Walt Disney", CMCSA: "Comcast", T: "AT&T",
  VZ: "Verizon Communications", TMUS: "T-Mobile US",
  AMZN: "Amazon", TSLA: "Tesla", HD: "Home Depot", MCD: "McDonald's", NKE: "Nike", SBUX: "Starbucks",
  TGT: "Target", LOW: "Lowe's",
  EFA: "iShares MSCI EAFE ETF", VEA: "Vanguard FTSE Developed Markets ETF", VXUS: "Vanguard Total International Stock ETF",
};

/** How many of the top-scoring candidates to surface across all scanned sectors. */
const MAX_TOP_CANDIDATES = 10;

/**
 * Weights for the two composite factors implemented today, renormalized from
 * the target 35% momentum/trend + 25% sector leadership (out of a full
 * 35/30/25/10 momentum-trend/earnings-acceleration/sector-leadership/sentiment
 * split) so the implemented factors still sum to 100%. Earnings acceleration
 * and sentiment/news are deferred until this app has a data source for them.
 */
const MOMENTUM_TREND_WEIGHT = 35 / 60;
const SECTOR_LEADERSHIP_WEIGHT = 25 / 60;

export interface CandidateEntry {
  symbol: string;
  name: string;
  sector: string;
  /**
   * 0-100 composite. The target composite is momentum/trend (35%) +
   * earnings acceleration (30%) + sector leadership (25%) + sentiment/news
   * (10%); earnings acceleration and sentiment have no data source in this
   * app yet, so those two factors are deferred and the two implemented
   * factors are renormalized to fill 100%: momentum/trend at 35/60 = 58.3%,
   * sector leadership at 25/60 = 41.7%. See MOMENTUM_TREND_WEIGHT /
   * SECTOR_LEADERSHIP_WEIGHT below.
   */
  score: number;
  /** This symbol's own 1-year return minus the S&P 500's 1-year return over the same window, in percentage points. Computed per-symbol, not shared. */
  vsSpx: number;
  momentum1Y: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
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

function buildRationale(
  entry: Pick<CandidateEntry, "symbol" | "score" | "vsSpx" | "momentum1Y" | "aboveSma50" | "aboveSma200">,
  sector: SectorScore,
  planFunds: string[],
): string {
  const parts = [
    `Score ${entry.score}/100, outperforming the S&P 500 by ${entry.vsSpx > 0 ? "+" : ""}${entry.vsSpx} points on 1-year return, 52-week momentum ${formatPercent(entry.momentum1Y)}`,
    `trading ${entry.aboveSma50 ? "above" : "below"} its 50-day average and ${entry.aboveSma200 ? "above" : "below"} its 200-day average`,
    `${sector.sector} ranks #${sector.rank} in current sector rotation`,
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

  const [sp500Points, holdings, dynamicUniverse] = await Promise.all([
    getSp500Series(),
    getCurrentHoldings(),
    getDynamicCandidateUniverse(),
  ]);
  const universeMap: Record<string, SectorUniverse> = { ...STATIC_CANDIDATE_UNIVERSE, ...dynamicUniverse };
  const sp500Momentum = scorePriceSeries(sp500Points).momentum ?? 0;
  const portfolioValue = totalPortfolioValue(holdings);

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

        const compositeScore = Math.max(
          0,
          Math.min(100, Math.round(priceScored.score * MOMENTUM_TREND_WEIGHT + sector.score * SECTOR_LEADERSHIP_WEIGHT)),
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
          rationale: buildRationale(
            { symbol, score: compositeScore, vsSpx, momentum1Y: priceScored.momentum, aboveSma50: priceScored.aboveSma50, aboveSma200: priceScored.aboveSma200 },
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
