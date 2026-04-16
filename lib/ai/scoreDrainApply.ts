import { shouldQualify } from "@/lib/aiQualify";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { computeDirection } from "@/lib/scannerUtils";
import { normalizeAiDirectionForStorage } from "@/lib/jsonDb";
import type { SkipReason } from "@/lib/ai/eligibilityGates";

type ParseFailedMeta = {
  aiModel?: string | null;
  aiRawHead?: string | null;
  aiParseError?: string | null;
  aiRequestId?: string | null;
};

export function applyInsufficientBars(signal: any, reason: string, nowIso: string) {
  signal.status = "ARCHIVED";
  signal.skipReason = "insufficient_bars";
  signal.aiSummary = reason || "Insufficient recent bars";
  signal.qualified = false;
  signal.shownInApp = false;
  signal.scoredAt = nowIso;
  signal.updatedAt = nowIso;
  signal.scoringLockUntil = undefined;
  signal.scoringStartedAt = undefined;
  // Clear other score fields for consistency
  delete signal.aiScore;
  delete signal.aiGrade;
  delete signal.score;
  delete signal.grade;
  delete signal.totalScore;
  delete signal.tradePlan;
  delete signal.error;
  
  // Track as skip (not error) in funnel
  bumpTodayFunnel({ skipInsufficientBars: 1 }).catch(console.warn);
  
  return signal;
}

/**
 * Apply pre-GPT skip reason for signals that don't meet eligibility gates.
 * Used for hard gates: bars, volume, price, trend, relVol, etc. (before AI scoring).
 * 
 * @param signal The signal being skipped
 * @param reason The specific skip reason (e.g., "volume_too_low", "price_too_low")
 * @param detail Optional diagnostic detail (e.g., "actual=500 < required=600")
 * @param nowIso Current time ISO string
 */
export function applyPreGptSkip(
  signal: any,
  reason: SkipReason,
  detail: string | undefined,
  nowIso: string
) {
  signal.status = "ARCHIVED";
  signal.skipReason = reason;
  signal.qualified = false;
  signal.shownInApp = false;
  signal.scoredAt = nowIso;
  signal.updatedAt = nowIso;
  signal.scoringLockUntil = undefined;
  signal.scoringStartedAt = undefined;
  
  // Build summary with detail if available
  const summaryMap: Record<SkipReason, string> = {
    insufficient_bars: "Insufficient recent bars",
    missing_context: "Missing signal context",
    volume_too_low: "Average volume below minimum",
    dollar_volume_too_low: "Dollar volume below minimum",
    price_too_low: "Entry price below minimum",
    price_too_high: "Entry price exceeds maximum",
    spread_too_wide: "Spread exceeds maximum",
    low_rel_volume: "Relative volume below minimum",
    flat_trend: "Flat trend (no directional bias)",
    stale: "Signal too old (stale)",
    stale_market_hours: "Signal too old for market hours",
  };
  
  signal.aiSummary = detail
    ? `${summaryMap[reason]}: ${detail}`
    : summaryMap[reason];
  
  // Clear other score fields
  delete signal.aiScore;
  delete signal.aiGrade;
  delete signal.score;
  delete signal.grade;
  delete signal.totalScore;
  delete signal.tradePlan;
  delete signal.error;
  
  // Track in funnel by reason
  const funnelMetrics: Record<SkipReason, string> = {
    insufficient_bars: "skipInsufficientBars",
    missing_context: "skipMissingContext",
    volume_too_low: "skipVolumeTooLow",
    dollar_volume_too_low: "skipDollarVolume",
    price_too_low: "skipPriceTooLow",
    price_too_high: "skipPriceTooHigh",
    spread_too_wide: "skipSpreadTooWide",
    low_rel_volume: "skipLowRelVolume",
    flat_trend: "skipFlatTrend",
    stale: "skipStale",
    stale_market_hours: "skipStaleMarketHours",
  };
  
  const funnelKey = funnelMetrics[reason];
  bumpTodayFunnel({ [funnelKey]: 1 } as any).catch(console.warn);
  
  return signal;
}

