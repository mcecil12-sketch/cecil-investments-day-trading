/**
 * Hard pre-GPT gating for signal eligibility.
 * Checks minimum context, liquidity, and quality thresholds before scoring.
 * Prevents junk signals from consuming API quota and clogging the funnel.
 */

import type { SignalContext } from "@/lib/signalContext";

// Threshold constants from environment or defaults
const MIN_BARS_REQUIRED = Number(process.env.MIN_BARS_FOR_AI ?? 20);
const MIN_PRICE_REQUIRED = Number(process.env.MIN_PRICE ?? 3);
const MIN_AVG_VOL_SHARES = Number(process.env.MIN_AVG_VOL_SHARES ?? 600);
const MIN_AVG_DOLLAR_VOL = Number(process.env.MIN_AVG_DOLLAR_VOL ?? 300000);
const MAX_SPREAD_PCT = Number(process.env.MAX_SPREAD_PCT ?? 0.5); // 0.5% = 50 bps

export type SkipReason =
  | "insufficient_bars"
  | "volume_too_low"
  | "dollar_volume_too_low"
  | "price_too_low"
  | "spread_too_wide"
  | "stale"; // Signal too old (e.g., created > 48h ago)

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: SkipReason; detail?: string };

/**
 * Evaluate whether a signal meets minimum thresholds for AI scoring.
 * 
 * Checks (in order):
 * 1. barsUsed >= MIN_BARS_REQUIRED (default 20)
 * 2. avgVolume >= MIN_AVG_VOL_SHARES (default 600)
 * 3. avgDollarVol >= MIN_AVG_DOLLAR_VOL (default 300000)
 * 4. price >= MIN_PRICE_REQUIRED (default 3)
 * 5. spread (if available) <= MAX_SPREAD_PCT
 * 
 * Returns early on first failure (order matters for diagnostics).
 * 
 * @param context Signal context with bars, volume, and price data
 * @param entryPrice Entry price of the signal
 * @param createdAt ISO timestamp of signal creation (for staleness check)
 * @returns Result indicating eligibility or reason for skipping
 */
export function evaluateSignalEligibility(
  context: SignalContext | null,
  entryPrice: number,
  createdAt?: string,
  options?: { staleAgeHours?: number }
): EligibilityResult {
  // Gate 1: Bars used (context requirement)
  if (!context || !Number.isFinite(context.barsUsed)) {
    return {
      eligible: false,
      reason: "insufficient_bars",
      detail: "No context available",
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

  // Gate 5: Spread sanity (if context includes spread data)
  // Light check: if available, use it; if not, skip
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
 * Get human-readable threshold summary for logging/diagnostics.
 */
export function getEligibilityThresholds() {
  return {
    minBars: MIN_BARS_REQUIRED,
    minPrice: MIN_PRICE_REQUIRED,
    minAvgVolShares: MIN_AVG_VOL_SHARES,
    minAvgDollarVol: MIN_AVG_DOLLAR_VOL,
    maxSpreadPct: MAX_SPREAD_PCT,
  };
}
