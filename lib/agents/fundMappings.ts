/**
 * Verizon 401k plan funds are proprietary institutional funds with no public
 * ticker, so Yahoo Finance (and Alpaca) have no price series for them. This
 * maps each fund name to the closest publicly traded index ETF or fund whose
 * price history stands in as a proxy for momentum/trend scoring.
 */
export interface FundProxy {
  proxy: string;
  /** True for actively managed funds, where the proxy's index-tracking behavior may diverge from the fund's actual performance. */
  isActive: boolean;
}

export const ACTIVE_FUND_NOTE = "Active fund — proxy score is directional only";

const FUND_PROXY_MAP: Record<string, FundProxy> = {
  "US LARGE CO INDEX": { proxy: "SPY", isActive: false },
  "PASS US EQ INDX MA": { proxy: "SPY", isActive: false },
  "US SMALL COMPANY": { proxy: "IWM", isActive: false },
  "SMALL CAP EQTY INDX": { proxy: "IWM", isActive: false },
  "ACTV US SM CAP MA": { proxy: "IWM", isActive: true },
  "AGGRESS GRW MA": { proxy: "VONG", isActive: true },
  "MAGELLAN PORTFOLIO": { proxy: "FMAGX", isActive: true },
  "EMERGING MARKETS": { proxy: "EEM", isActive: false },
  "VERIZON STOCK FUND": { proxy: "VZ", isActive: false },
  "INTL COMPANY INDEX": { proxy: "EFA", isActive: false },
  "ACTV INTL EQ MA": { proxy: "EFA", isActive: true },
  "PASS INTL EQ IND MA": { proxy: "EFA", isActive: false },
  "REIT FUND": { proxy: "VNQ", isActive: false },
  "FIAM REIT CP MA": { proxy: "VNQ", isActive: false },
  "INTL COMPANY": { proxy: "EFA", isActive: false },
  "VERIZON 2030 FUND": { proxy: "VTHRX", isActive: false },
  "VERIZON 2035 FUND": { proxy: "VTTHX", isActive: false },
  "VERIZON 2040 FUND": { proxy: "VFORX", isActive: false },
  "VERIZON 2045 FUND": { proxy: "VTIVX", isActive: false },
  "VERIZON 2050 FUND": { proxy: "VFIFX", isActive: false },
  "VERIZON 2055 FUND": { proxy: "VFFVX", isActive: false },
  "VERIZON 2060 FUND": { proxy: "VTTSX", isActive: false },
  "VERIZON 2065 FUND": { proxy: "VTTSX", isActive: false },
  "VERIZON 2070 FUND": { proxy: "VTTSX", isActive: false },
  "CONSERVV GRW MA": { proxy: "VSMGX", isActive: false },
  "MODERATE GRW MA": { proxy: "VSCGX", isActive: false },
  "LONG TERM GRW MA": { proxy: "VASGX", isActive: false },
  "CASH ACCOUNT MOODYS": { proxy: "SHV", isActive: false },
  "INTERMEDIATE US BOND": { proxy: "BND", isActive: false },
  "US CORE BOND FUND": { proxy: "BND", isActive: false },
  "US BOND INDEX FUND": { proxy: "BND", isActive: false },
  "INFLATION PROTECTED": { proxy: "TIP", isActive: false },
  "PIMCO INFL PROT BD": { proxy: "TIP", isActive: false },
  "MM PORTFOLIO": { proxy: "SHV", isActive: false },
  "PRIVATE GLOBAL RE": { proxy: "VNQ", isActive: false },
  "DIVERSIFIED INTL": { proxy: "EFA", isActive: false },
  "PIMCO CORE BOND FUND": { proxy: "BND", isActive: false },
};

/**
 * Looks up a proxy by fund symbol or name — 401k holdings are imported with
 * the plan's fund name in one or both of these fields, since there's no
 * ticker to use as the symbol.
 */
export function getFundProxy(symbol: string, name?: string | null): FundProxy | null {
  const candidates = [symbol, name].filter((v): v is string => Boolean(v)).map((v) => v.trim().toUpperCase());
  for (const candidate of candidates) {
    const match = FUND_PROXY_MAP[candidate];
    if (match) return match;
  }
  return null;
}

/**
 * Manually reported fund performance (plan statement data as of Jun 30,
 * 2026, plus YTD figures from the Fidelity balance overview screenshots as
 * of Jul 13, 2026 where noted), used in place of proxy-ETF price history
 * when available — it's the fund's own actual return rather than an
 * approximation. Grouped into a `category` so callers (e.g. the Risk
 * Manager's 401k opportunity-cost check) can compare a fund against its
 * closest peers in the known set.
 */
