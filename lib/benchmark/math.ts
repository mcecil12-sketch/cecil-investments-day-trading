export type BenchmarkPeriodKey = "1y" | "3y" | "5y";

export const BENCHMARK_PERIODS: ReadonlyArray<{ key: BenchmarkPeriodKey; years: number }> = [
  { key: "1y", years: 1 },
  { key: "3y", years: 3 },
  { key: "5y", years: 5 },
];

export function subtractYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() - years);
  return result;
}

/**
 * Simple NAV-delta return: (end - start) / start. This is not a true
 * time-weighted or money-weighted return — it doesn't account for deposits
 * or withdrawals between snapshots — but it's the honest figure available
 * from point-in-time position snapshots without transaction/cash-flow data.
 */
export function computeReturn(startValue: number, endValue: number): number | null {
  if (!Number.isFinite(startValue) || startValue === 0) return null;
  return (endValue - startValue) / startValue;
}

export function computeAlpha(
  portfolioReturn: number | null,
  sp500Return: number | null,
): number | null {
  if (portfolioReturn == null || sp500Return == null) return null;
  return portfolioReturn - sp500Return;
}
