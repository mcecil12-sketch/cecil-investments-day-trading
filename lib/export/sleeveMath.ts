import type { PricePoint } from "@/lib/agents/marketData";
import { lastOnOrBefore, utcDay } from "@/lib/benchmark/sp500Comparator";

/** Pure display math for the snapshot's allocation, sleeve scoreboard and theme sections. */

export const SP500_FUNDS = new Set(["FXAIX", "VOO", "SPY", "IVV", "SPLG", "FUSVX", "FUSEX", "SWPPX"]);

export interface AllocationHolding {
  symbol: string;
  isCash: boolean;
  value: number;
}

export interface AccountAllocation {
  name: string;
  value: number;
  sleeveValue: number;
  sleevePct: number | null;
  sp500FundValue: number;
  sp500FundPct: number | null;
  otherPct: number | null;
  cashPct: number | null;
}

export function computeAllocation(
  accounts: Array<{ name: string; holdings: AllocationHolding[] }>,
  sleeveSymbols: Set<string>,
): AccountAllocation[] {
  return accounts.map((a) => {
    const value = a.holdings.reduce((s, h) => s + h.value, 0);
    let sleeve = 0;
    let sp = 0;
    let cash = 0;
    for (const h of a.holdings) {
      if (h.isCash) cash += h.value;
      else if (sleeveSymbols.has(h.symbol)) sleeve += h.value;
      else if (SP500_FUNDS.has(h.symbol)) sp += h.value;
    }
    const pct = (v: number) => (value > 0 ? v / value : null);
    return {
      name: a.name,
      value,
      sleeveValue: sleeve,
      sleevePct: pct(sleeve),
      sp500FundValue: sp,
      sp500FundPct: pct(sp),
      otherPct: pct(Math.max(0, value - sleeve - sp - cash)),
      cashPct: pct(cash),
    };
  });
}

export interface SleeveName {
  symbol: string;
  startClose: number;
  endClose: number;
  /** Return over the window. */
  ret: number;
  /** Equal-weight contribution to the sleeve: ret / number of names scored. */
  contribution: number;
}

export interface SleeveScoreboard {
  startDate: Date;
  endDate: Date;
  names: SleeveName[];
  /** Names with no usable price series over the window. */
  missing: string[];
  sleeveReturn: number | null;
  indexReturn: number | null;
  controlReturn: number | null;
  excessVsIndex: number | null;
}

function seriesReturn(series: PricePoint[], startDay: number, endDay: number) {
  const sorted = [...series].sort((a, b) => a.date.getTime() - b.date.getTime());
  const s = lastOnOrBefore(sorted, startDay);
  const e = lastOnOrBefore(sorted, endDay);
  if (!s || !e || s.close <= 0 || utcDay(e.date) <= utcDay(s.date)) return null;
  return { startClose: s.close, endClose: e.close, ret: e.close / s.close - 1 };
}

/**
 * Equal-weighted sleeve from the batch date's close to the latest close
 * (the last date in the index series), against the index and an in-account
 * control fund over the SAME dates. A model sleeve since the batch date — not
 * a since-purchase figure.
 */
export function computeSleeveScoreboard(input: {
  startDate: Date;
  names: Array<{ symbol: string; series: PricePoint[] }>;
  index: PricePoint[];
  control: PricePoint[] | null;
}): SleeveScoreboard | null {
  if (input.index.length === 0) return null;
  const endDay = Math.max(...input.index.map((p) => utcDay(p.date)));
  const startDay = utcDay(input.startDate);

  const scored = input.names.map((n) => ({ symbol: n.symbol, r: seriesReturn(n.series, startDay, endDay) }));
  const ok = scored.filter((s) => s.r != null);
  const names: SleeveName[] = ok.map((s) => ({
    symbol: s.symbol,
    startClose: s.r!.startClose,
    endClose: s.r!.endClose,
    ret: s.r!.ret,
    contribution: s.r!.ret / ok.length,
  }));
  const sleeveReturn = names.length > 0 ? names.reduce((sum, n) => sum + n.contribution, 0) : null;
  const indexReturn = seriesReturn(input.index, startDay, endDay)?.ret ?? null;
  const controlReturn = input.control ? seriesReturn(input.control, startDay, endDay)?.ret ?? null : null;
  return {
    startDate: input.startDate,
    endDate: new Date(endDay),
    names,
    missing: scored.filter((s) => s.r == null).map((s) => s.symbol),
    sleeveReturn,
    indexReturn,
    controlReturn,
    excessVsIndex: sleeveReturn != null && indexReturn != null ? sleeveReturn - indexReturn : null,
  };
}

export interface ThemeConcentration {
  clusters: Array<{ sector: string; count: number; share: number; symbols: string[] }>;
  largest: { sector: string; share: number } | null;
}

/** Groups the (equal-weighted) sleeve by sector; the share is each cluster's count over the sleeve size. */
export function computeThemeConcentration(names: Array<{ symbol: string; sector: string | null }>): ThemeConcentration {
  const by = new Map<string, string[]>();
  for (const n of names) {
    const key = n.sector ?? "Unclassified";
    by.set(key, [...(by.get(key) ?? []), n.symbol]);
  }
  const clusters = [...by.entries()]
    .map(([sector, symbols]) => ({ sector, symbols, count: symbols.length, share: symbols.length / names.length }))
    .sort((a, b) => b.count - a.count);
  return { clusters, largest: clusters[0] ? { sector: clusters[0].sector, share: clusters[0].share } : null };
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 2) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? null : num / Math.sqrt(da * db);
}

/**
 * Average pairwise correlation of daily returns over the last `days` trading
 * days, using only dates present in every series. Null with fewer than two
 * series or fewer than 20 shared returns.
 */
export function averagePairwiseCorrelation(seriesList: PricePoint[][], days = 60): number | null {
  if (seriesList.length < 2) return null;
  const maps = seriesList.map((s) => new Map(s.map((p) => [utcDay(p.date), p.close])));
  const common = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort((a, b) => a - b).slice(-(days + 1));
  if (common.length < 21) return null;
  const returns = maps.map((m) => common.slice(1).map((d, i) => m.get(d)! / m.get(common[i])! - 1));
  const corrs: number[] = [];
  for (let i = 0; i < returns.length; i++) {
    for (let j = i + 1; j < returns.length; j++) {
      const c = pearson(returns[i], returns[j]);
      if (c != null) corrs.push(c);
    }
  }
  return corrs.length > 0 ? corrs.reduce((s, v) => s + v, 0) / corrs.length : null;
}

export const STALE_BRIEF_DAYS = 8;

/** Whole days between the brief's week-of date and now. */
export function briefAgeDays(weekOf: Date, now: Date): number {
  return Math.floor((now.getTime() - weekOf.getTime()) / (24 * 60 * 60 * 1000));
}
