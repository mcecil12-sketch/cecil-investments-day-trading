import type { PricePoint } from "@/lib/agents/marketData";

/** Shared price-series math used by every portfolio-analysis agent (Relative Strength, Sector Rotation, Risk Manager). */

export function computeReturn(startValue: number, endValue: number): number | null {
  if (!Number.isFinite(startValue) || startValue === 0) return null;
  return (endValue - startValue) / startValue;
}

export function sma(points: PricePoint[], window: number): number | null {
  if (points.length < window) return null;
  const slice = points.slice(-window);
  return slice.reduce((sum, p) => sum + p.close, 0) / window;
}

/** Return over the trailing `days` ending at the series' last point. Assumes points are sorted ascending by date. */
export function momentumOverDays(points: PricePoint[], days: number): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const targetTime = last.date.getTime() - days * 24 * 60 * 60 * 1000;
  let start = points[0];
  for (const p of points) {
    if (p.date.getTime() <= targetTime) start = p;
    else break;
  }
  return computeReturn(start.close, last.close);
}

/**
 * Maps a -50%..+200% return to a 0-100 scale; missing data scores neutral
 * (50) rather than penalized. The ceiling used to be +50%, which meant any
 * stock with a 1-year return above 50% (not unusual for individual equities,
 * as opposed to indices) clipped to the same 100 regardless of whether it
 * returned 51% or 220% — collapsing real momentum differences into ties.
 * +200% is wide enough that only truly exceptional movers approach the cap,
 * while ordinary double-digit-to-double-percent returns still scale
 * proportionally against each other.
 */
export function momentumTo100(momentum: number | null): number {
  if (momentum == null) return 50;
  const clamped = Math.max(-0.5, Math.min(2.0, momentum));
  return ((clamped + 0.5) / 2.5) * 100;
}

/** 0-100: half credit for trading above the 50-day SMA, half for the 200-day. Missing SMAs (short history) score neutral rather than penalized. */
export function trendStrengthScore(currentPrice: number, sma50: number | null, sma200: number | null): number {
  const part50 = sma50 == null ? 25 : currentPrice > sma50 ? 50 : 0;
  const part200 = sma200 == null ? 25 : currentPrice > sma200 ? 50 : 0;
  return part50 + part200;
}

export interface PriceSeriesScore {
  currentPrice: number;
  momentum: number | null;
  sma50: number | null;
  sma200: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  /** 0-100, 52-week momentum (60%) + 50d/200d trend strength (40%). */
  score: number;
}

/**
 * The composite score used by every agent that ranks a price series against
 * the S&P 500: 52-week momentum (60%) blended with 50d/200d trend strength
 * (40%). Shared by Relative Strength (scoring current holdings) and the
 * Candidate Scanner (scoring the buy-candidate universe) so both use
 * identical math against identical baselines.
 */
export function scorePriceSeries(rawPoints: PricePoint[]): PriceSeriesScore {
  const points = [...rawPoints].sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = points[points.length - 1];
  const momentum = momentumOverDays(points, 364);
  const sma50Value = sma(points, 50);
  const sma200Value = sma(points, 200);
  const trend = trendStrengthScore(last.close, sma50Value, sma200Value);
  const momentumScore = momentumTo100(momentum);
  const score = Math.max(0, Math.min(100, Math.round(momentumScore * 0.6 + trend * 0.4)));

  return {
    currentPrice: last.close,
    momentum,
    sma50: sma50Value,
    sma200: sma200Value,
    aboveSma50: sma50Value == null ? null : last.close > sma50Value,
    aboveSma200: sma200Value == null ? null : last.close > sma200Value,
    score,
  };
}
