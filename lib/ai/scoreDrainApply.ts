import { shouldQualify } from "@/lib/aiQualify";
import { bumpTodayFunnel } from "@/lib/funnelRedis";

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
  signal.aiScore = 0;
  signal.aiGrade = "F";
  signal.qualified = false;
  signal.shownInApp = false;
  signal.scoredAt = nowIso;
  signal.updatedAt = nowIso;
  signal.scoringLockUntil = undefined;
  signal.scoringStartedAt = undefined;
  // Clear other score fields for consistency
  delete signal.score;
  delete signal.grade;
  delete signal.totalScore;
  delete signal.tradePlan;
  delete signal.error;
  
  // Track as skip (not error) in funnel
  bumpTodayFunnel({ skipInsufficientBars: 1 }).catch(console.warn);
  
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

export function applyScoreError(signal: any, reason: string | undefined, nowIso: string) {
  signal.status = "ERROR";
  signal.error = reason?.includes("timeout") ? "model_timeout" : "scoring_failed";
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
  signal.aiDirection = scored.aiDirection ?? signal.aiDirection ?? null;
  signal.bestDirection = scored.bestDirection ?? signal.bestDirection ?? null;
  signal.longScore = scored.longScore ?? signal.longScore ?? null;
  signal.shortScore = scored.shortScore ?? signal.shortScore ?? null;

  // Ensure direction is never null (use aiDirection with fallback)
  signal.direction = computeSignalDirection(signal);

  signal.qualified = shouldQualify({
    score: scored.aiScore,
    grade: scored.aiGrade,
  });
  signal.shownInApp = signal.qualified;
  return signal;
}

/**
 * Compute signal direction with fallback logic:
 * 1. Prefer aiDirection if present
 * 2. Fallback to existing direction heuristic
 * 3. Infer from entry/stop prices
 * 4. Default to LONG
 */
function computeSignalDirection(signal: any): "LONG" | "SHORT" {
  // Prefer AI's chosen direction
  if (signal.aiDirection === "LONG" || signal.aiDirection === "SHORT") {
    return signal.aiDirection;
  }

  // Use existing heuristic direction if available
  if (signal.direction === "LONG" || signal.direction === "SHORT") {
    return signal.direction;
  }

  // Infer from entry/stop: stop < entry => LONG, stop > entry => SHORT
  const entry = Number(signal.entryPrice);
  const stop = Number(signal.stopPrice);
  if (Number.isFinite(entry) && Number.isFinite(stop)) {
    if (stop < entry) return "LONG";
    if (stop > entry) return "SHORT";
  }

  // Default to LONG
  return "LONG";
}
