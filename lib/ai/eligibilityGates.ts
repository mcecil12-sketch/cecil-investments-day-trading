/**
 * Hard pre-GPT gating for signal eligibility.
 * Checks minimum context, liquidity, and quality thresholds before scoring.
 * Prevents junk signals from consuming API quota and clogging the funnel.
 * 
 * OPTIMIZATION v2: Enhanced filtering to reduce GPT load by 50-80%
 * - Added relVol minimum check
 * - Added flat trend rejection
 * - Added max price cap
 * - Added missing context detection
 * - Added market-hours stale signal check
 */

import type { SignalContext } from "@/lib/signalContext";

// Threshold constants from environment or defaults
const MIN_BARS_REQUIRED = Number(process.env.MIN_BARS_FOR_AI ?? 20);
const MIN_PRICE_REQUIRED = Number(process.env.MIN_PRICE ?? 3);
const MAX_PRICE_ALLOWED = Number(process.env.MAX_PRICE ?? 500);
const MIN_AVG_VOL_SHARES = Number(process.env.MIN_AVG_VOL_SHARES ?? 600);
const MIN_AVG_DOLLAR_VOL = Number(process.env.MIN_AVG_DOLLAR_VOL ?? 300000);
const MAX_SPREAD_PCT = Number(process.env.MAX_SPREAD_PCT ?? 0.5); // 0.5% = 50 bps
const MIN_REL_VOL_REQUIRED = Number(process.env.MIN_REL_VOL ?? 0.5);
const STALE_MARKET_HOURS_MINUTES = Number(process.env.STALE_MARKET_HOURS_MINUTES ?? 90);

export type SkipReason =
  | "insufficient_bars"
  | "missing_context"
  | "volume_too_low"
  | "dollar_volume_too_low"
  | "price_too_low"
  | "price_too_high"
  | "spread_too_wide"
  | "low_rel_volume"
  | "flat_trend"
  | "stale"
  | "stale_market_hours"; // Signal too old during market hours

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: SkipReason; detail?: string };

/**
 * Evaluate whether a signal meets minimum thresholds for AI scoring.
 * 
 * Checks (in order):
 * 1. Context exists (not null/undefined)
 * 2. barsUsed >= MIN_BARS_REQUIRED (default 20)
 * 3. Staleness (configurable: market hours or general)
 * 4. avgVolume >= MIN_AVG_VOL_SHARES (default 600)
 * 5. avgDollarVol >= MIN_AVG_DOLLAR_VOL (default 300000)
 * 6. price >= MIN_PRICE_REQUIRED (default 3)
 * 7. price <= MAX_PRICE_ALLOWED (default 500)
 * 8. relVolume >= MIN_REL_VOL_REQUIRED (default 1.2)
 * 9. trend !== "FLAT" (flat trend rejection)
 * 10. spread (if available) <= MAX_SPREAD_PCT
 * 
 * Returns early on first failure (order matters for diagnostics).
 * 
 * @param context Signal context with bars, volume, and price data
 * @param entryPrice Entry price of the signal
 * @param createdAt ISO timestamp of signal creation (for staleness check)
 * @param options Configuration options
 * @returns Result indicating eligibility or reason for skipping
 */
