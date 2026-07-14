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

/** Maps a -50%..+50% return to a 0-100 scale; missing data scores neutral (50) rather than penalized. */
export function momentumTo100(momentum: number | null): number {
  if (momentum == null) return 50;
  const clamped = Math.max(-0.5, Math.min(0.5, momentum));
  return (clamped + 0.5) * 100;
}

/** 0-100: half credit for trading above the 50-day SMA, half for the 200-day. Missing SMAs (short history) score neutral rather than penalized. */
export function trendStrengthScore(currentPrice: number, sma50: number | null, sma200: number | null): number {
  const part50 = sma50 == null ? 25 : currentPrice > sma50 ? 50 : 0;
  const part200 = sma200 == null ? 25 : currentPrice > sma200 ? 50 : 0;
  return part50 + part200;
}