export function applyParseFailed(
  signal: any,
  reason: string,
  meta: ParseFailedMeta | undefined,
  nowIso: string
) {
  signal.status = "ERROR";
  signal.error = "parse_failed";
  signal.aiSummary = `parse_failed: ${reason || "unparseable"}`;
  signal.aiModel = meta?.aiModel ?? null;
  signal.aiRawHead = meta?.aiRawHead ?? null;
  signal.aiParseError = meta?.aiParseError ?? reason ?? null;
  signal.aiRequestId = meta?.aiRequestId ?? null;
  signal.scoredAt = nowIso;
  signal.updatedAt = nowIso;
  signal.scoringLockUntil = undefined;
  signal.scoringStartedAt = undefined;
  // Clear all score fields for ERROR
  delete signal.aiScore;
  delete signal.score;
  delete signal.aiGrade;
  
  // Track error in funnel
  bumpTodayFunnel({ errorParseFailed: 1 }).catch(console.warn);
  delete signal.grade;
  delete signal.totalScore;
  delete signal.tradePlan;
  delete signal.qualified;
  delete signal.shownInApp;
  return signal;
}

export function applyScoreError(
  signal: any,
  reason: string | undefined,
  nowIso: string,
  errorCode?: string
) {
  signal.status = "ERROR";
  if (errorCode === "breaker_open" || errorCode === "scoring_disabled") {
    signal.error = errorCode;
  } else {
    signal.error = reason?.includes("timeout") ? "model_timeout" : "scoring_failed";
  }
  signal.aiErrorReason = reason;
  signal.scoredAt = nowIso;
  signal.updatedAt = nowIso;
  signal.scoringLockUntil = undefined;
  signal.scoringStartedAt = undefined;
  // Clear all score fields for ERROR
  delete signal.aiScore;
  delete signal.score;
  delete signal.aiGrade;
  delete signal.grade;
  delete signal.totalScore;
  delete signal.tradePlan;
  delete signal.qualified;
  delete signal.shownInApp;
  return signal;
}

export function applyScoreSuccess(signal: any, scored: any, nowIso: string) {
  // HARD INVARIANT: aiScore must be finite for SCORED
  if (!Number.isFinite(scored.aiScore)) {
    throw new Error(
      `applyScoreSuccess: aiScore must be finite for SCORED, got ${scored.aiScore}`
    );
  }

  signal.status = "SCORED";
  signal.aiScore = scored.aiScore;
  signal.score = scored.aiScore; // Backwards compat alias
  signal.aiGrade = scored.aiGrade ?? null;
  signal.grade = scored.aiGrade ?? null; // Backwards compat alias
  signal.aiSummary = scored.aiSummary ?? null;
  signal.totalScore = scored.totalScore ?? scored.aiScore;
  signal.tradePlan = scored.tradePlan ?? null;
  signal.scoredAt = nowIso;
  signal.updatedAt = nowIso;
  signal.scoringLockUntil = undefined;
  signal.scoringStartedAt = undefined;

  // Persist bidirectional scoring fields
  // CRITICAL: aiDirection must never be "NONE" in StoredSignal
  signal.aiDirection = normalizeAiDirectionForStorage(scored.aiDirection ?? signal.aiDirection);
  signal.bestDirection = scored.bestDirection ?? signal.bestDirection ?? null;
  signal.longScore = scored.longScore ?? signal.longScore ?? null;
  signal.shortScore = scored.shortScore ?? signal.shortScore ?? null;

  // Compute direction from available context (may be null if unclear)
  signal.direction = computeSignalDirection(signal);

  signal.qualified =
    typeof scored.qualified === "boolean"
      ? scored.qualified
      : shouldQualify({
          score: scored.aiScore,
          grade: scored.aiGrade,
        });
  // Only qualified signals should surface in app.
  signal.shownInApp = signal.qualified;
  return signal;
}

/**
 * Compute signal direction with improved heuristic:
 * 1. Prefer aiDirection if present (from AI scoring)
 * 2. Try to compute from signalContext (VWAP/trend) if available
 * 3. Fallback to existing direction if valid
 * 4. Leave null if no meaningful direction can be determined
 */
function computeSignalDirection(signal: any): "LONG" | "SHORT" | null {
  // Prefer AI's chosen direction
  if (signal.aiDirection === "LONG" || signal.aiDirection === "SHORT") {
    return signal.aiDirection;
  }

  // Try to use signalContext if available
  const ctx = signal.signalContext;
  if (ctx?.vwap != null && ctx?.trend) {
    const direction = computeDirection({
      price: Number(signal.entryPrice),
      vwap: ctx.vwap,
      trend: ctx.trend as "UP" | "DOWN" | "FLAT",
    });
    if (direction) return direction;
  }

  // Use existing heuristic direction if available
  if (signal.direction === "LONG" || signal.direction === "SHORT") {
    return signal.direction;
  }

  // No meaningful direction available
  return null;
}
