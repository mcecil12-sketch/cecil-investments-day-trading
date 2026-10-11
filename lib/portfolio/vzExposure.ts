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

export type VzComponentBasis =
  | "matched_holding"
  | "edp_assumed_full_balance"
  | "lti_shares_x_live_price"
  | "lti_frozen_import_value";

export interface VzExposureComponent {
  accountName: string;
  accountType: string;
  label: string;
  value: number;
  basis: VzComponentBasis;
}

export interface VzExposure {
  totalValue: number;
  /** Fraction of the unified portfolio; null when the portfolio total is unavailable or zero. */
  percentOfPortfolio: number | null;
  components: VzExposureComponent[];
  price: VzPriceStats | null;
  /** Assumptions and data gaps worth stating alongside the number. */
  notes: string[];
}

/** VZ common stock or any Verizon-named holding (e.g. the captive "Verizon Stock Fund"). */
export function isVerizonHolding(h: { symbol: string; name: string | null }): boolean {
  return h.symbol.trim().toUpperCase() === "VZ" || (h.name ?? "").toLowerCase().includes("verizon");
}

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
  const notes: string[] = [];

  for (const account of input.accounts) {
    if (account.type === "VZ_LTI") {
      const shares = account.ltiShares ?? 0;
      if (shares <= 0) continue;
      if (input.price) {
        components.push({
          accountName: account.name,
          accountType: account.type,
          label: `${Math.round(shares).toLocaleString("en-US")} VZ shares x $${input.price.last.toFixed(2)}`,
          value: shares * input.price.last,
          basis: "lti_shares_x_live_price",
        });
      } else if (account.ltiFrozenValue != null && Number.isFinite(account.ltiFrozenValue)) {
        components.push({
          accountName: account.name,
          accountType: account.type,
          label: "VZ shares at import-time value (no live price)",
          value: account.ltiFrozenValue,
          basis: "lti_frozen_import_value",
        });
        notes.push(`${account.name}: no live VZ price, used the import-time value.`);
      } else {
        notes.push(`${account.name}: VZ shares excluded — no live price and no import-time value.`);
      }
      continue;
    }

    const valued = account.holdings.filter((h) => h.currentValue != null && Number.isFinite(h.currentValue));
    const matched = valued.filter(isVerizonHolding);

    if (matched.length > 0) {
      for (const h of matched) {
        components.push({
          accountName: account.name,
          accountType: account.type,
          label: h.name ?? h.symbol,
          value: h.currentValue as number,
          basis: "matched_holding",
        });
        if (h.lastPrice == null) notes.push(`${account.name}: "${h.name ?? h.symbol}" has no price on record; used its imported value.`);
      }
    } else if (account.type === "VZ_EDP" && valued.length > 0) {
      const balance = valued.reduce((sum, h) => sum + (h.currentValue as number), 0);
      components.push({
        accountName: account.name,
        accountType: account.type,
        label: "Full account balance",
        value: balance,
        basis: "edp_assumed_full_balance",
      });
      notes.push(`${account.name}: no Verizon-named holding found, so the whole EDP balance is assumed to be the Verizon stock fund.`);
    }
  }

  const totalValue = components.reduce((sum, c) => sum + c.value, 0);
  const portfolio = input.totalPortfolioValue;
  return {
    totalValue,
    percentOfPortfolio: portfolio != null && portfolio > 0 ? totalValue / portfolio : null,
    components,
    price: input.price,
    notes,
  };
}

function pct(value: number | null | undefined): string {
  return value == null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

/** The one-line summary shown on the dashboard card and at the head of the export section. */
export function formatVzExposureLine(e: VzExposure): string {
  const dollars = `$${Math.round(e.totalValue).toLocaleString("en-US")}`;
  const share = e.percentOfPortfolio == null ? "n/a of portfolio" : `${(e.percentOfPortfolio * 100).toFixed(1)}% of portfolio`;
  return `Verizon-linked exposure: ${dollars} (${share}), VZ day ${pct(e.price?.dayChangePct)}, YTD ${pct(e.price?.ytdChangePct)}`;
}
