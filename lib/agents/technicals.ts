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

/** Closest point at-or-before `daysAgo` days before the series' last date. Assumes ascending sort, mirrors momentumOverDays' scan. */
function priceAtDaysAgo(points: PricePoint[], daysAgo: number): PricePoint {
  const last = points[points.length - 1];
  const targetTime = last.date.getTime() - daysAgo * 24 * 60 * 60 * 1000;
  let candidate = points[0];
  for (const p of points) {
    if (p.date.getTime() <= targetTime) candidate = p;
    else break;
  }
  return candidate;
}

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Trailing 12-month return EXCLUDING the most recent month — the standard
 * "12-1" academic momentum convention (Jegadeesh & Titman / Antonacci). Unlike
 * a plain trailing-12-month return, this isolates the durable trend from
 * short-term reversal noise by dropping the most recent month.
 *
 * Returns null when the series doesn't actually span 365 days — without this
 * check, priceAtDaysAgo silently falls back to the earliest available point,
 * which for a recent spinoff or IPO is an artificial post-listing floor price
 * rather than a genuine 12-months-ago price (e.g. a stock spun off ~11 months
 * ago would compute "12-month return" as its entire lifetime-since-spinoff
 * return, wildly overstating durable trend). blendedMomentum reweights to the
 * 6/12-month legs when this comes back null.
 */
export function momentum12to1(points: PricePoint[]): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const earliest = points[0];
  if (last.date.getTime() - earliest.date.getTime() < TWELVE_MONTHS_MS) return null;
  const twelveMonthsAgo = priceAtDaysAgo(points, 365);
  const oneMonthAgo = priceAtDaysAgo(points, 30);
  return computeReturn(twelveMonthsAgo.close, oneMonthAgo.close);
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

/**
 * Scales a return to 0-100 using a horizon-appropriate range instead of the
 * fixed -50%..+200% ceiling in momentumTo100. Shorter windows have a
 * narrower realistic return range than a full year, so the range is derived
 * from momentumTo100's calibrated 12-month bounds via sqrt-time scaling (the
 * standard heuristic for how return dispersion shrinks with horizon length) —
 * a 6-month window scales by sqrt(0.5), a 3-month window by sqrt(0.25), etc.
 * Missing data scores neutral (50), matching momentumTo100.
 */
function momentumToScoreForHorizon(momentum: number | null, horizonYears: number): number {
  if (momentum == null) return 50;
  const scale = Math.sqrt(horizonYears);
  const floor = -0.5 * scale;
  const ceiling = 2.0 * scale;
  const clamped = Math.max(floor, Math.min(ceiling, momentum));
  return ((clamped - floor) / (ceiling - floor)) * 100;
}

const MOMENTUM_12M_WEIGHT = 0.5;
const MOMENTUM_6M_WEIGHT = 0.3;
const MOMENTUM_3M_WEIGHT = 0.2;

/**
 * Dampens the 3-month leg's weight when it's a positive pop unconfirmed by
 * the longer-term trend (6-month or 12-month flat/negative), so a recent
 * breakout alone can't drive the score — this keeps the model
 * momentum/trend-based rather than breakout-chasing. The multiplier is 1
 * (no dampening) whenever 3-month isn't a positive pop, or when both longer
 * legs are positive; otherwise it tapers from 0.5 (longer leg flat) down to 0
 * (longer leg down ~50%+). Weight removed from the 3-month leg is
 * redistributed to the 6/12-month legs so the three weights always sum to 1.
 */
function blendedMomentumWeights(
  m3: number | null,
  m6: number | null,
  m12: number | null,
): { weight3m: number; weight6m: number; weight12m: number } {
  let weight3m = MOMENTUM_3M_WEIGHT;
  if (m3 != null && m3 > 0) {
    const longTermWorst = Math.min(m6 ?? 0, m12 ?? 0);
    if (longTermWorst <= 0) {
      const multiplier = Math.max(0, 0.5 + longTermWorst);
      weight3m = MOMENTUM_3M_WEIGHT * multiplier;
    }
  }
  const freed = MOMENTUM_3M_WEIGHT - weight3m;
  const longTermTotal = MOMENTUM_6M_WEIGHT + MOMENTUM_12M_WEIGHT;
  const weight6m = MOMENTUM_6M_WEIGHT + (freed * MOMENTUM_6M_WEIGHT) / longTermTotal;
  const weight12m = MOMENTUM_12M_WEIGHT + (freed * MOMENTUM_12M_WEIGHT) / longTermTotal;
  return { weight3m, weight6m, weight12m };
}

/**
 * Zeroes out the weight of any leg whose momentum value is null (data
 * unavailable — e.g. momentum12to1 nulled out for a recent spinoff/IPO) and
 * redistributes it proportionally across the remaining available legs, so an
 * unavailable leg is genuinely excluded rather than defaulting to a neutral
 * score at its normal (often large) weight. Leaves weights untouched when
 * every leg is available.
 */
