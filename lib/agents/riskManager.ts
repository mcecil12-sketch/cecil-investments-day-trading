import type { AccountType } from "@/lib/generated/prisma";
import { getCurrentHoldings, totalPortfolioValue, type CurrentHolding } from "@/lib/agents/holdings";
import { scoreCurrentHoldings } from "@/lib/agents/relativeStrength";
import { getHoldingSector } from "@/lib/agents/sectorRotation";
import { isLockedInstrument } from "@/lib/benchmark/lockedHoldings";
import { getKnownFundReturns, bestAlternativeInCategory, KNOWN_SP500_RETURNS } from "@/lib/agents/fundMappings";
import { formatPercent, formatCurrency } from "@/lib/format";

export type RiskSeverity = "critical" | "watch" | "informational";

export interface RiskFlag {
  severity: RiskSeverity;
  check:
    | "concentration"
    | "locked-stock"
    | "sector-concentration"
    | "momentum-deterioration"
    | "underperformer-persistence"
    | "drawdown";
  symbol: string | null;
  title: string;
  detail: string;
  accountId: string | null;
}

export interface OpportunityCostEntry {
  symbol: string;
  name: string | null;
  currentValue: number;
  category: string;
  fundFiveYear: number;
  alternativeName: string;
  alternativeFiveYear: number;
  /** Percentage points the alternative beats this fund by, over 5Y. */
  gap: number;
  detail: string;
}

export interface RiskManagerOutput {
  generatedAt: string;
  totalPortfolioValue: number;
  critical: RiskFlag[];
  watch: RiskFlag[];
  informational: RiskFlag[];
  opportunityCost: OpportunityCostEntry[];
}

const CONCENTRATION_THRESHOLD = 0.3;
const SECTOR_CONCENTRATION_THRESHOLD = 0.5;
const DRAWDOWN_CRITICAL_THRESHOLD = -0.15;
const OPPORTUNITY_COST_GAP_THRESHOLD = 0.02;
const OPPORTUNITY_COST_MIN_SHARE = 0.03;
/** Minimum score gap vs. the S&P 500 before a fund's relative weakness is worth a watch flag — a 2-point gap (e.g. 80 vs 82) is noise. */
const MOMENTUM_GAP_WATCH_THRESHOLD = 10;
/** Minimum lag vs. the S&P 500, on both 3Y and 5Y, before persistent underperformance is worth a watch flag. */
const PERSISTENCE_LAG_THRESHOLD = 0.03;
/** Positions smaller than this aren't worth watch-level attention — they still surface, but only as informational. */
const MIN_WATCH_POSITION_VALUE = 5000;

const RETIREMENT_PLAN_ACCOUNT_TYPES: AccountType[] = ["VZ_SAVINGS_401K", "VZ_LEGACY_401K", "VZ_EDP"];

function singleAccountId(holding: Pick<CurrentHolding, "accounts">): string | null {
  return holding.accounts.length === 1 ? holding.accounts[0].accountId : null;
}

/** Below the minimum position size, a would-be watch flag is downgraded to informational — small positions aren't worth the attention. */
function sizeAdjustedSeverity(baseSeverity: RiskSeverity, currentValue: number): RiskSeverity {
  return baseSeverity === "watch" && currentValue < MIN_WATCH_POSITION_VALUE ? "informational" : baseSeverity;
}

/**
 * Runs a fixed set of portfolio risk checks: single-position and sector
 * concentration, the locked Verizon stock fund, momentum deterioration and
 * drawdown (from the Relative Strength agent's full scored universe), known-
 * return underperformance persistence, and 401k opportunity cost (a large
 * position in a fund that has a better-returning peer in the known-returns
 * set). Each check is independent of whether Sector Rotation / Relative
 * Strength have been run recently — this agent recomputes what it needs so
 * it stays correct when run standalone.
 */
