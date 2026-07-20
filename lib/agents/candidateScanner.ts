import { prisma } from "@/lib/prisma";
import { getPriceHistory, getSp500Series } from "@/lib/agents/marketData";
import { scorePriceSeries } from "@/lib/agents/technicals";
import { getCurrentHoldings, totalPortfolioValue } from "@/lib/agents/holdings";
import { getHoldingSector, type SectorRotationOutput, type SectorScore } from "@/lib/agents/sectorRotation";
import { closestPlanFundsForProxy } from "@/lib/agents/fundMappings";
import { formatPercent } from "@/lib/format";

export type CandidateAccountType = "taxable" | "401k" | "both";

interface SectorUniverse {
  sectorEtf: string;
  symbols: string[];
}

/**
 * Fixed buy-candidate universe for the top-ranked sectors coming out of the
 * Sector Rotation agent. Only sectors with an entry here are scanned — a
 * sector that ranks in the top 3 but has no universe defined (e.g. Consumer
 * Staples, Materials) is reported in `sectorsWithoutUniverse` instead of
 * silently skipped.
 */
const CANDIDATE_UNIVERSE: Record<string, SectorUniverse> = {
  Technology: { sectorEtf: "XLK", symbols: ["NVDA", "MSFT", "AAPL", "AVGO", "AMD", "PLTR", "META", "TSM", "ASML", "SMCI"] },
  Healthcare: { sectorEtf: "XLV", symbols: ["UNH", "LLY", "ABBV", "JNJ", "MRK", "PFE", "TMO", "DHR", "ISRG", "DXCM"] },
  Financials: { sectorEtf: "XLF", symbols: ["BRK-B", "JPM", "V", "MA", "GS", "MS", "BAC", "AXP", "BX", "KKR"] },
  Energy: { sectorEtf: "XLE", symbols: ["XOM", "CVX", "COP", "EOG", "SLB", "PSX", "MPC", "OXY", "VLO", "HAL"] },
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

export interface CandidateEntry {
  symbol: string;
  name: string;
  sector: string;
  score: number;
  /** Score minus the S&P 500's score over the same window (points, not a percentage). */
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
    `Score ${entry.score}/100 (${entry.vsSpx > 0 ? "+" : ""}${entry.vsSpx} vs S&P 500), 52-week momentum ${formatPercent(entry.momentum1Y)}`,
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

  const [sp500Points, holdings] = await Promise.all([getSp500Series(), getCurrentHoldings()]);
  const sp500Score = scorePriceSeries(sp500Points).score;
  const portfolioValue = totalPortfolioValue(holdings);

  const skipped: Array<{ symbol: string; reason: string }> = [];
  const sectorsWithoutUniverse: string[] = [];
  const scored: CandidateEntry[] = [];

  for (const sector of topSectors) {
    const universe = CANDIDATE_UNIVERSE[sector.sector];
    if (!universe) {
      sectorsWithoutUniverse.push(sector.sector);
      continue;
    }

    for (const symbol of universe.symbols) {
      try {
        const { points } = await getPriceHistory(symbol);
        const priceScored = scorePriceSeries(points);
        if (priceScored.score <= sp500Score) continue;

        const planFunds = closestPlanFundsForProxy(symbol);
        const accountType: CandidateAccountType = planFunds.length > 0 ? "both" : "taxable";
        const vsSpx = priceScored.score - sp500Score;

        scored.push({
          symbol,
          name: CANDIDATE_NAMES[symbol] ?? symbol,
          sector: sector.sector,
          score: priceScored.score,
          vsSpx,
          momentum1Y: priceScored.momentum,
          aboveSma50: priceScored.aboveSma50,
          aboveSma200: priceScored.aboveSma200,
          rationale: buildRationale(
            { symbol, score: priceScored.score, vsSpx, momentum1Y: priceScored.momentum, aboveSma50: priceScored.aboveSma50, aboveSma200: priceScored.aboveSma200 },
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
    const sectorCandidates = topCandidates.filter((c) => c.sector === sector.sector);
    const topCandidate = sectorCandidates[0]?.symbol ?? CANDIDATE_UNIVERSE[sector.sector]?.sectorEtf ?? "—";

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
