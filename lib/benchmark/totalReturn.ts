import { getAdjustedCloseHistory, VZ_SYMBOL, type PricePoint } from "@/lib/agents/marketData";
import { computeAlpha, computeReturn } from "@/lib/benchmark/math";

/**
 * Yahoo's S&P 500 *Total Return* index. The cached ^GSPC series (priceCache.ts)
 * is the price-only index — Yahoo's adjclose for ^GSPC is identical to its raw
 * close, so "adjusting" it would not add dividends. ^SP500TR is the series
 * that actually includes them, making it the apples-to-apples counterpart to
 * VZ's dividend-adjusted close.
 */
export const SP500_TOTAL_RETURN_SYMBOL = "^SP500TR";

export type TotalReturnPeriod = "ytd" | "1y";

export interface TotalReturnPeriodResult {
  /** Date of the last price used on both sides (UTC midnight). */
  asOfDate: Date;
  portfolioReturn: number | null;
  sp500Return: number | null;
  alpha: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Last point on or before `day` (UTC midnight ms), or null if the series starts after it. */
function lastOnOrBefore(sorted: PricePoint[], day: number): PricePoint | null {
  let found: PricePoint | null = null;
  for (const point of sorted) {
    if (utcDay(point.date) > day) break;
    found = point;
  }
  return found;
}

function windowReturn(sorted: PricePoint[], startDay: number, endDay: number): number | null {
  const start = lastOnOrBefore(sorted, startDay);
  const end = lastOnOrBefore(sorted, endDay);
  if (!start || !end) return null;
  return computeReturn(start.close, end.close);
}

/**
 * Stock-vs-index total return over YTD and 1Y, from two dividend-adjusted
 * series. Pure function of the two price series: it takes no share count,
 * balance, or grant/vesting input, so changes to the held balance cannot
 * influence it — that's the point of benchmarking the stock itself instead of
 * a dollar-weighted return on a balance that changes from vesting. YTD starts
 * at the last close on or before Dec 31 of the prior year; 1Y at the last
 * close on or before 365 days before the end. Both windows end at the latest
 * date present in BOTH series, so the two sides always cover the same days.
 * Alpha is computeAlpha (portfolio − S&P), same as every other account.
 */
export function computeTotalReturnComparison(
  stockSeries: PricePoint[],
  indexSeries: PricePoint[],
): Record<TotalReturnPeriod, TotalReturnPeriodResult> | null {
  const stock = [...stockSeries].sort((a, b) => a.date.getTime() - b.date.getTime());
  const index = [...indexSeries].sort((a, b) => a.date.getTime() - b.date.getTime());
  if (stock.length === 0 || index.length === 0) return null;

  const endDay = Math.min(utcDay(stock[stock.length - 1].date), utcDay(index[index.length - 1].date));
  const endYear = new Date(endDay).getUTCFullYear();
  const starts: Record<TotalReturnPeriod, number> = {
    ytd: Date.UTC(endYear, 0, 1) - DAY_MS,
    "1y": endDay - 365 * DAY_MS,
  };

  const result = {} as Record<TotalReturnPeriod, TotalReturnPeriodResult>;
  for (const period of Object.keys(starts) as TotalReturnPeriod[]) {
    const portfolioReturn = windowReturn(stock, starts[period], endDay);
    const sp500Return = windowReturn(index, starts[period], endDay);
    result[period] = {
      asOfDate: new Date(endDay),
      portfolioReturn,
      sp500Return,
      alpha: computeAlpha(portfolioReturn, sp500Return),
    };
  }
  return result;
}

/** Fetches both adjusted series and computes VZ-vs-S&P total return. Returns null (never throws) so a Yahoo outage can't take down the whole benchmark page. */
export async function computeVzTotalReturnComparison(): Promise<Record<TotalReturnPeriod, TotalReturnPeriodResult> | null> {
  try {
    const [vz, sp500] = await Promise.all([
      getAdjustedCloseHistory(VZ_SYMBOL),
      getAdjustedCloseHistory(SP500_TOTAL_RETURN_SYMBOL),
    ]);
    return computeTotalReturnComparison(vz, sp500);
  } catch (err) {
    console.error("computeVzTotalReturnComparison failed:", err);
    return null;
  }
}
