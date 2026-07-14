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
