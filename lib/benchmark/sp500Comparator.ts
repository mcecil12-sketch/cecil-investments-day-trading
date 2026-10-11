import { getAdjustedCloseHistory, type PricePoint } from "@/lib/agents/marketData";
import { SP500_TOTAL_RETURN_SYMBOL } from "@/lib/benchmark/totalReturn";

/**
 * The ONE S&P 500 comparator for the Benchmark page and snapshot export:
 * ^SP500TR (dividend-inclusive) over an explicit start/end window, so every
 * row is compared over exactly its own dates instead of whatever S&P figure
 * happened to ride along in a particular PDF.
 *
 * Conventions: YTD starts at the last trading-day close of the prior year; 1Y
 * at the same calendar date one year earlier (nearest prior trading day); 3Y
 * the same date three years earlier and, like Fidelity's multi-year figures,
 * ANNUALIZED (CAGR). Returns null (never a partial figure) when the series
 * does not reach back to the window start.
 */
export type ComparatorPeriod = "ytd" | "1y" | "3y";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;

export const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Calendar start of the window (before snapping to a trading day). */
export function windowStartDate(period: ComparatorPeriod, end: Date): Date {
  const y = end.getUTCFullYear();
  if (period === "ytd") return new Date(Date.UTC(y, 0, 1) - DAY_MS); // Dec 31 of the prior year
  const years = period === "1y" ? 1 : 3;
  // Feb 29 -> Feb 28 on non-leap targets (Date.UTC would roll to Mar 1).
  const month = end.getUTCMonth();
  const day = end.getUTCDate();
  const candidate = new Date(Date.UTC(y - years, month, day));
  return candidate.getUTCMonth() !== month ? new Date(Date.UTC(y - years, month + 1, 0)) : candidate;
}

export function lastOnOrBefore(sorted: PricePoint[], day: number): PricePoint | null {
  let found: PricePoint | null = null;
  for (const p of sorted) {
    if (utcDay(p.date) > day) break;
    found = p;
  }
  return found;
}

export interface WindowReturn {
  /** Total return, or the annualized return when `annualized`. */
  value: number;
  annualized: boolean;
  /** Trading days actually used for the two closes. */
  startDate: Date;
  endDate: Date;
}

/**
 * Return of `series` from the close on/before `start` to the close on/before
 * `end`. Null when the series has no close at/before `start` (too young) or
 * the window is degenerate.
 */
export function computeWindowReturn(
  series: PricePoint[],
  start: Date,
  end: Date,
  annualize: boolean,
): WindowReturn | null {
  const sorted = [...series].sort((a, b) => a.date.getTime() - b.date.getTime());
  const s = lastOnOrBefore(sorted, utcDay(start));
  const e = lastOnOrBefore(sorted, utcDay(end));
  if (!s || !e || s.close <= 0 || utcDay(e.date) <= utcDay(s.date)) return null;
  const total = e.close / s.close - 1;
  if (!annualize) return { value: total, annualized: false, startDate: s.date, endDate: e.date };
  const years = (utcDay(end) - utcDay(start)) / DAY_MS / DAYS_PER_YEAR;
  if (years <= 0) return null;
  return { value: Math.pow(e.close / s.close, 1 / years) - 1, annualized: true, startDate: s.date, endDate: e.date };
}

/** S&P 500 total return for a standard period ending `end`; 3Y is annualized. */
export function computeSp500Period(series: PricePoint[], period: ComparatorPeriod, end: Date): WindowReturn | null {
  return computeWindowReturn(series, windowStartDate(period, end), end, period === "3y");
}

const SERIES_CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; points: PricePoint[] }>();

/** ^SP500TR (or any symbol's) dividend-adjusted closes, 5y, cached briefly in-process. Throws on a Yahoo failure; callers degrade to "—". */
export async function loadAdjustedSeries(symbol: string): Promise<PricePoint[]> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < SERIES_CACHE_MS) return hit.points;
  const points = await getAdjustedCloseHistory(symbol, "5y");
  cache.set(symbol, { at: Date.now(), points });
  return points;
}

export const loadSp500TotalReturnSeries = () => loadAdjustedSeries(SP500_TOTAL_RETURN_SYMBOL);