export function evaluateSignalEligibility(
  context: SignalContext | null,
  entryPrice: number,
  createdAt?: string,
  options?: { 
    staleAgeHours?: number;
    isMarketOpen?: boolean;
    skipFlatTrend?: boolean;
    skipLowRelVol?: boolean;
  }
): EligibilityResult {
  // Gate 0: Context must exist
  if (!context) {
    return {
      eligible: false,
      reason: "missing_context",
      detail: "No signalContext available",
    };
  }

  // Gate 1: Bars used (context requirement)
  if (!Number.isFinite(context.barsUsed)) {
    return {
      eligible: false,
      reason: "insufficient_bars",
      detail: "barsUsed not available",
    };
  }

  if (context.barsUsed < MIN_BARS_REQUIRED) {
    return {
      eligible: false,
      reason: "insufficient_bars",
      detail: `${context.barsUsed} < ${MIN_BARS_REQUIRED}`,
    };
  }

  // Gate 1b: Staleness guard (live/recovery mode controlled by caller)
  if (typeof options?.staleAgeHours === "number" && isSignalStale(createdAt, options.staleAgeHours)) {
    return {
      eligible: false,
      reason: "stale",
      detail: `createdAt older than ${options.staleAgeHours}h`,
    };
  }

  // Gate 1c: Market-hours staleness (stricter during trading)
  if (options?.isMarketOpen && isSignalStaleMarketHours(createdAt)) {
    return {
      eligible: false,
      reason: "stale_market_hours",
      detail: `createdAt older than ${STALE_MARKET_HOURS_MINUTES}min during market hours`,
    };
  }

  // Gate 2: Average share volume
  if (context.avgVolume == null || context.avgVolume < MIN_AVG_VOL_SHARES) {
    const avgVol = context.avgVolume ?? 0;
    return {
      eligible: false,
      reason: "volume_too_low",
      detail: `${Math.round(avgVol)} < ${MIN_AVG_VOL_SHARES}`,
    };
  }

  // Gate 3: Average dollar volume
  if (Number.isFinite(entryPrice) && entryPrice > 0) {
    const avgDollarVol = context.avgVolume * entryPrice;
    if (avgDollarVol < MIN_AVG_DOLLAR_VOL) {
      return {
        eligible: false,
        reason: "dollar_volume_too_low",
        detail: `$${Math.round(avgDollarVol)} < $${MIN_AVG_DOLLAR_VOL}`,
      };
    }
  }

  // Gate 4: Minimum price (liquidity, slippage sanity)
  if (entryPrice < MIN_PRICE_REQUIRED) {
    return {
      eligible: false,
      reason: "price_too_low",
      detail: `$${entryPrice.toFixed(2)} < $${MIN_PRICE_REQUIRED}`,
    };
  }

  // Gate 4b: Maximum price (capital efficiency, risk management)
  if (entryPrice > MAX_PRICE_ALLOWED) {
    return {
      eligible: false,
      reason: "price_too_high",
      detail: `$${entryPrice.toFixed(2)} > $${MAX_PRICE_ALLOWED}`,
    };
  }

  // Gate 5: Relative volume (market participation)
  const skipRelVolCheck = options?.skipLowRelVol === true;
  if (!skipRelVolCheck && context.relVolume != null && context.relVolume < MIN_REL_VOL_REQUIRED) {
    return {
      eligible: false,
      reason: "low_rel_volume",
      detail: `relVol ${context.relVolume.toFixed(2)} < ${MIN_REL_VOL_REQUIRED}`,
    };
  }

  // Gate 6: Flat trend rejection (weak/choppy setups)
  // Skip if the signal already passed scanner pre-post gating (it had a valid preScore)
  // or if caller explicitly requests skipFlatTrend
  const skipFlatCheck = options?.skipFlatTrend === true;
  if (!skipFlatCheck && context.trend === "FLAT") {
    return {
      eligible: false,
      reason: "flat_trend",
      detail: `Trend is FLAT (slopePct=${context.trendSlopePct?.toFixed(4) ?? "?"}, barsUsed=${context.barsUsed})`,
    };
  }

  // Gate 7: Spread sanity (if context includes spread data)
  if (
    context &&
    typeof (context as any).spreadPct === "number" &&
    (context as any).spreadPct > MAX_SPREAD_PCT
  ) {
    return {
      eligible: false,
      reason: "spread_too_wide",
      detail: `${((context as any).spreadPct * 100).toFixed(2)}% > ${(MAX_SPREAD_PCT * 100).toFixed(2)}%`,
    };
  }

  return { eligible: true };
}

/**
 * Check if signal is considered "stale" (too old) for live scoring.
 * Useful for rejecting signals that arrived but were never scored.
 * 
 * @param createdAt ISO timestamp of signal creation
 * @param staleAgeHours How many hours old before considered stale (default 48)
 * @returns true if signal is older than threshold
 */
