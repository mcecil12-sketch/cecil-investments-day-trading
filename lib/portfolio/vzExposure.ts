import type { PricePoint } from "@/lib/agents/marketData";

/** One imported holding row, reduced to what exposure matching needs. */
export interface VzExposureHolding {
  symbol: string;
  name: string | null;
  currentValue: number | null;
  lastPrice: number | null;
}

/** One account's latest snapshot. VZ_LTI carries share counts instead of holdings. */
export interface VzExposureAccount {
  name: string;
  type: string;
  holdings: VzExposureHolding[];
  /** VZ_LTI only: total unvested shares across tranches. */
  ltiShares?: number;
  /** VZ_LTI only: shares x VZ price frozen at import time — used only when no live price is available. */
  ltiFrozenValue?: number;
}

export interface VzPriceStats {
  last: number;
  /** Last close vs previous close, decimal fraction. Null with fewer than 2 points. */
  dayChangePct: number | null;
  /** Last close vs the final close of the prior calendar year, decimal fraction. Null when no prior-year close is in the series. */
  ytdChangePct: number | null;
}

export type VzComponentBasis = "matched_holding" | "lti_shares_x_live_price" | "lti_frozen_import_value";

export interface VzExposureComponent {
  accountName: string;
  accountType: string;
  label: string;
  value: number;
  basis: VzComponentBasis;
}

export interface VzExcludedHolding {
  accountName: string;
  label: string;
  value: number;
  reason: string;
}

export interface VzExposure {
  /** Including unvested LTI shares. */
  totalValue: number;
  /** Fraction of the unified portfolio (LTI included); null when the portfolio total is unavailable or zero. */
  percentOfPortfolio: number | null;
  /** Excluding unvested LTI: dollars, and percent of the portfolio total with the LTI value removed from it as well. */
  excludingLti: { totalValue: number; percentOfPortfolio: number | null };
  components: VzExposureComponent[];
  /** Holdings whose name mentions Verizon but which are not VZ stock or a stock fund (e.g. target-date funds). */
  excluded: VzExcludedHolding[];
  price: VzPriceStats | null;
  /** Assumptions and data gaps worth stating alongside the number. */
  notes: string[];
}

/** Counts only VZ common stock or a stock fund (e.g. "Verizon Stock Fund"). A bare "Verizon" in the name is NOT enough — "VERIZON 2070 FUND" is a target-date fund. */
export function isVerizonStockHolding(h: { symbol: string; name: string | null }): boolean {
  return h.symbol.trim().toUpperCase() === "VZ" || (h.name ?? "").toLowerCase().includes("stock fund");
}

const NAME_ONLY_REASON = 'Name mentions Verizon but it is not VZ stock or a stock fund (e.g. a target-date fund); any VZ look-through inside it is not counted';

/** Last price, 1-day and YTD change from a daily close series (any order). */
export function computeVzPriceStats(points: PricePoint[], now: Date = new Date()): VzPriceStats | null {
  const sorted = points.filter((p) => Number.isFinite(p.close)).sort((a, b) => a.date.getTime() - b.date.getTime());
  const latest = sorted.at(-1);
  if (!latest) return null;
  const prev = sorted.at(-2);
  const yearStart = Date.UTC(now.getUTCFullYear(), 0, 1);
  const priorYearClose = [...sorted].reverse().find((p) => p.date.getTime() < yearStart);
  return {
    last: latest.close,
    dayChangePct: prev && prev.close > 0 ? latest.close / prev.close - 1 : null,
    ytdChangePct: priorYearClose && priorYearClose.close > 0 ? latest.close / priorYearClose.close - 1 : null,
  };
}

export function computeVzExposure(input: {
  accounts: VzExposureAccount[];
  price: VzPriceStats | null;
  totalPortfolioValue: number | null;
}): VzExposure {
  const components: VzExposureComponent[] = [];
  const excluded: VzExcludedHolding[] = [];
  const notes: string[] = [
    "Target-date and other funds may hold a small VZ look-through that is not counted here.",
  ];

  for (const account of input.accounts) {
    if (account.type === "VZ_LTI") {
      const shares = account.ltiShares ?? 0;
      if (shares <= 0) continue;
      if (input.price) {
        components.push({
          accountName: account.name,
          accountType: account.type,
          label: `${Math.round(shares).toLocaleString("en-US")} unvested VZ shares x $${input.price.last.toFixed(2)}`,
          value: shares * input.price.last,
          basis: "lti_shares_x_live_price",
        });
      } else if (account.ltiFrozenValue != null && Number.isFinite(account.ltiFrozenValue)) {
        components.push({
          accountName: account.name,
          accountType: account.type,
          label: "Unvested VZ shares at import-time value (no live price)",
          value: account.ltiFrozenValue,
          basis: "lti_frozen_import_value",
        });
        notes.push(`${account.name}: no live VZ price, used the import-time value.`);
      } else {
        notes.push(`${account.name}: VZ shares excluded — no live price and no import-time value.`);
      }
      continue;
    }

    for (const h of account.holdings) {
      if (h.currentValue == null || !Number.isFinite(h.currentValue)) continue;
      if (isVerizonStockHolding(h)) {
        components.push({
          accountName: account.name,
          accountType: account.type,
          label: h.name ?? h.symbol,
          value: h.currentValue,
          basis: "matched_holding",
        });
        if (h.lastPrice == null) notes.push(`${account.name}: "${h.name ?? h.symbol}" has no price on record; used its imported value.`);
      } else if ((h.name ?? "").toLowerCase().includes("verizon")) {
        excluded.push({ accountName: account.name, label: h.name ?? h.symbol, value: h.currentValue, reason: NAME_ONLY_REASON });
      }
    }
  }

  const totalValue = components.reduce((sum, c) => sum + c.value, 0);
  const ltiValue = components.filter((c) => c.accountType === "VZ_LTI").reduce((sum, c) => sum + c.value, 0);
  const excludingValue = totalValue - ltiValue;
  const portfolio = input.totalPortfolioValue;
  const portfolioExLti = portfolio != null ? portfolio - ltiValue : null;
  return {
    totalValue,
    percentOfPortfolio: portfolio != null && portfolio > 0 ? totalValue / portfolio : null,
    excludingLti: {
      totalValue: excludingValue,
      percentOfPortfolio: portfolioExLti != null && portfolioExLti > 0 ? excludingValue / portfolioExLti : null,
    },
    components,
    excluded,
    price: input.price,
    notes,
  };
}

function pct(value: number | null | undefined): string {
  return value == null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

/** The one-line summary shown on the dashboard card and at the head of the export section. */
export function formatVzExposureLine(e: VzExposure): string {
  const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  const share = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  return `Verizon-linked exposure: ${money(e.totalValue)} (${share(e.percentOfPortfolio)} of portfolio) incl. unvested LTI; ${money(e.excludingLti.totalValue)} (${share(e.excludingLti.percentOfPortfolio)}) excl. LTI, VZ day ${pct(e.price?.dayChangePct)}, YTD ${pct(e.price?.ytdChangePct)}`;
}
