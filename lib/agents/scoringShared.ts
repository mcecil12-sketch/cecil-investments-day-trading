import { getDynamicCandidateUniverse, type SectorUniverse } from "@/lib/agents/candidateUniverse";

/**
 * Composite weights shared by every agent that scores candidates against the
 * target 35% momentum/trend + 30% earnings surprise trend + 25% sector
 * leadership + 10% sentiment/news split. Sentiment/news has no data source in
 * this app yet, so the three implemented factors are renormalized to fill
 * 100% over their sum (90): momentum/trend at 35/90 = 38.9%, earnings
 * surprise trend at 30/90 = 33.3%, sector leadership at 25/90 = 27.8% — the
 * "39/33/28" split. Both the weekly Candidate Scanner (Group 1) and the
 * monthly scan (Group 3) import these so the weighting can't drift between
 * the two even though they run on different cadences.
 */
export const MOMENTUM_TREND_WEIGHT = 35 / 90;
export const EARNINGS_SURPRISE_TREND_WEIGHT = 30 / 90;
export const SECTOR_LEADERSHIP_WEIGHT = 25 / 90;

/**
 * 2026-09-28: A real sentiment/news data source now exists — Alpha Vantage
 * NEWS_SENTIMENT, scored 0-100 by lib/agents/newsSentimentScore.ts and
 * logged unweighted alongside the composite on every CandidateEntry /
 * MonthlyScanCandidateEntry (sentimentScore/sentimentCoverage) — but it is
 * deliberately NOT folded into MOMENTUM_TREND_WEIGHT /
 * EARNINGS_SURPRISE_TREND_WEIGHT / SECTOR_LEADERSHIP_WEIGHT above yet. We
 * already killed one factor (EARNINGS_ESTIMATES, 2026-08-06) for near-zero
 * real coverage after trusting it before it was validated; sentiment stays
 * observed-only until the Performance Analyst (lib/agents/performanceAnalyst.ts)
 * has enough weeks of real data to confirm it's actually predictive of
 * realized returns. Once validated, the three weights above go back to a
 * real 35/30/25/10 split instead of this renormalized-over-90 one.
 *
 * 2026-10-06: Fragility (extensionVs200d / vol60d / fragilityFlag, see
 * lib/agents/fragilityScore.ts) is logged on every candidate row but is
 * excluded from the composite pending validation — same observed-only
 * treatment as sentiment above. The Performance Analyst tests whether
 * flagged names underperform; no weight is changed here.
 */

/**
 * Hand-picked buy-candidate universe for sectors not yet migrated to the
 * SSGA-derived monthly refresh (see lib/agents/candidateUniverse.ts).
 * Technology, Healthcare, and Energy used to be hardcoded here too; they're
 * now sourced from CandidateUniverse (DB, refreshed monthly) and merged in at
 * runtime by getMergedCandidateUniverse below. Re-exported from
 * candidateScanner.ts for backward compatibility with existing imports.
 */
export const STATIC_CANDIDATE_UNIVERSE: Record<string, SectorUniverse> = {
  Financials: { sectorEtf: "XLF", symbols: ["BRK-B", "JPM", "V", "MA", "GS", "MS", "BAC", "AXP", "BX", "KKR"] },
  Industrials: { sectorEtf: "XLI", symbols: ["CAT", "DE", "HON", "UPS", "RTX", "GE", "LMT", "ETN", "EMR", "PH"] },
  Communications: { sectorEtf: "XLC", symbols: ["GOOGL", "META", "NFLX", "DIS", "CMCSA", "T", "VZ", "TMUS"] },
  "Consumer Discretionary": { sectorEtf: "XLY", symbols: ["AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "TGT", "LOW"] },
  "International Developed": { sectorEtf: "EFA", symbols: ["EFA", "VEA", "VXUS"] },
};

/** Display names for the candidate universe above — hardcoded since there's no ticker-name lookup API in this app. Shared by every scoring agent (weekly or monthly) that surfaces these symbols. */
export const CANDIDATE_NAMES: Record<string, string> = {
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

/** Static + DB-backed dynamic candidate universe, merged — the same buy-candidate symbol set every scoring agent (weekly or monthly) scans. */
export async function getMergedCandidateUniverse(): Promise<Record<string, SectorUniverse>> {
  const dynamicUniverse = await getDynamicCandidateUniverse();
  return { ...STATIC_CANDIDATE_UNIVERSE, ...dynamicUniverse };
}
