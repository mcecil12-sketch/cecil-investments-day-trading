/**
 * Pre-Post Gating for Scanner Signals
 * Phase 3 Performance Optimization
 *
 * Moves weak-candidate rejection upstream into scanner posting.
 * Direction-aware thresholds allow different quality bars for LONG vs SHORT.
 */

export type GateResult = {
  shouldPost: boolean;
  reason: string | null;
  note: string | null;
};

export type SignalDirection = "LONG" | "SHORT";

export type CandidateContext = {
  ticker: string;
  side: SignalDirection;
  patternScore: number;
  patternType: string;
  relVol?: number;
  avgDollarVol?: number;
  spreadPct?: number;
  vwapDistPct?: number;
  atrPct?: number;
  minutesSinceOpen?: number;
  preScore?: number;
  trendStrengthPct?: number;
  rangePct?: number;
  belowVwap?: boolean;
  lowerHighLowerLow?: boolean;
  breakdownVolumeIncreasing?: boolean;
};

// --------------------------------------------------------------------------
// Direction-Aware Config with Env-Backed Defaults
// --------------------------------------------------------------------------

// LONG thresholds
const MIN_RELVOL_LONG = Number(process.env.SCAN_MIN_RELVOL_LONG ?? 0.4);
const MIN_DOLLAR_VOL_LONG = Number(process.env.SCAN_MIN_DOLLAR_VOL_LONG ?? 250_000);
const MIN_PRESCORE_LONG = Number(process.env.SCAN_MIN_PRESCORE_LONG ?? 25);
const MAX_SPREAD_PCT_LONG = Number(process.env.SCAN_MAX_SPREAD_PCT_LONG ?? 0.75);
const MAX_VWAP_DIST_PCT_LONG = Number(process.env.SCAN_MAX_VWAP_DIST_PCT_LONG ?? 1.2);

// SHORT thresholds (typically stricter due to higher risk)
const MIN_RELVOL_SHORT = Number(process.env.SCAN_MIN_RELVOL_SHORT ?? 1.2);
const MIN_DOLLAR_VOL_SHORT = Number(process.env.SCAN_MIN_DOLLAR_VOL_SHORT ?? 400_000);
const MIN_PRESCORE_SHORT = Number(process.env.SCAN_MIN_PRESCORE_SHORT ?? 40);
const MAX_SPREAD_PCT_SHORT = Number(process.env.SCAN_MAX_SPREAD_PCT_SHORT ?? 0.4);
const MAX_VWAP_DIST_PCT_SHORT = Number(process.env.SCAN_MAX_VWAP_DIST_PCT_SHORT ?? 1.8);

const MIN_TREND_STRENGTH_LONG_PCT = Number(process.env.SCAN_MIN_TREND_STRENGTH_LONG_PCT ?? 0.2);
const MIN_TREND_STRENGTH_SHORT_PCT = Number(process.env.SCAN_MIN_TREND_STRENGTH_SHORT_PCT ?? 0.25);
const MIN_RANGE_PCT = Number(process.env.SCAN_PREPOST_MIN_RANGE_PCT ?? 0.35);

// Universal gates (apply to both directions)
const MIN_PATTERN_SCORE = Number(process.env.SCAN_MIN_PATTERN_SCORE ?? 0);
const OPENING_GRACE_MINUTES = Number(process.env.SCAN_OPENING_GRACE_MINUTES ?? 15);
const OPENING_PRESCORE_DISCOUNT = Number(process.env.SCAN_OPENING_PRESCORE_DISCOUNT ?? 10);

// Feature flags
const ENABLE_PREPOST_GATING = process.env.SCAN_ENABLE_PREPOST_GATING !== "0";
const LOG_PREPOST_REJECTIONS = process.env.SCAN_LOG_PREPOST_REJECTIONS === "1";

// --------------------------------------------------------------------------
// Config Export (for telemetry/debugging)
// --------------------------------------------------------------------------
export function getPrePostConfig() {
  return {
    enabled: ENABLE_PREPOST_GATING,
    long: {
      minRelVol: MIN_RELVOL_LONG,
      minDollarVol: MIN_DOLLAR_VOL_LONG,
      minPreScore: MIN_PRESCORE_LONG,
      maxSpreadPct: MAX_SPREAD_PCT_LONG,
      maxVwapDistPct: MAX_VWAP_DIST_PCT_LONG,
    },
    short: {
      minRelVol: MIN_RELVOL_SHORT,
      minDollarVol: MIN_DOLLAR_VOL_SHORT,
      minPreScore: MIN_PRESCORE_SHORT,
      maxSpreadPct: MAX_SPREAD_PCT_SHORT,
      maxVwapDistPct: MAX_VWAP_DIST_PCT_SHORT,
    },
    universal: {
      minPatternScore: MIN_PATTERN_SCORE,
      openingGraceMinutes: OPENING_GRACE_MINUTES,
      openingPreScoreDiscount: OPENING_PRESCORE_DISCOUNT,
      minTrendStrengthLongPct: MIN_TREND_STRENGTH_LONG_PCT,
      minTrendStrengthShortPct: MIN_TREND_STRENGTH_SHORT_PCT,
      minRangePct: MIN_RANGE_PCT,
    },
  };
}

