/**
 * Conviction-based position-size band by composite score — the same
 * heuristic behind the "Estimated Position Size" column on the
 * Recommendations page (Taxable card) and the Dashboard's Simulated
 * Position-Sized Portfolio view.
 */
export function convictionBand(score: number): [number, number] {
  if (score >= 90) return [0.04, 0.06];
  if (score >= 80) return [0.02, 0.04];
  return [0.01, 0.02];
}

/** Midpoint of the conviction band — the sizing convention used for simulated position sizing (e.g. a 4.0%-6.0% band uses 5.0%). */
export function convictionMidpoint(score: number): number {
  const [lo, hi] = convictionBand(score);
  return (lo + hi) / 2;
}

/**
 * Fallback starting value for the Dashboard's Simulated Position-Sized
 * Portfolio view, used only when the real "Total Portfolio Value" (from
 * computeBenchmark()) is unavailable or zero.
 */
export const SIMULATED_PORTFOLIO_FALLBACK_BASE_VALUE = 250_000;

/**
 * Base value for the Simulated Position-Sized Portfolio view — anchors to
 * the real "Total Portfolio Value" shown elsewhere on the Dashboard
 * (computeBenchmark()'s totalCurrentValue) when available, so the
 * simulation sizes against actual account value instead of an assumed
 * figure.
 */
export function resolvePortfolioBaseValue(totalCurrentValue: number | null | undefined): number {
  if (totalCurrentValue != null && totalCurrentValue > 0) return totalCurrentValue;
  return SIMULATED_PORTFOLIO_FALLBACK_BASE_VALUE;
}