export async function runRiskManagerAgent(): Promise<RiskManagerOutput> {
  const [holdings, { sp500, scored: rsScored }] = await Promise.all([getCurrentHoldings(), scoreCurrentHoldings()]);
  const portfolioValue = totalPortfolioValue(holdings);

  const critical: RiskFlag[] = [];
  const watch: RiskFlag[] = [];
  const informational: RiskFlag[] = [];
  const opportunityCost: OpportunityCostEntry[] = [];

  function pushFlag(flag: RiskFlag) {
    if (flag.severity === "critical") critical.push(flag);
    else if (flag.severity === "watch") watch.push(flag);
    else informational.push(flag);
  }

  // 1. Concentration risk — any single position over the portfolio threshold.
  for (const holding of holdings) {
    if (portfolioValue <= 0) break;
    const share = holding.currentValue / portfolioValue;
    if (share > CONCENTRATION_THRESHOLD) {
      critical.push({
        severity: "critical",
        check: "concentration",
        symbol: holding.symbol,
        title: `${holding.symbol} is ${formatPercent(share)} of total portfolio`,
        detail: `Single-position concentration exceeds the ${formatPercent(CONCENTRATION_THRESHOLD)} threshold (${formatCurrency(holding.currentValue)} of ${formatCurrency(portfolioValue)}).`,
        accountId: singleAccountId(holding),
      });
    }
  }

  // 2. Single stock risk — the Verizon Stock Fund can't be reallocated.
  for (const holding of holdings) {
    if (!isLockedInstrument({ symbol: holding.symbol, name: holding.name })) continue;
    const share = portfolioValue > 0 ? holding.currentValue / portfolioValue : 0;
    informational.push({
      severity: "informational",
      check: "locked-stock",
      symbol: holding.symbol,
      title: `${holding.symbol} is a locked company-stock position`,
      detail: `${formatCurrency(holding.currentValue)} (${formatPercent(share)} of portfolio) is matched company stock and can't be reallocated.`,
      accountId: singleAccountId(holding),
    });
  }

  // 3. Sector concentration — over the threshold in one sector/style bucket.
  const exposureBySector = new Map<string, number>();
  for (const holding of holdings) {
    const sector = getHoldingSector(holding.symbol, holding.name) ?? "Unclassified";
    exposureBySector.set(sector, (exposureBySector.get(sector) ?? 0) + holding.currentValue);
  }
  for (const [sector, value] of exposureBySector) {
    const share = portfolioValue > 0 ? value / portfolioValue : 0;
    if (share > SECTOR_CONCENTRATION_THRESHOLD) {
      critical.push({
        severity: "critical",
        check: "sector-concentration",
        symbol: null,
        title: `${sector} is ${formatPercent(share)} of total portfolio`,
        detail: `Sector/style concentration exceeds the ${formatPercent(SECTOR_CONCENTRATION_THRESHOLD)} threshold.`,
        accountId: null,
      });
    }
  }

  // 4 & 6. Momentum deterioration (score meaningfully below S&P) and drawdown (negative 1Y momentum) — over every scored holding, not just the top/bottom tiers.
  for (const entry of rsScored) {
    const scoreGap = sp500.score - entry.score;
    if (scoreGap >= MOMENTUM_GAP_WATCH_THRESHOLD) {
      pushFlag({
        severity: sizeAdjustedSeverity("watch", entry.currentValue),
        check: "momentum-deterioration",
        symbol: entry.symbol,
        title: `${entry.symbol} score has fallen below the S&P 500`,
        detail: `Score ${entry.score}/100 vs S&P 500 ${sp500.score}/100 (${scoreGap}-point gap).`,
        accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
      });
    }
    if (entry.momentum != null && entry.momentum < 0) {
      const baseSeverity: RiskSeverity = entry.momentum < DRAWDOWN_CRITICAL_THRESHOLD ? "critical" : "watch";
      pushFlag({
        severity: sizeAdjustedSeverity(baseSeverity, entry.currentValue),
        check: "drawdown",
        symbol: entry.symbol,
        title: `${entry.symbol} has negative 1-year momentum`,
        detail: `1-year return ${formatPercent(entry.momentum)}.`,
        accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
      });
    }
  }

  // 5. Underperformer persistence — known returns lagging the S&P by a meaningful margin over both 3Y and 5Y.
  for (const holding of holdings) {
    const known = getKnownFundReturns(holding.symbol, holding.name);
    if (!known) continue;
    const threeYearLag = KNOWN_SP500_RETURNS.threeYear - known.threeYear;
    const fiveYearLag = KNOWN_SP500_RETURNS.fiveYear - known.fiveYear;
    if (threeYearLag >= PERSISTENCE_LAG_THRESHOLD && fiveYearLag >= PERSISTENCE_LAG_THRESHOLD) {
      pushFlag({
        severity: sizeAdjustedSeverity("watch", holding.currentValue),
        check: "underperformer-persistence",
        symbol: holding.symbol,
        title: `${holding.symbol} has lagged the S&P 500 over both 3Y and 5Y`,
        detail: `3Y ${formatPercent(known.threeYear)} vs S&P ${formatPercent(KNOWN_SP500_RETURNS.threeYear)}; 5Y ${formatPercent(known.fiveYear)} vs S&P ${formatPercent(KNOWN_SP500_RETURNS.fiveYear)}.`,
        accountId: singleAccountId(holding),
      });
    }
  }

  // 7. 401k opportunity cost — a large 401k position in a fund with a better-returning known peer.
  for (const holding of holdings) {
    const isRetirementPlanHolding =
      holding.accounts.length > 0 && holding.accounts.every((a) => RETIREMENT_PLAN_ACCOUNT_TYPES.includes(a.accountType));
    if (!isRetirementPlanHolding) continue;

    const known = getKnownFundReturns(holding.symbol, holding.name);
    if (!known) continue;

    const alternative = bestAlternativeInCategory(known.fundName, known.category, "fiveYear");
    if (!alternative) continue;

    const gap = alternative.returns.fiveYear - known.fiveYear;
    const share = portfolioValue > 0 ? holding.currentValue / portfolioValue : 0;
    if (gap >= OPPORTUNITY_COST_GAP_THRESHOLD && share >= OPPORTUNITY_COST_MIN_SHARE) {
      opportunityCost.push({
        symbol: holding.symbol,
        name: holding.name,
        currentValue: holding.currentValue,
        category: known.category,
        fundFiveYear: known.fiveYear,
        alternativeName: alternative.fundName,
        alternativeFiveYear: alternative.returns.fiveYear,
        gap,
        detail: `${holding.symbol} returned ${formatPercent(known.fiveYear)} over 5Y vs ${alternative.fundName} at ${formatPercent(alternative.returns.fiveYear)} in the same plan menu — a ${formatPercent(gap)} gap on a ${formatCurrency(holding.currentValue)} position.`,
      });
    }
  }
  opportunityCost.sort((a, b) => b.currentValue - a.currentValue);

  // 8. Dedup — a critical flag, or the structurally-locked designation,
  // already tells the CIO everything they need to know about a position; a
  // watch flag for that same symbol (e.g. Verizon Stock Fund also flagged as
  // a lagging performer) is redundant noise on top of a stronger signal.
  // One entry per position: highest severity wins.
  const strongerSignalSymbols = new Set<string>();
  for (const flag of critical) if (flag.symbol) strongerSignalSymbols.add(flag.symbol);
  for (const flag of informational) if (flag.check === "locked-stock" && flag.symbol) strongerSignalSymbols.add(flag.symbol);
  const dedupedWatch = watch.filter((flag) => !(flag.symbol && strongerSignalSymbols.has(flag.symbol)));

  return {
    generatedAt: new Date().toISOString(),
    totalPortfolioValue: portfolioValue,
    critical,
    watch: dedupedWatch,
    informational,
    opportunityCost,
  };
}
