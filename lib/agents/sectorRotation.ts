import { getPriceHistory, getSp500Series, type PricePoint } from "@/lib/agents/marketData";
import { getCurrentHoldings, totalPortfolioValue } from "@/lib/agents/holdings";
import { momentumOverDays, momentumTo100 } from "@/lib/agents/technicals";
import { formatPercent } from "@/lib/format";

const SECTOR_ETFS: Array<{ symbol: string; sector: string }> = [
  { symbol: "XLK", sector: "Technology" },
  { symbol: "XLF", sector: "Financials" },
  { symbol: "XLE", sector: "Energy" },
  { symbol: "XLV", sector: "Healthcare" },
  { symbol: "XLI", sector: "Industrials" },
  { symbol: "XLC", sector: "Communications" },
  { symbol: "XLY", sector: "Consumer Discretionary" },
  { symbol: "XLP", sector: "Consumer Staples" },
  { symbol: "XLB", sector: "Materials" },
  { symbol: "XLU", sector: "Utilities" },
  { symbol: "XLRE", sector: "Real Estate" },
  { symbol: "VWO", sector: "Emerging Markets" },
  { symbol: "EFA", sector: "International Developed" },
];

/**
 * Portfolio holdings mapped to the sector (or style bucket) whose rotation
 * signal they're most exposed to. Entries that match a SECTOR_ETFS sector
 * name (e.g. "Technology", "Communications") plug directly into the ranked
 * sector table; the style buckets ("Broad Market", "Small Cap", "Active
 * Growth", "Growth/Multi-Sector") have no single-sector ETF equivalent and
 * only appear in the exposure summary.
 */
const HOLDING_SECTOR_MAP: Record<string, string> = {
  FSELX: "Technology",
  FSPGX: "Growth/Multi-Sector",
  IWF: "Growth/Multi-Sector",
  FXAIX: "Broad Market",
  "US LARGE CO INDEX": "Broad Market",
  "PASS US EQ INDX MA": "Broad Market",
  FTIHX: "International Developed",
  "INTL COMPANY INDEX": "International Developed",
  "ACTV INTL EQ MA": "International Developed",
  "DIVERSIFIED INTL": "International Developed",
  "EMERGING MARKETS": "Emerging Markets",
  "US SMALL COMPANY": "Small Cap",
  "SMALL CAP EQTY INDX": "Small Cap",
  "ACTV US SM CAP MA": "Small Cap",
  "AGGRESS GRW MA": "Active Growth",
  "MAGELLAN PORTFOLIO": "Active Growth",
  "VERIZON STOCK FUND": "Communications",
};

export function getHoldingSector(symbol: string, name?: string | null): string | null {
  const candidates = [symbol, name].filter((v): v is string => Boolean(v)).map((v) => v.trim().toUpperCase());
  for (const candidate of candidates) {
    const match = HOLDING_SECTOR_MAP[candidate];
    if (match) return match;
  }
  return null;
}

export interface SectorMomentum {
  oneMonth: number | null;
  threeMonth: number | null;
  twelveMonth: number | null;
  /** 0-100 composite: 1M momentum (40%) + 3M momentum (35%) + 12M momentum (25%). */
  score: number;
}

export interface SectorScore extends SectorMomentum {
  sector: string;
  symbol: string;
  /** 1 = strongest composite score. */
  rank: number;
}

export interface PortfolioSectorExposure {
  sector: string;
  value: number;
  percentOfPortfolio: number;
  /** The sector's composite rotation score, or null for style buckets with no matching sector ETF. */
  rotationScore: number | null;
}

export interface SectorRotationFlag {
  type: "overweight_weakening" | "underweight_leading";
  sector: string;
  detail: string;
}

export interface SectorRotationOutput {
  generatedAt: string;
  sp500: SectorMomentum;
  rankedSectors: SectorScore[];
  topSectors: SectorScore[];
  bottomSectors: SectorScore[];
  portfolioExposure: PortfolioSectorExposure[];
  recommendations: string[];
  flags: SectorRotationFlag[];
  skipped: Array<{ symbol: string; reason: string }>;
}