// --------------------------------------------------------------------------
// Pre-Post Gating Logic
// --------------------------------------------------------------------------

/**
 * Evaluates whether a candidate signal should be posted.
 * Direction-aware: applies different thresholds for LONG vs SHORT.
 *
 * @param ctx - Candidate context with metrics
 * @returns GateResult indicating whether to post and rejection reason if not
 */
export function shouldPostSignal(ctx: CandidateContext): GateResult {
  // Feature flag: if gating disabled, always post
  if (!ENABLE_PREPOST_GATING) {
    return { shouldPost: true, reason: null, note: null };
  }

  const isLong = ctx.side === "LONG";
  const isOpening = (ctx.minutesSinceOpen ?? 999) <= OPENING_GRACE_MINUTES;

  // Get direction-specific thresholds
  const minRelVol = isLong ? MIN_RELVOL_LONG : MIN_RELVOL_SHORT;
  const minDollarVol = isLong ? MIN_DOLLAR_VOL_LONG : MIN_DOLLAR_VOL_SHORT;
  const minPreScore = isLong ? MIN_PRESCORE_LONG : MIN_PRESCORE_SHORT;
  const maxSpreadPct = isLong ? MAX_SPREAD_PCT_LONG : MAX_SPREAD_PCT_SHORT;
  const maxVwapDistPct = isLong ? MAX_VWAP_DIST_PCT_LONG : MAX_VWAP_DIST_PCT_SHORT;

  // Apply opening grace period discount to preScore threshold
  const effectivePreScoreThreshold = isOpening
    ? Math.max(0, minPreScore - OPENING_PRESCORE_DISCOUNT)
    : minPreScore;

  // Universal pattern score gate
  if (ctx.patternScore < MIN_PATTERN_SCORE) {
    const result: GateResult = {
      shouldPost: false,
      reason: "patternScoreTooLow",
      note: `patternScore=${ctx.patternScore.toFixed(1)} min=${MIN_PATTERN_SCORE}`,
    };
    maybeLog(ctx, result);
    return result;
  }

  // Relative volume gate
  if (ctx.relVol !== undefined && ctx.relVol < minRelVol) {
    const result: GateResult = {
      shouldPost: false,
      reason: "lowRelVol",
      note: `relVol=${ctx.relVol.toFixed(2)} min=${minRelVol} side=${ctx.side}`,
    };
    maybeLog(ctx, result);
    return result;
  }

  // Dollar volume gate
  if (ctx.avgDollarVol !== undefined && ctx.avgDollarVol < minDollarVol) {
    const result: GateResult = {
      shouldPost: false,
      reason: "lowDollarVol",
      note: `dollarVol=${Math.round(ctx.avgDollarVol)} min=${minDollarVol} side=${ctx.side}`,
    };
    maybeLog(ctx, result);
    return result;
  }

  // Spread gate
  if (ctx.spreadPct !== undefined && ctx.spreadPct > maxSpreadPct) {
    const result: GateResult = {
      shouldPost: false,
      reason: "spreadTooWide",
      note: `spreadPct=${ctx.spreadPct.toFixed(2)} max=${maxSpreadPct} side=${ctx.side}`,
    };
    maybeLog(ctx, result);
    return result;
  }

  // VWAP distance gate (direction-specific logic)
  if (ctx.vwapDistPct !== undefined) {
    // For LONG: reject if too far above VWAP (chasing extended)
    // For SHORT: reject if too far below VWAP (chasing breakdown)
    const absVwapDist = Math.abs(ctx.vwapDistPct);
    if (absVwapDist > maxVwapDistPct) {
      const result: GateResult = {
        shouldPost: false,
        reason: "vwapTooFar",
        note: `vwapDistPct=${ctx.vwapDistPct.toFixed(2)} max=${maxVwapDistPct} side=${ctx.side}`,
      };
      maybeLog(ctx, result);
      return result;
    }
  }

  // Trend strength gate to reject flat/weak trends.
  if (ctx.trendStrengthPct !== undefined) {
    if (isLong && ctx.trendStrengthPct < MIN_TREND_STRENGTH_LONG_PCT) {
      const result: GateResult = {
        shouldPost: false,
        reason: "trendWeak",
        note: `trendStrengthPct=${ctx.trendStrengthPct.toFixed(3)} min=${MIN_TREND_STRENGTH_LONG_PCT} side=${ctx.side}`,
      };
      maybeLog(ctx, result);
      return result;
    }
    if (!isLong && Math.abs(Math.min(0, ctx.trendStrengthPct)) < MIN_TREND_STRENGTH_SHORT_PCT) {
      const result: GateResult = {
        shouldPost: false,
        reason: "trendWeak",
        note: `trendStrengthPct=${ctx.trendStrengthPct.toFixed(3)} minDowntrend=${MIN_TREND_STRENGTH_SHORT_PCT} side=${ctx.side}`,
      };
      maybeLog(ctx, result);
      return result;
    }
  }

  // Reject low-range compression candles without expansion.
  if (ctx.rangePct !== undefined && ctx.rangePct < MIN_RANGE_PCT) {
    const result: GateResult = {
      shouldPost: false,
      reason: "lowRange",
      note: `rangePct=${ctx.rangePct.toFixed(3)} min=${MIN_RANGE_PCT}`,
    };
    maybeLog(ctx, result);
    return result;
  }

  // Short-only structural quality requirements.
  if (!isLong) {
    if (ctx.belowVwap === false) {
      const result: GateResult = {
        shouldPost: false,
        reason: "vwapTooFar",
        note: "short_requires_below_vwap",
      };
      maybeLog(ctx, result);
      return result;
    }
    if (ctx.lowerHighLowerLow === false) {
      const result: GateResult = {
        shouldPost: false,
        reason: "trendWeak",
        note: "short_requires_lower_highs_and_lower_lows",
      };
      maybeLog(ctx, result);
      return result;
    }
    if (ctx.breakdownVolumeIncreasing === false) {
      const result: GateResult = {
        shouldPost: false,
        reason: "lowRelVol",
        note: "short_requires_increasing_breakdown_volume",
      };
      maybeLog(ctx, result);
      return result;
    }
  }

  // Pre-score gate (with opening grace)
  if (ctx.preScore !== undefined && ctx.preScore < effectivePreScoreThreshold) {
    const result: GateResult = {
      shouldPost: false,
      reason: "preScoreTooLow",
      note: `preScore=${ctx.preScore} min=${effectivePreScoreThreshold} opening=${isOpening} side=${ctx.side}`,
    };
    maybeLog(ctx, result);
    return result;
  }

  // All gates passed
  return { shouldPost: true, reason: null, note: null };
}