function redistributeMissingWeight(
  weights: { weight12m: number; weight6m: number; weight3m: number },
  available: { m12: boolean; m6: boolean; m3: boolean },
): { weight12m: number; weight6m: number; weight3m: number } {
  let { weight12m, weight6m, weight3m } = weights;
  let missing = 0;
  if (!available.m12) {
    missing += weight12m;
    weight12m = 0;
  }
  if (!available.m6) {
    missing += weight6m;
    weight6m = 0;
  }
  if (!available.m3) {
    missing += weight3m;
    weight3m = 0;
  }
  const remainingTotal = weight12m + weight6m + weight3m;
  if (missing > 0 && remainingTotal > 0) {
    weight12m += (missing * weight12m) / remainingTotal;
    weight6m += (missing * weight6m) / remainingTotal;
    weight3m += (missing * weight3m) / remainingTotal;
  }
  return { weight12m, weight6m, weight3m };
}

export interface MomentumBlend {
  momentum12to1: number | null;
  momentum6m: number | null;
  momentum3m: number | null;
  /** 0-100 composite of the three legs' horizon-scaled scores, guardrail-adjusted. */
  score: number;
  /** Weighted blend of the three raw (fractional) returns, using the same guardrail-adjusted weights as `score`. */
  raw: number | null;
}

/**
 * Multi-horizon momentum blend replacing a single trailing-12-month window,
 * matching institutional trend-following methodology: 12-month "12-1" return
 * (50%, excludes the most recent month to isolate durable trend from
 * short-term reversal noise) + 6-month full trailing return (30%) + 3-month
 * full trailing return (20%, dampened by blendedMomentumWeights when it's an
 * unconfirmed pop). Each leg scales within its own horizon-appropriate range
 * (momentumToScoreForHorizon) rather than a single fixed ceiling, so the
 * three windows can actually differentiate instead of collapsing together.
 */
export function blendedMomentum(points: PricePoint[]): MomentumBlend {
  const m12 = momentum12to1(points);
  const m6 = momentumOverDays(points, 182);
  const m3 = momentumOverDays(points, 91);

  if (m12 == null && m6 == null && m3 == null) {
    return { momentum12to1: null, momentum6m: null, momentum3m: null, score: 50, raw: null };
  }

  const guardrailWeights = blendedMomentumWeights(m3, m6, m12);
  const { weight12m, weight6m, weight3m } = redistributeMissingWeight(guardrailWeights, {
    m12: m12 != null,
    m6: m6 != null,
    m3: m3 != null,
  });

  const score12 = momentumToScoreForHorizon(m12, 1);
  const score6 = momentumToScoreForHorizon(m6, 0.5);
  const score3 = momentumToScoreForHorizon(m3, 0.25);
  const score = score12 * weight12m + score6 * weight6m + score3 * weight3m;

  const raw = (m12 ?? 0) * weight12m + (m6 ?? 0) * weight6m + (m3 ?? 0) * weight3m;

  return { momentum12to1: m12, momentum6m: m6, momentum3m: m3, score, raw };
}

export interface PriceSeriesScore {
  currentPrice: number;
  /** Weighted blend of the three momentum legs' raw returns — see MomentumBlend.raw. */
  momentum: number | null;
  momentum12to1: number | null;
  momentum6m: number | null;
  momentum3m: number | null;
  sma50: number | null;
  sma200: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  /** 0-100, multi-horizon momentum blend (60%) + 50d/200d trend strength (40%). */
  score: number;
}

/**
 * The composite score used by every agent that ranks a price series against
 * the S&P 500: multi-horizon momentum blend (60%, see blendedMomentum)
 * blended with 50d/200d trend strength (40%). Shared by Relative Strength
 * (scoring current holdings) and the Candidate Scanner (scoring the
 * buy-candidate universe) so both use identical math against identical
 * baselines.
 */
export function scorePriceSeries(rawPoints: PricePoint[]): PriceSeriesScore {
  const points = [...rawPoints].sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = points[points.length - 1];
  const momentum = blendedMomentum(points);
  const sma50Value = sma(points, 50);
  const sma200Value = sma(points, 200);
  const trend = trendStrengthScore(last.close, sma50Value, sma200Value);
  const score = Math.max(0, Math.min(100, Math.round(momentum.score * 0.6 + trend * 0.4)));

  return {
    currentPrice: last.close,
    momentum: momentum.raw,
    momentum12to1: momentum.momentum12to1,
    momentum6m: momentum.momentum6m,
    momentum3m: momentum.momentum3m,
    sma50: sma50Value,
    sma200: sma200Value,
    aboveSma50: sma50Value == null ? null : last.close > sma50Value,
    aboveSma200: sma200Value == null ? null : last.close > sma200Value,
    score,
  };
}