export function isSignalStale(
  createdAt: string | undefined,
  staleAgeHours: number = 48
): boolean {
  if (!createdAt) return false;

  try {
    const createdTime = new Date(createdAt).getTime();
    if (!Number.isFinite(createdTime)) return false;

    const ageHours = (Date.now() - createdTime) / (60 * 60 * 1000);
    return ageHours > staleAgeHours;
  } catch {
    return false;
  }
}

/**
 * Check if signal is too old during market hours (stricter threshold).
 * Default: 30 minutes during market hours to prevent stale entries.
 * 
 * @param createdAt ISO timestamp of signal creation
 * @returns true if signal is older than market-hours threshold
 */
export function isSignalStaleMarketHours(createdAt: string | undefined): boolean {
  if (!createdAt) return false;

  try {
    const createdTime = new Date(createdAt).getTime();
    if (!Number.isFinite(createdTime)) return false;

    const ageMinutes = (Date.now() - createdTime) / (60 * 1000);
    return ageMinutes > STALE_MARKET_HOURS_MINUTES;
  } catch {
    return false;
  }
}

/**
 * Compute pre-score for ranking signals before GPT scoring.
 * This enables smart prioritization of best signals to score first.
 * 
 * preScore formula:
 *   (relVol * 2) + trendStrength + liquidityScore - |vwapDistance|
 * 
 * Higher preScore = better candidate for scoring
 * 
 * @param context Signal context
 * @param entryPrice Entry price for VWAP distance calculation
 * @returns preScore value (higher = better)
 */
export function computePreScore(
  context: SignalContext | null,
  entryPrice: number
): number {
  if (!context) return 0;

  // Component 1: Relative volume (weighted x2)
  const relVolComponent = Math.min((context.relVolume ?? 1) * 2, 6); // Cap at 6

  // Component 2: Trend strength (based on slope magnitude)
  const trendSlopeMagnitude = Math.abs(context.trendSlopePct ?? 0);
  let trendStrength = 1;
  if (context.trend === "UP" || context.trend === "DOWN") {
    trendStrength = Math.min(1 + trendSlopeMagnitude * 20, 3); // 1-3 range
  } else {
    trendStrength = 0.5; // Flat trend penalty
  }

  // Component 3: Liquidity score (based on dollar volume)
  let liquidityScore = 1;
  if (context.avgVolume && entryPrice > 0) {
    const dollarVol = context.avgVolume * entryPrice;
    if (dollarVol >= 10_000_000) liquidityScore = 2;
    else if (dollarVol >= 2_000_000) liquidityScore = 1.5;
    else if (dollarVol >= 500_000) liquidityScore = 1;
    else liquidityScore = 0.5;
  }

  // Component 4: VWAP distance penalty
  let vwapPenalty = 0;
  if (context.vwap && context.vwap > 0 && entryPrice > 0) {
    const vwapDistancePct = Math.abs((entryPrice - context.vwap) / context.vwap) * 100;
    vwapPenalty = Math.min(vwapDistancePct, 3); // Cap penalty at 3
  }

  const preScore = relVolComponent + trendStrength + liquidityScore - vwapPenalty;
  return Math.round(preScore * 100) / 100;
}

/**
 * Get human-readable threshold summary for logging/diagnostics.
 */
export function getEligibilityThresholds() {
  return {
    minBars: MIN_BARS_REQUIRED,
    minPrice: MIN_PRICE_REQUIRED,
    maxPrice: MAX_PRICE_ALLOWED,
    minAvgVolShares: MIN_AVG_VOL_SHARES,
    minAvgDollarVol: MIN_AVG_DOLLAR_VOL,
    maxSpreadPct: MAX_SPREAD_PCT,
    minRelVol: MIN_REL_VOL_REQUIRED,
    staleMarketHoursMinutes: STALE_MARKET_HOURS_MINUTES,
  };
}