// --------------------------------------------------------------------------
// Batch Gating for Scan Results
// --------------------------------------------------------------------------

export type GatingStats = {
  total: number;
  passed: number;
  rejected: number;
  passedLong: number;
  passedShort: number;
  rejectedLong: number;
  rejectedShort: number;
  rejectionReasons: Record<string, number>;
};

/**
 * Applies pre-post gating to a batch of candidates.
 * Returns filtered candidates and detailed stats.
 */
export function applyPrePostGating(
  candidates: CandidateContext[]
): { passed: CandidateContext[]; stats: GatingStats } {
  const stats: GatingStats = {
    total: candidates.length,
    passed: 0,
    rejected: 0,
    passedLong: 0,
    passedShort: 0,
    rejectedLong: 0,
    rejectedShort: 0,
    rejectionReasons: {},
  };

  const passed: CandidateContext[] = [];

  for (const candidate of candidates) {
    const result = shouldPostSignal(candidate);

    if (result.shouldPost) {
      passed.push(candidate);
      stats.passed += 1;
      if (candidate.side === "LONG") {
        stats.passedLong += 1;
      } else {
        stats.passedShort += 1;
      }
    } else {
      stats.rejected += 1;
      if (candidate.side === "LONG") {
        stats.rejectedLong += 1;
      } else {
        stats.rejectedShort += 1;
      }
      const reason = result.reason ?? "unknown";
      stats.rejectionReasons[reason] = (stats.rejectionReasons[reason] ?? 0) + 1;
    }
  }

  return { passed, stats };
}

// --------------------------------------------------------------------------
// Internal Helpers
// --------------------------------------------------------------------------

function maybeLog(ctx: CandidateContext, result: GateResult) {
  if (LOG_PREPOST_REJECTIONS) {
    console.log(
      `[prepost-gate] REJECT ${ctx.ticker} ${ctx.side}: ${result.reason} - ${result.note}`
    );
  }
}