export type FundCategory =
  | "us-large-cap"
  | "us-small-cap"
  | "emerging-markets"
  | "intl-developed"
  | "verizon-stock"
  | "active-growth";

export interface FundReturns {
  oneYear: number;
  threeYear: number;
  fiveYear: number;
  tenYear: number;
  category: FundCategory;
  /** Year-to-date return as a decimal fraction (e.g. 0.1046 for +10.46%), as reported on the plan's Fidelity balance overview screenshots. Optional — only populated for funds where a current YTD figure is on file. */
  ytdReturn?: number;
}

export interface FundReturnsMatch extends FundReturns {
  /** The canonical KNOWN_FUND_RETURNS key that matched, for cross-referencing bestAlternativeInCategory. */
  fundName: string;
}

/** S&P 500 baseline for the same reporting period, so fund returns can be compared against actual (not price-derived) index performance. */
export const KNOWN_SP500_RETURNS = { oneYear: 0.21, threeYear: 0.18, fiveYear: 0.13 };

const KNOWN_FUND_RETURNS: Record<string, FundReturns> = {
  "US LARGE CO INDEX": { oneYear: 0.2229, threeYear: 0.2059, fiveYear: 0.1338, tenYear: 0.1549, category: "us-large-cap", ytdReturn: 0.1046 },
  "PASS US EQ INDX MA": { oneYear: 0.2229, threeYear: 0.2057, fiveYear: 0.1337, tenYear: 0.1548, category: "us-large-cap" },
  "US SMALL COMPANY": { oneYear: 0.3008, threeYear: 0.1796, fiveYear: 0.0493, tenYear: 0.136, category: "us-small-cap", ytdReturn: 0.1653 },
  "SMALL CAP EQTY INDX": { oneYear: 0.4092, threeYear: 0.1872, fiveYear: 0.0712, tenYear: 0.1047, category: "us-small-cap", ytdReturn: -0.0186 },
  "ACTV US SM CAP MA": { oneYear: 0.3043, threeYear: 0.1805, fiveYear: 0.0527, tenYear: 0.1384, category: "us-small-cap" },
  "AGGRESS GRW MA": { oneYear: 0.215, threeYear: 0.1707, fiveYear: 0.0674, tenYear: 0.1234, category: "active-growth" },
  "MAGELLAN PORTFOLIO": { oneYear: 0.0767, threeYear: 0.1917, fiveYear: 0.1088, tenYear: 0.1787, category: "active-growth" },
  "EMERGING MARKETS": { oneYear: 0.3728, threeYear: 0.1964, fiveYear: 0.0454, tenYear: 0.0902, category: "emerging-markets", ytdReturn: -0.0285 },
  "VERIZON STOCK FUND": { oneYear: 0.0453, threeYear: 0.1169, fiveYear: 0.0066, tenYear: 0.0257, category: "verizon-stock" },
  "INTL COMPANY INDEX": { oneYear: 0.2048, threeYear: 0.1677, fiveYear: 0.0942, tenYear: 0.0999, category: "intl-developed" },
  "ACTV INTL EQ MA": { oneYear: 0.1411, threeYear: 0.1367, fiveYear: 0.0617, tenYear: 0.0848, category: "intl-developed" },
  "DIVERSIFIED INTL": { oneYear: 0.2295, threeYear: 0.1749, fiveYear: 0.0838, tenYear: 0.1483, category: "intl-developed" },
};

/** Looks up known reported returns by fund symbol or name, same dual-lookup convention as getFundProxy. */
export function getKnownFundReturns(symbol: string, name?: string | null): FundReturnsMatch | null {
  const candidates = [symbol, name].filter((v): v is string => Boolean(v)).map((v) => v.trim().toUpperCase());
  for (const candidate of candidates) {
    const match = KNOWN_FUND_RETURNS[candidate];
    if (match) return { ...match, fundName: candidate };
  }
  return null;
}

/** The best-returning known fund in the same category, excluding the fund itself — used to size opportunity cost. */
export function bestAlternativeInCategory(
  excludeFundName: string,
  category: FundCategory,
  horizon: "threeYear" | "fiveYear" = "fiveYear",
): { fundName: string; returns: FundReturns } | null {
  let best: { fundName: string; returns: FundReturns } | null = null;
  for (const [fundName, returns] of Object.entries(KNOWN_FUND_RETURNS)) {
    if (fundName === excludeFundName || returns.category !== category) continue;
    if (!best || returns[horizon] > best.returns[horizon]) best = { fundName, returns };
  }
  return best;
}
