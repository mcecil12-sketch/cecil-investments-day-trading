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
  /** Mid-Atlantic's distinct "Small Cap Eqty Indx" fund — same informal display name as the Savings Plan fund above, but a different underlying fund with its own public ticker, which is why it gets its own map key instead of colliding with "SMALL CAP EQTY INDX". See KNOWN_FUND_RETURNS for the disambiguation. */
  "TGFD": { proxy: "IWM", isActive: false },
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
 * Reverse lookup: given a publicly traded symbol (e.g. a Candidate Scanner
 * result), returns the Verizon plan fund name(s) that use it as their price
 * proxy — i.e. the closest available 401k fund for that symbol's exposure.
 * Empty array when no plan fund proxies to this symbol.
 */
export function closestPlanFundsForProxy(symbol: string): string[] {
  const target = symbol.trim().toUpperCase();
  return Object.entries(FUND_PROXY_MAP)
    .filter(([, proxy]) => proxy.proxy.toUpperCase() === target)
    .map(([fundName]) => fundName);
}

/**
 * Manually reported fund performance (plan statement data as of Jun 30,
 * 2026, plus YTD figures verified against live Fidelity plan performance
 * pages as of Jul 24, 2026 where noted), used in place of proxy-ETF price
 * history when available — it's the fund's own actual return rather than an
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

/**
 * The two Verizon 401k plans that each have their own fund menu. A fund's
 * `plan` tag scopes which menu it belongs to, so bestAlternativeInCategory
 * only ever compares a holding against other funds actually available for
 * swap within the same plan — see the Phase 1 fix in AUDIT.md history for
 * why this matters: two plans each have a fund informally called "Small Cap
 * Eqty Indx", and without plan scoping the risk manager could recommend
 * "swapping into" a fund the holder's plan doesn't even offer.
 */
export type RetirementPlanId = "VZ_SAVINGS_401K" | "VZ_LEGACY_401K";

export interface FundReturns {
  oneYear: number;
  /** Omitted for funds too recently added to a plan's menu to have a real 3/5/10-year track record — see shortHistory. */
  threeYear?: number;
  fiveYear?: number;
  tenYear?: number;
  category: FundCategory;
  plan: RetirementPlanId;
  /** Year-to-date return as a decimal fraction (e.g. 0.1046 for +10.46%), as verified against the plan's Fidelity performance page. Optional — only populated for funds where a current YTD figure is on file. */
  ytdReturn?: number;
  /** True when this fund's absence of 3/5/10-year figures reflects it being newly added to the plan's menu, not a data gap — callers should present it as "recently added" rather than implying a novel/unproven strategy. */
  shortHistory?: boolean;
}

export interface FundReturnsMatch extends FundReturns {
  /** The canonical KNOWN_FUND_RETURNS key that matched, for cross-referencing bestAlternativeInCategory. */
  fundName: string;
}

/** S&P 500 baseline for the same reporting period, so fund returns can be compared against actual (not price-derived) index performance. */
export const KNOWN_SP500_RETURNS = { oneYear: 0.21, threeYear: 0.18, fiveYear: 0.13 };

const KNOWN_FUND_RETURNS_BY_PLAN: Record<RetirementPlanId, Record<string, FundReturns>> = {
  VZ_SAVINGS_401K: {
    "US LARGE CO INDEX": { oneYear: 0.2229, threeYear: 0.2059, fiveYear: 0.1338, tenYear: 0.1549, category: "us-large-cap", plan: "VZ_SAVINGS_401K", ytdReturn: 0.0897 },
    "US SMALL COMPANY": { oneYear: 0.3008, threeYear: 0.1796, fiveYear: 0.0493, tenYear: 0.136, category: "us-small-cap", plan: "VZ_SAVINGS_401K", ytdReturn: 0.1477 },
    "SMALL CAP EQTY INDX": { oneYear: 0.4092, threeYear: 0.1872, fiveYear: 0.0712, tenYear: 0.1047, category: "us-small-cap", plan: "VZ_SAVINGS_401K", ytdReturn: -0.0261 },
    "EMERGING MARKETS": { oneYear: 0.3728, threeYear: 0.1964, fiveYear: 0.0454, tenYear: 0.0902, category: "emerging-markets", plan: "VZ_SAVINGS_401K", ytdReturn: -0.0448 },
    /** Company stock match fund — held under multiple Verizon plans/EDP; tagged here nominally since it has no in-category peer to compare against, so the plan tag doesn't affect any bestAlternativeInCategory match. */
    "VERIZON STOCK FUND": { oneYear: 0.0453, threeYear: 0.1169, fiveYear: 0.0066, tenYear: 0.0257, category: "verizon-stock", plan: "VZ_SAVINGS_401K" },
    "INTL COMPANY INDEX": { oneYear: 0.2048, threeYear: 0.1677, fiveYear: 0.0942, tenYear: 0.0999, category: "intl-developed", plan: "VZ_SAVINGS_401K" },
    "DIVERSIFIED INTL": { oneYear: 0.2295, threeYear: 0.1749, fiveYear: 0.0838, tenYear: 0.1483, category: "intl-developed", plan: "VZ_SAVINGS_401K" },
  },
  VZ_LEGACY_401K: {
    "PASS US EQ INDX MA": { oneYear: 0.2229, threeYear: 0.2057, fiveYear: 0.1337, tenYear: 0.1548, category: "us-large-cap", plan: "VZ_LEGACY_401K", ytdReturn: 0.0897 },
    "ACTV US SM CAP MA": { oneYear: 0.3043, threeYear: 0.1805, fiveYear: 0.0527, tenYear: 0.1384, category: "us-small-cap", plan: "VZ_LEGACY_401K", ytdReturn: -0.0321 },
    "AGGRESS GRW MA": { oneYear: 0.215, threeYear: 0.1707, fiveYear: 0.0674, tenYear: 0.1234, category: "active-growth", plan: "VZ_LEGACY_401K", ytdReturn: 0.0887 },
    /** Corrected Phase 1 mapping — Magellan Portfolio belongs to Verizon Mid-Atlantic (VZ_LEGACY_401K), not the Savings Plan. Previously mis-mapped, which made bestAlternativeInCategory miss AGGRESS GRW MA as a real same-plan active-growth alternative. */
    "MAGELLAN PORTFOLIO": { oneYear: 0.0767, threeYear: 0.1917, fiveYear: 0.1088, tenYear: 0.1787, category: "active-growth", plan: "VZ_LEGACY_401K", ytdReturn: 0.0347 },
    "ACTV INTL EQ MA": { oneYear: 0.1411, threeYear: 0.1367, fiveYear: 0.0617, tenYear: 0.0848, category: "intl-developed", plan: "VZ_LEGACY_401K" },
    /** Mid-Atlantic's own distinct "Small Cap Eqty Indx" fund (ticker TGFD) — not currently held, and recently added to this plan's menu, hence no 3/5/10-year figures on file yet. Do NOT collapse this with the Savings Plan's same-named fund above; they are different funds with different returns. */
    "TGFD": { oneYear: 0.4095, category: "us-small-cap", plan: "VZ_LEGACY_401K", ytdReturn: 0.1887, shortHistory: true },
  },
};