const OVERWEIGHT_THRESHOLD = 0.15;
const UNDERWEIGHT_THRESHOLD = 0.02;

function scoreSectorSeries(rawPoints: PricePoint[]): SectorMomentum {
  const points = [...rawPoints].sort((a, b) => a.date.getTime() - b.date.getTime());
  const oneMonth = momentumOverDays(points, 30);
  const threeMonth = momentumOverDays(points, 90);
  const twelveMonth = momentumOverDays(points, 365);
  const score = Math.max(
    0,
    Math.min(100, Math.round(momentumTo100(oneMonth) * 0.4 + momentumTo100(threeMonth) * 0.35 + momentumTo100(twelveMonth) * 0.25)),
  );
  return { oneMonth, threeMonth, twelveMonth, score };
}

/**
 * Ranks each sector ETF on blended 1M/3M/12M momentum, maps current
 * portfolio holdings onto those sectors (or style buckets) to compute
 * exposure, and flags mismatches between where the portfolio is concentrated
 * and where relative strength is currently rotating.
 */
export async function runSectorRotationAgent(): Promise<SectorRotationOutput> {
  const [sp500Points, holdings] = await Promise.all([getSp500Series(), getCurrentHoldings()]);
  const sp500 = scoreSectorSeries(sp500Points);

  const scored: Array<SectorScore> = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];

  for (const { symbol, sector } of SECTOR_ETFS) {
    try {
      const { points } = await getPriceHistory(symbol);
      scored.push({ sector, symbol, rank: 0, ...scoreSectorSeries(points) });
    } catch (err) {
      skipped.push({ symbol, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const rankedSectors = [...scored].sort((a, b) => b.score - a.score).map((s, i) => ({ ...s, rank: i + 1 }));
  const topSectors = rankedSectors.slice(0, 3);
  const bottomSectors = rankedSectors.slice(-3).reverse();

  const totalValue = totalPortfolioValue(holdings);
  const exposureMap = new Map<string, number>();
  for (const holding of holdings) {
    const sector = getHoldingSector(holding.symbol, holding.name) ?? "Unclassified";
    exposureMap.set(sector, (exposureMap.get(sector) ?? 0) + holding.currentValue);
  }

  const portfolioExposure: PortfolioSectorExposure[] = Array.from(exposureMap.entries())
    .map(([sector, value]) => ({
      sector,
      value,
      percentOfPortfolio: totalValue > 0 ? value / totalValue : 0,
      rotationScore: rankedSectors.find((r) => r.sector === sector)?.score ?? null,
    }))
    .sort((a, b) => b.value - a.value);

  const recommendations = topSectors.map(
    (s) => `Overweight ${s.sector} (${s.symbol}) — composite score ${s.score}/100, 3M momentum ${formatPercent(s.threeMonth)}.`,
  );

  const flags: SectorRotationFlag[] = [];
  const bottomSet = new Set(bottomSectors.map((s) => s.sector));
  const topSet = new Set(topSectors.map((s) => s.sector));

  for (const exposure of portfolioExposure) {
    if (bottomSet.has(exposure.sector) && exposure.percentOfPortfolio >= OVERWEIGHT_THRESHOLD) {
      flags.push({
        type: "overweight_weakening",
        sector: exposure.sector,
        detail: `${formatPercent(exposure.percentOfPortfolio)} of portfolio is in ${exposure.sector}, one of the weakest-ranked sectors.`,
      });
    }
  }
  for (const sector of topSet) {
    const pct = portfolioExposure.find((e) => e.sector === sector)?.percentOfPortfolio ?? 0;
    if (pct < UNDERWEIGHT_THRESHOLD) {
      flags.push({
        type: "underweight_leading",
        sector,
        detail: `Only ${formatPercent(pct)} of portfolio is in ${sector}, one of the strongest-ranked sectors.`,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sp500,
    rankedSectors,
    topSectors,
    bottomSectors,
    portfolioExposure,
    recommendations,
    flags,
    skipped,
  };
}