/** Flattened view across both plans, for callers (momentum scoring) that just need "the known returns for this holding" regardless of which plan it's in — safe to merge since fund identities no longer collide across plans (see RetirementPlanId). */
const KNOWN_FUND_RETURNS: Record<string, FundReturns> = {
  ...KNOWN_FUND_RETURNS_BY_PLAN.VZ_SAVINGS_401K,
  ...KNOWN_FUND_RETURNS_BY_PLAN.VZ_LEGACY_401K,
};

/** Composite-return weights — 20% YTD, 30% 1Y, 30% 3Y, 20% 5Y — the same blend `relativeStrength.ts` applies to held-fund momentum scoring, reused here for 401k plan fund comparisons. Kept as its own copy rather than a shared import so nothing in the momentum-scoring path is touched by callers of this one. */
export const YTD_WEIGHT = 0.2;
export const ONE_YEAR_WEIGHT = 0.3;
export const THREE_YEAR_WEIGHT = 0.3;
export const FIVE_YEAR_WEIGHT = 0.2;

/** Minimum gap (percentage points, as a fraction) between YTD and 1Y returns, in opposite directions, before it's worth flagging as a divergence to verify — same threshold as relativeStrength.ts's per-holding flag. */
export const YTD_1Y_DIVERGENCE_THRESHOLD = 0.15;

/** Blends YTD/1Y/3Y/5Y into a single composite return when a YTD figure and full 3/5-year history are all on file; otherwise falls back to 1Y alone (short-history or no-YTD funds), matching relativeStrength.ts's fallback rule. */
export function compositeReturn(returns: {
  ytdReturn?: number | null;
  oneYear: number;
  threeYear?: number | null;
  fiveYear?: number | null;
}): number {
  const { ytdReturn, oneYear, threeYear, fiveYear } = returns;
  if (ytdReturn != null && threeYear != null && fiveYear != null) {
    return ytdReturn * YTD_WEIGHT + oneYear * ONE_YEAR_WEIGHT + threeYear * THREE_YEAR_WEIGHT + fiveYear * FIVE_YEAR_WEIGHT;
  }
  return oneYear;
}

/** Null unless YTD and 1Y point in opposite directions and are more than YTD_1Y_DIVERGENCE_THRESHOLD apart — e.g. a strong 1Y return riding on a since-reversed rally, or a weak 1Y masking a recent recovery. */
export function ytdDivergenceFlag(ytdReturn: number | null | undefined, oneYear: number): string | null {
  if (ytdReturn == null) return null;
  const oppositeSigns = (ytdReturn > 0 && oneYear < 0) || (ytdReturn < 0 && oneYear > 0);
  if (oppositeSigns && Math.abs(ytdReturn - oneYear) > YTD_1Y_DIVERGENCE_THRESHOLD) {
    return "YTD/1Y divergence — verify before acting";
  }
  return null;
}

/** Looks up known reported returns by fund symbol or name, same dual-lookup convention as getFundProxy. Plan-agnostic — use bestAlternativeInCategory for plan-scoped comparisons. */
export function getKnownFundReturns(symbol: string, name?: string | null): FundReturnsMatch | null {
  const candidates = [symbol, name].filter((v): v is string => Boolean(v)).map((v) => v.trim().toUpperCase());
  for (const candidate of candidates) {
    const match = KNOWN_FUND_RETURNS[candidate];
    if (match) return { ...match, fundName: candidate };
  }
  return null;
}

/** The best-returning known fund in the same category and same plan menu, excluding the fund itself — used to size opportunity cost. Returns null (rather than a cross-plan match) when no real same-plan alternative exists. */
export function bestAlternativeInCategory(
  plan: RetirementPlanId,
  excludeFundName: string,
  category: FundCategory,
  horizon: "threeYear" | "fiveYear" = "fiveYear",
): { fundName: string; returns: FundReturns } | null {
  let best: { fundName: string; returns: FundReturns } | null = null;
  for (const [fundName, returns] of Object.entries(KNOWN_FUND_RETURNS_BY_PLAN[plan])) {
    if (fundName === excludeFundName || returns.category !== category) continue;
    const value = returns[horizon];
    if (value == null) continue;
    if (!best || value > (best.returns[horizon] ?? -Infinity)) best = { fundName, returns };
  }
  return best;
}
