import { buildDefaultTradePlan, parseAiTradePlan, type TradePlan } from "@/lib/tradePlan";
import OpenAI from "openai";
import { recordSpend, recordAiCall, recordAiError, writeAiHeartbeat } from "./aiMetrics";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { buildSignalContext, SignalContext } from "@/lib/signalContext";
import { parseAiScoreOutput } from "@/lib/ai/scoreParse";
import { getParseRetryConfig } from "@/lib/ai/parseRetryConfig";
import { redis } from "@/lib/redis";
import { minScoreToQualify } from "@/lib/aiQualify";

function dynamicMinScore(sessionMinutes: number) {
  const m = Number.isFinite(sessionMinutes) ? sessionMinutes : 60;
  if (m <= 15) return { c: 6.3, b: 7.2, a: 8.4 };
  if (m <= 90) return { c: 6.5, b: 7.5, a: 8.5 };
  return { c: 6.8, b: 7.8, a: 8.7 };
}

function tierFromScore(score: number, mins: {c:number;b:number;a:number}) {
  if (score >= mins.a) return "A";
  if (score >= mins.b) return "B";
  if (score >= mins.c) return "C";
  return "REJECT";
}

export type Side = "LONG" | "SHORT";

export type RawSignal = {
  id: string;
  ticker: string;
  side: Side;
  direction?: Side | null; // Heuristic direction based on VWAP/trend analysis
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  timeframe: string;
  source: string;
  createdAt: string;
  reasoning?: string;
  // include any fields your scanner already sets:
  vwap?: number;
  pullbackPct?: number;
  trendScore?: number;
  liquidityScore?: number;
  playbookScore?: number;
  volumeScore?: number;
  catalystScore?: number;
  signalContext?: SignalContext;
};

export type AiGrade = "A+" | "A" | "B" | "C" | "D" | "F";

// Short-specific quality diagnostics
export type ShortQualityDiagnostics = {
  shortTrendQuality?: number; // 0-1.0: how clean/confident is the bearish trend
  vwapAlignmentQuality?: number; // 0-1.0: how well entry aligns with VWAP thesis
  relativeWeaknessQuality?: number; // 0-1.0: relative weakness vs market proxy
  bearishStructureQuality?: number; // 0-1.0: quality of structure (rejections, lower highs, etc)
  participationQuality?: number; // 0-1.0: volume/liquidity confirmation
  contextAgreement?: boolean; // scan reasoning matches actual VWAP/trend context
  shortPenaltyReasons?: string[]; // array of reason codes for penalty application
};

// Long-specific quality diagnostics
export type LongQualityDiagnostics = {
  longTrendQuality?: number; // 0-1.0: how clean/confident is the bullish trend
  vwapAlignmentQuality?: number; // 0-1.0: how well entry aligns with VWAP thesis
  participationQuality?: number; // 0-1.0: volume/liquidity confirmation
  continuationQuality?: number; // 0-1.0: quality of bullish continuation structure
  longPenaltyReasons?: string[]; // array of reason codes for penalty application
};

export type ScoredSignal = RawSignal & {
  aiScore: number | null; // 0–10, numeric (finalScore)
  aiGrade: AiGrade | null;
  aiSummary: string; // short explanation
  totalScore: number | null;
  status?: string;
  skipReason?: string;
  tradePlan?: TradePlan | null;
  qualified?: boolean;
  shownInApp?: boolean;
  aiRawHead?: string | null;
  aiErrorReason?: string | null;
  // Bidirectional scoring fields
  aiDirection?: "LONG" | "SHORT" | "NONE"; // Final selected direction
  longScore?: number | null; // 0-10 score for LONG hypothesis
  shortScore?: number | null; // 0-10 score for SHORT hypothesis
  bestDirection?: "LONG" | "SHORT" | "NONE";
  // Quality diagnostics
  shortDiagnostics?: ShortQualityDiagnostics;
  longDiagnostics?: LongQualityDiagnostics;
  // Actionability ranking (1-10, higher = prioritize for capital allocation)
  actionabilityRank?: number | null;
  // Setup frame classification
  setupFrame?: "continuation" | "mean_reversion" | "dip_buy" | "breakout" | "reversal" | "unknown" | null;
  // Explainability buckets
  vwapBucket?: "well_above" | "above" | "near" | "below" | "well_below" | null;
  trendBucket?: "strong_up" | "weak_up" | "flat" | "weak_down" | "strong_down" | null;
  relVolBucket?: "strong" | "normal" | "mediocre" | "light" | null;
  liquidityBucket?: "high" | "medium" | "low" | null;
  // Market posture bias
  postureBiasApplied?: boolean | null;
  postureBias?: number | null;
  // Direction competition
  longVsShortEdge?: number | null;
  shortPreferred?: boolean | null;
  // Qualification observability: why did this pass/fail and why did direction stay/flip
  qualifyDiagnostic?: string | null;
  // Scorer version tag for smoke-test confirmation
  _scorerVersion?: string;
  // Setup quality classification tags (v2 performance upgrade)
  setupQualityTags?: string[];
  rejectionTags?: string[];
  performanceBucket?: string;
};

type ModelResponse = {
  score?: number;
  grade?: AiGrade;
  summary?: string;
  aiScore?: number;
  aiGrade?: AiGrade;
  aiSummary?: string;
  totalScore?: number;
};

export type AiScoreResult =
  | {
      ok: true;
      scored: ScoredSignal;
      aiModel: string;
      aiRequestId?: string | null;
    }
  | {
      ok: false;
      error:
        | "ai_parse_failed"
        | "invalid_model_output"
        | "insufficient_bars"
        | "breaker_open"
        | "scoring_disabled";
      reason: string;
      rawHead?: string;
      aiModel: string;
      aiRequestId?: string | null;
      aiParseError?: string | null;
    };

function supportsCustomTemperature(model: string) {
  return !model.startsWith("gpt-5");
}

const MODEL_COSTS: Record<string, number> = {
  "gpt-5-mini": 0.005,
  "gpt-5.1": 0.026,
};

function estimateCost(model: string) {
  return MODEL_COSTS[model] ?? 0.01;
}

type NormalizedAiScoreResult = {
  aiScore: number
  aiGrade: string
  aiSummary: string
  rawHead?: string
  parseMode: "json" | "embedded_json" | "regex" | "fallback"
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Clamp score to valid range [1.0, 10.0].
 * Note: Returns 1.0 for invalid scores (not 0) to prevent aiScore=0 bugs.
 * For strict validation that should fail on invalid input, use scoreParse.ts.
 */
function clampScore(x: any) {
  const n = typeof x === "number" ? x : Number(x)
  // HARDENING: Return 1.0 minimum for invalid/zero scores (never 0)
  if (!Number.isFinite(n)) return 1.0
  if (n <= 0) return 1.0
  if (n > 10) return 10.0
  return Math.round(n * 100) / 100
}

function scoreToGrade(score: number) {
  const s = clamp(score, 0, 10)
  if (s >= 9) return "A"
  if (s >= 8) return "B"
  if (s >= 6) return "C"
  if (s >= 4) return "D"
  return "F"
}

function validateStructuredOutput(parsed: {
  longScore: number;
  shortScore: number;
  longSummary: string;
  shortSummary: string;
  chosenDirection: string;
  confidence: number;
}) {
  if (!Number.isFinite(parsed.longScore) || parsed.longScore < 0 || parsed.longScore > 10) {
    return "invalid_long_score";
  }
  if (!Number.isFinite(parsed.shortScore) || parsed.shortScore < 0 || parsed.shortScore > 10) {
    return "invalid_short_score";
  }
  if (!parsed.longSummary || !parsed.longSummary.trim()) {
    return "missing_long_summary";
  }
  if (!parsed.shortSummary || !parsed.shortSummary.trim()) {
    return "missing_short_summary";
  }
  if (!["LONG", "SHORT", "NONE"].includes(parsed.chosenDirection)) {
    return "invalid_chosen_direction";
  }
  if (!Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    return "invalid_confidence";
  }
  return null;
}

function normalizeDirectionalScore(x: any) {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(clamp(n, 0, 10) * 100) / 100;
}

function stripCodeFences(s: string) {
  return s.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, "").trim()
}

function extractFirstJsonObject(s: string): string | null {
  const t = stripCodeFences(s)
  const start = t.indexOf("{")
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < t.length; i++) {
    const ch = t[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return t.slice(start, i + 1)
    }
  }
  return null
}

function tryParseJson(s: string): any | null {
  const t = stripCodeFences(s)
  try {
    const obj = JSON.parse(t)
    if (obj && typeof obj === "object") return obj
  } catch {}
  const embedded = extractFirstJsonObject(t)
  if (embedded) {
    try {
      const obj = JSON.parse(embedded)
      if (obj && typeof obj === "object") return obj
    } catch {}
  }
  return null
}

function pickScore(obj: any): number | null {
  const cand = obj?.aiScore ?? obj?.score ?? obj?.totalScore ?? obj?.rating
  const n = typeof cand === "string" ? parseFloat(cand) : (typeof cand === "number" ? cand : NaN)
  if (Number.isFinite(n)) return clamp(n, 0, 10)
  return null
}

function pickSummary(obj: any): string | null {
  const cand = obj?.aiSummary ?? obj?.summary ?? obj?.reasoning ?? obj?.rationale ?? obj?.notes
  if (typeof cand === "string" && cand.trim()) return cand.trim()
  return null
}

function pickGrade(obj: any, score: number | null): string | null {
  const cand = obj?.aiGrade ?? obj?.grade
  if (typeof cand === "string" && cand.trim()) return cand.trim().toUpperCase()
  if (typeof score === "number") return scoreToGrade(score)
  return null
}

function scoreFromTextRegex(s: string): number | null {
  const t = stripCodeFences(s)
  const patterns = [
    /aiScore\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\bscore\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i,
    /Scored\s*[A-F]\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)/i,
    /\b([0-9]+(?:\.[0-9]+)?)\s*\/\s*10\b/i
  ]
  for (const p of patterns) {
    const m = t.match(p)
    if (m && m[1]) {
      const n = parseFloat(m[1])
      if (Number.isFinite(n)) return clamp(n, 0, 10)
    }
  }
  return null
}

function normalizeAiScoreResult(raw: string): NormalizedAiScoreResult {
  const rawHead = stripCodeFences(raw).slice(0, 800)
  const obj = tryParseJson(raw)

  if (obj) {
    const score = pickScore(obj)
    const summary = pickSummary(obj)
    const grade = pickGrade(obj, score ?? null)
    if (typeof score === "number" && summary) {
      return { aiScore: score, aiGrade: grade ?? scoreToGrade(score), aiSummary: summary, rawHead, parseMode: "json" }
    }
    const embedded = extractFirstJsonObject(raw)
    if (embedded) {
      try {
        const obj2 = JSON.parse(embedded)
        const score2 = pickScore(obj2)
        const summary2 = pickSummary(obj2)
        const grade2 = pickGrade(obj2, score2 ?? null)
        if (typeof score2 === "number" && summary2) {
          return { aiScore: score2, aiGrade: grade2 ?? scoreToGrade(score2), aiSummary: summary2, rawHead, parseMode: "embedded_json" }
        }
      } catch {}
    }
  }

  const scoreRx = scoreFromTextRegex(raw)
  if (typeof scoreRx === "number") {
    const gradeRx = scoreToGrade(scoreRx)
    const t = stripCodeFences(raw)
    const summary = t.length > 0 ? t.slice(0, 1200) : `Scored ${gradeRx} (${scoreRx}).`
    return { aiScore: clampScore(scoreRx), aiGrade: gradeRx, aiSummary: summary, rawHead, parseMode: "regex" }
  }

  return {
    aiScore: 1.0,
    aiGrade: "F",
    aiSummary: `Scored F (1.0). AI response parse fallback (non-JSON / missing fields). Raw excerpt: ${rawHead}`,
    rawHead,
    parseMode: "fallback"
  }
}

export function gradeFromScore(score: number): AiGrade {
  if (score >= 9) return "A+";
  if (score >= 7.5) return "B";
  if (score >= 6) return "C";
  if (score >= 4) return "D";
  return "F";
}

export function formatAiSummary(grade: AiGrade, score: number) {
  return `Scored ${grade} (${score}). AI response parse fallback. See rawHead for excerpt.`;
}

const MIN_BARS_FOR_AI = Number(process.env.MIN_BARS_FOR_AI ?? 20);
const MIN_AVG_DOLLAR_VOL_HARD = Number(process.env.MIN_AVG_DOLLAR_VOL_HARD ?? 300000);
const MIN_LONG_SCORE = Number(process.env.MIN_LONG_SCORE ?? 7.0);
const MIN_SHORT_SCORE = Number(process.env.MIN_SHORT_SCORE ?? 6.8);
const MIN_EDGE = Number(process.env.MIN_EDGE ?? 0.5);
const AI_SCORING_RETRY_MAX = Number(process.env.AI_SCORING_RETRY_MAX ?? 4);
const AI_SCORING_BREAKER_ENABLED = String(process.env.AI_SCORING_BREAKER_ENABLED ?? "1") === "1";

// Circuit breaker constants
const BREAKER_KEY = "ai:breaker:v1";
const BREAKER_ERROR_THRESHOLD = 10; // errors in window
const BREAKER_WINDOW_SEC = 120; // 2 minutes
const BREAKER_OPEN_TTL_SEC = 120; // 2 minutes

// ===== EXPLAINABILITY CLASSIFIERS =====

function classifyVwapBucket(
  entryPrice: number,
  vwap: number | null | undefined
): "well_above" | "above" | "near" | "below" | "well_below" {
  if (!vwap || vwap <= 0) return "near";
  const pct = ((entryPrice - vwap) / vwap) * 100;
  if (pct > 1.5) return "well_above";
  if (pct > 0.3) return "above";
  if (pct > -0.3) return "near";
  if (pct > -1.5) return "below";
  return "well_below";
}

function classifyTrendBucket(
  trend: string | undefined
): "strong_up" | "weak_up" | "flat" | "weak_down" | "strong_down" {
  if (!trend) return "flat";
  const t = trend.toUpperCase();
  if (t === "UP") return "strong_up";
  if (t === "DOWN") return "strong_down";
  return "flat";
}

function classifyRelVolBucket(
  relVolume: number | null | undefined
): "strong" | "normal" | "mediocre" | "light" {
  if (relVolume == null) return "normal";
  if (relVolume >= 1.3) return "strong";
  if (relVolume >= 0.9) return "normal";
  if (relVolume >= 0.65) return "mediocre";
  return "light";
}

function classifyLiquidityBucket(
  avgVolume: number | null | undefined,
  price: number
): "high" | "medium" | "low" {
  if (avgVolume == null) return "medium";
  const notional = avgVolume * price;
  if (notional >= 50_000_000) return "high";
  if (notional >= 5_000_000) return "medium";
  return "low";
}

function classifySetupFrame(
  direction: "LONG" | "SHORT" | "NONE",
  context: SignalContext | null,
  summary: string
): "continuation" | "mean_reversion" | "dip_buy" | "breakout" | "reversal" | "unknown" {
  if (direction === "NONE") return "unknown";
  const sl = (summary || "").toLowerCase();

  if (
    sl.includes("breakout") ||
    sl.includes("break out") ||
    sl.includes("new high") ||
    sl.includes("new low")
  ) {
    return "breakout";
  }

  if (
    sl.includes("reversal") ||
    sl.includes("reversing") ||
    sl.includes("rejection") ||
    sl.includes("overextended")
  ) {
    return "reversal";
  }

  if (direction === "LONG" && (sl.includes("dip") || sl.includes("bounce") || sl.includes("support hold"))) {
    return "dip_buy";
  }

  if (
    sl.includes("mean reversion") ||
    sl.includes("mean-reversion") ||
    sl.includes("revert") ||
    sl.includes("oversold") ||
    sl.includes("overbought")
  ) {
    return "mean_reversion";
  }

  if (context) {
    const trendAligned =
      (direction === "LONG" && context.trend === "UP") ||
      (direction === "SHORT" && context.trend === "DOWN");
    if (trendAligned) return "continuation";
  }

  return "unknown";
}

/**
 * Compute actionability rank 1-10 for capital rotation prioritization.
 * Higher = more actionable (deploy capital here first).
 */
function computeActionabilityRank(
  adjustedScore: number,
  setupFrame: "continuation" | "mean_reversion" | "dip_buy" | "breakout" | "reversal" | "unknown",
  direction: "LONG" | "SHORT" | "NONE",
  context: SignalContext | null,
  entryPrice: number
): number {
  // Base from tier
  let rank: number;
  if (adjustedScore >= 8.5) rank = 8;
  else if (adjustedScore >= 7.5) rank = 6;
  else if (adjustedScore >= 7.0) rank = 4;
  else rank = 2;

  // Setup frame modifier
  if (setupFrame === "continuation") rank += 2;
  else if (setupFrame === "breakout") rank += 1;
  else if (setupFrame === "dip_buy" || setupFrame === "mean_reversion") rank -= 1;

  // Volume/participation modifier
  if (context?.relVolume != null) {
    if (context.relVolume >= 1.3) rank += 1;
    else if (context.relVolume < 0.65) rank -= 1;
  }

  // VWAP alignment modifier
  if (context?.vwap && context.vwap > 0) {
    const pct = ((entryPrice - context.vwap) / context.vwap) * 100;
    const aligned =
      (direction === "LONG" && pct > 0.1) || (direction === "SHORT" && pct < -0.1);
    if (aligned) rank += 1;
    else rank -= 1;
  }

  // Flat trend LONG penalty
  if (direction === "LONG" && context?.trend === "FLAT") rank -= 2;
  else if (direction === "SHORT" && context?.trend === "UP") rank -= 2;

  return Math.max(1, Math.min(10, rank));
}

/**
 * Apply market posture bias to the winner score.
 * Reads MARKET_POSTURE env: "risk_on" | "risk_off" | "neutral" (default).
 * Returns a bias in range [-0.3, +0.3].
 */
function getMarketPostureBias(direction: "LONG" | "SHORT" | "NONE", score: number): number {
  const posture = (process.env.MARKET_POSTURE || "neutral").toLowerCase();
  if (posture === "neutral" || direction === "NONE") return 0;

  let bias = 0;

  if (posture === "risk_off") {
    // Penalize marginal longs, help marginal shorts
    if (direction === "LONG" && score >= 6.5 && score < 7.5) bias = -0.2;
    if (direction === "SHORT" && score >= 6.5 && score < 7.5) bias = +0.2;
  } else if (posture === "risk_on") {
    // Boost solid longs, penalize marginal shorts
    if (direction === "LONG" && score >= 7.0 && score < 8.5) bias = +0.15;
    if (direction === "SHORT" && score >= 6.5 && score < 7.5) bias = -0.2;
  }

  return Math.max(-0.3, Math.min(0.3, bias));
}

/**
 * Evaluate LONG-specific quality factors and apply penalties for weak setups.
 * Returns: { adjustedScore, diagnostics, penaltyReasons, shortPreferred }
 */
function evaluateLongQuality(params: {
  rawScore: number;
  rawShortScore: number;
  summary: string;
  context: SignalContext | null;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  reasoning?: string;
  minQualifyScore: number;
}): {
  adjustedScore: number;
  diagnostics: LongQualityDiagnostics;
  penaltyReasons: string[];
  shortPreferred: boolean;
} {
  const { rawScore, rawShortScore, summary, context, entryPrice, reasoning, minQualifyScore } = params;
  let adjustedScore = rawScore;
  const reasons: string[] = [];
  const diagnostics: LongQualityDiagnostics = {};

  // No context = no structural adjustments; no speculative penalty
  if (!context) {
    return { adjustedScore, diagnostics, penaltyReasons: reasons, shortPreferred: false };
  }

  // ===== TREND QUALITY =====
  const trendQuality =
    context.trend === "UP" ? 0.85 : context.trend === "FLAT" ? 0.35 : 0.1;
  diagnostics.longTrendQuality = trendQuality;

  if (context.trend === "FLAT") {
    // Tightened: flat-trend longs are high-noise setups. Only exceptional volume partially redeems.
    // Strong relVolume (>=1.5) → -0.3, decent (>=1.0) → -0.6, weak → -0.9
    const rv = context.relVolume ?? 0;
    const flatLongPenalty = rv >= 1.5 ? -0.3 : rv >= 1.0 ? -0.6 : -0.9;
    adjustedScore += flatLongPenalty;
    reasons.push("flat_trend_long");
  } else if (context.trend === "DOWN") {
    // Down-trend longs are strongly contradictory; harsher penalty
    adjustedScore -= 1.2;
    reasons.push("downtrend_long_contradiction");
  } else {
    // UP trend — weak slope is a very minor signal, trim only slightly
    const slope = Math.abs(context.trendSlopePct || 0);
    if (slope < 0.02) {
      adjustedScore -= 0.05;
      reasons.push("weak_uptrend_slope");
    }
  }

  // ===== VWAP ALIGNMENT =====
  let vwapQuality = 0.5;
  const priceVsVwap =
    context.vwap && context.vwap > 0
      ? ((entryPrice - context.vwap) / context.vwap) * 100
      : null;

  if (priceVsVwap !== null) {
    if (context.trend === "UP" && priceVsVwap < 0) {
      // Pullback into VWAP in uptrend — valid entry, no penalty
      vwapQuality = 0.75;
    } else if (priceVsVwap >= 0) {
      // At or above VWAP: ideal for LONG
      vwapQuality = priceVsVwap > 1.0 ? 0.65 : 0.85;
    } else {
      // Below VWAP: penalty scales with distance + trend context
      if (context.trend === "UP" && priceVsVwap > -0.5) {
        // Shallow pullback in uptrend: mild penalty (dip-buy)
        vwapQuality = 0.6;
        adjustedScore -= 0.1;
        reasons.push("shallow_pullback_below_vwap");
      } else if (context.trend === "UP") {
        // Deeper pullback in uptrend: moderate concern
        vwapQuality = 0.45;
        adjustedScore -= 0.25;
        reasons.push("entry_below_vwap_no_reclaim");
      } else {
        // Below VWAP in non-uptrend: strong penalty
        vwapQuality = 0.25;
        adjustedScore -= 0.5;
        reasons.push("below_vwap_non_uptrend_long");
      }
    }
  }
  diagnostics.vwapAlignmentQuality = vwapQuality;

  // ===== PARTICIPATION / VOLUME =====
  let participationQuality = 0.6;
  if (context.relVolume != null) {
    if (context.relVolume >= 1.3) {
      participationQuality = 0.9;
    } else if (context.relVolume >= 1.0) {
      participationQuality = 0.7;
    } else if (context.relVolume >= 0.75) {
      // relVol < 1.0: penalize unless strong trend AND VWAP-aligned
      participationQuality = 0.45;
      const hasStrongTrendVwap = context.trend === "UP" && (priceVsVwap !== null && priceVsVwap >= 0);
      if (!hasStrongTrendVwap) {
        adjustedScore -= 0.25;
        reasons.push("sub1_volume_no_trend_vwap_offset");
      }
    } else if (context.relVolume >= 0.65) {
      // Mediocre volume: trim unless uptrend with VWAP
      participationQuality = 0.4;
      adjustedScore -= 0.25;
      reasons.push("mediocre_volume_participation");
    } else {
      // Light volume: meaningful concern
      participationQuality = 0.2;
      adjustedScore -= 0.35;
      reasons.push("light_volume_participation");
    }
  }
  diagnostics.participationQuality = participationQuality;

  // ===== MEAN-REVERSION / DIP-BUY FRAMING =====
  const sl = (summary || "").toLowerCase() + " " + (reasoning || "").toLowerCase();
  const hasMeanReversionFrame =
    sl.includes("dip") ||
    sl.includes("bounce") ||
    sl.includes("mean reversion") ||
    sl.includes("mean-reversion") ||
    sl.includes("oversold") ||
    sl.includes("counter-trend");

  if (hasMeanReversionFrame) {
    adjustedScore -= 0.2;
    reasons.push("mean_reversion_framing");
  }

  // ===== CONTINUATION STRUCTURE =====
  let continuationQuality = 0.5;
  const hasContinuationStructure =
    sl.includes("continuation") ||
    sl.includes("pullback to support") ||
    sl.includes("bull flag") ||
    sl.includes("higher high") ||
    sl.includes("breakout");
  if (hasContinuationStructure) continuationQuality = 0.85;
  diagnostics.continuationQuality = continuationQuality;

  // ===== TOTAL ADJUSTMENT CAP =====
  // Prevent runaway penalty stacking: no signal should lose more than 1.2 from quality
  // evaluation alone. Tightened from 0.65 to allow stronger flat/below-VWAP filtering
  // while still respecting the AI's own rubric for high-conviction setups.
  const minAllowedByPenaltyCap = rawScore - 1.2;
  if (adjustedScore < minAllowedByPenaltyCap) {
    adjustedScore = minAllowedByPenaltyCap;
    reasons.push("penalty_cap_applied");
  }

  // ===== FINAL CLAMP =====
  adjustedScore = Math.max(0, Math.min(10, adjustedScore));
  diagnostics.longPenaltyReasons = reasons;

  // ===== SHORT-PREFERRED REDIRECT CHECK =====
  // Signals that arrive with side="LONG" can still pivot to SHORT here when:
  //   1. Trend is DOWN and the AI gave shortScore a decent floor (>= 6.0), OR
  //   2. The LONG setup collapsed below qualify threshold AND the short side is competitive
  // Bearish structure evidence broadened to catch flat+below-VWAP cases that lack
  // keyword signals (common intraday when AI summary is terse).
  const downTrendPrefersShort = context.trend === "DOWN" && rawShortScore >= 6.0;
  const hasBearishStructureEvidence =
    sl.includes("lower high") ||
    sl.includes("rejection") ||
    sl.includes("breakdown") ||
    sl.includes("reversal") ||
    sl.includes("bearish") ||
    sl.includes("downside") ||
    context.trend === "DOWN" ||
    (context.trend === "FLAT" && priceVsVwap !== null && priceVsVwap < -0.3); // flat + below VWAP
  const weakLongPrefersShort =
    adjustedScore < minQualifyScore &&
    rawShortScore >= 6.0 &&          // floor: AI still needs a real short score
    hasBearishStructureEvidence &&
    rawShortScore >= rawScore - 1.5; // short must be within 1.5 pts of long raw
  const shortPreferred = downTrendPrefersShort || weakLongPrefersShort;

  return { adjustedScore, diagnostics, penaltyReasons: reasons, shortPreferred };
}

/**
 * Evaluate SHORT-specific quality factors and determine penalties/adjustments
 * Returns: { adjustedScore, diagnostics, penaltyReasons }
 */
function evaluateShortQuality(params: {
  rawScore: number;
  summary: string;
  context: SignalContext | null;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  reasoning?: string;
}): {
  adjustedScore: number;
  diagnostics: ShortQualityDiagnostics;
  penaltyReasons: string[];
} {
  const { rawScore, summary, context, entryPrice, stopPrice, targetPrice, reasoning } = params;
  let adjustedScore = rawScore;
  const reasons: string[] = [];
  const diagnostics: ShortQualityDiagnostics = {};

  // No context = no adjustments possible
  if (!context) {
    return { adjustedScore, diagnostics, penaltyReasons: reasons };
  }

  // ===== TREND QUALITY ASSESSMENT =====
  const trendQuality = context.trend === "DOWN" ? 0.9 : context.trend === "FLAT" ? 0.3 : 0.1;
  diagnostics.shortTrendQuality = trendQuality;

  // Pre-compute bearish structure: used by trend penalty and structure section below
  const combinedTextForStructure =
    (summary || "").toLowerCase() + " " + (reasoning || "").toLowerCase();
  const hasBearishStructure =
    combinedTextForStructure.includes("lower high") ||
    combinedTextForStructure.includes("rejection") ||
    combinedTextForStructure.includes("breakdown") ||
    combinedTextForStructure.includes("failed") ||
    combinedTextForStructure.includes("reversal");

  if (context.trend === "FLAT") {
    // Bearish structure partially redeems flat-trend shorts; reduce penalty when present
    const flatShortPenalty = hasBearishStructure ? -0.6 : -1.0;
    adjustedScore += flatShortPenalty;
    reasons.push("flat_trend_short");
  } else if (context.trend !== "DOWN") {
    // Uptrend SHORT: very harsh penalty
    adjustedScore -= 0.8;
    reasons.push("uptrend_short_contradiction");
  }

  // ===== VWAP ALIGNMENT ASSESSMENT =====
  let vwapQuality = 0.5; // neutral default
  const priceVsVwap =
    context.vwap && context.vwap > 0
      ? ((entryPrice - context.vwap) / context.vwap) * 100
      : null;

  if (priceVsVwap !== null) {
    if (priceVsVwap < -1.0) {
      // Well below VWAP: good SHORT setup
      vwapQuality = 0.85;
      diagnostics.vwapAlignmentQuality = vwapQuality;
    } else if (priceVsVwap < 0) {
      // Slightly below VWAP: decent
      vwapQuality = 0.65;
      diagnostics.vwapAlignmentQuality = vwapQuality;
    } else if (priceVsVwap < 0.5) {
      // Near VWAP: valid SHORT entry when trend is DOWN (VWAP rejection setup);
      // otherwise mediocre since entry lacks clear rejection from above.
      if (context.trend === "DOWN") {
        vwapQuality = 0.6; // Acceptable: shorting VWAP rejection in downtrend
        diagnostics.vwapAlignmentQuality = vwapQuality;
        // No penalty: DOWN trend + near VWAP = classic rejection short
      } else {
        vwapQuality = 0.4;
        diagnostics.vwapAlignmentQuality = vwapQuality;
        adjustedScore -= 0.4;
        reasons.push("entry_at_or_above_vwap");
      }
    } else {
      // > 0.5% above VWAP: bad for SHORT (chasing extended move above VWAP)
      vwapQuality = 0.1;
      diagnostics.vwapAlignmentQuality = vwapQuality;
      adjustedScore -= 1.5;
      reasons.push("entry_above_vwap_short");
    }
  } else {
    diagnostics.vwapAlignmentQuality = 0.5;
  }

  // ===== CONTEXT AGREEMENT CHECK =====
  // See if scan reasoning mentions VWAP but context contradicts
  const reasoningLower = (reasoning || "").toLowerCase();
  const summaryLower = (summary || "").toLowerCase();
  const mentionsBelow = reasoningLower.includes("below") || summaryLower.includes("below vwap");
  const actuallyAbove = priceVsVwap !== null && priceVsVwap > 0.2;

  if (mentionsBelow && actuallyAbove) {
    // Contradiction: scan says below, actual context shows above
    diagnostics.contextAgreement = false;
    adjustedScore -= 1.2;
    reasons.push("vwap_context_contradiction");
  } else {
    diagnostics.contextAgreement = true;
  }

  // ===== TREND SLOPE ASSESSMENT =====
  // Slope check removed from penalty path: AI score already reflects trend strength; the
  // -0.15 mechanical knock-on was consistently pushing borderline DOWN-trend shorts below
  // the 7.0 qualification floor. Log slope for diagnostics only.
  const trendSlopeAbs = Math.abs(context.trendSlopePct || 0);
  void trendSlopeAbs; // retained for potential future use

  // ===== PARTICIPATION / VOLUME ASSESSMENT =====
  let participationQuality = 0.6; // default neutral
  if (context.relVolume !== null && context.relVolume !== undefined) {
    if (context.relVolume >= 1.3) {
      participationQuality = 0.9;
    } else if (context.relVolume >= 1.0) {
      participationQuality = 0.7;
    } else if (context.relVolume >= 0.7) {
      participationQuality = 0.5;
    } else {
      // Light volume on SHORT: meaningful penalty but not disqualifying alone
      participationQuality = 0.3;
      adjustedScore -= 0.25;
      reasons.push("light_volume_participation");
    }
  }
  diagnostics.participationQuality = participationQuality;

  // ===== RELATIVE WEAKNESS ASSESSMENT =====
  // This is a softer check; context may not always have this data
  let relativeWeaknessQuality = 0.5; // neutral default
  // Note: Full relative strength analysis would need SPY/QQQ last bar data from context
  // For now, we mark it as neutral but provide the hook for future enhancement
  diagnostics.relativeWeaknessQuality = relativeWeaknessQuality;

  // ===== BEARISH STRUCTURE ASSESSMENT =====
  let bearishStructureQuality = 0.6; // default, improved by AI summary quality
  // Re-use pre-computed hasBearishStructure from above (trend penalty section)
  const summaryLowerCase = (summary || "").toLowerCase();
  const hasStructure = hasBearishStructure;

  if (hasStructure) {
    bearishStructureQuality = 0.8;
  } else if (summaryLowerCase.includes("reasonable") || summaryLowerCase.includes("moderate")) {
    bearishStructureQuality = 0.4;
    adjustedScore -= 0.3;
    reasons.push("weak_bearish_conviction");
  }
  diagnostics.bearishStructureQuality = bearishStructureQuality;

  // ===== FINAL CLAMP =====
  // Ensure score stays within 0-10 range
  adjustedScore = Math.max(0, Math.min(10, adjustedScore));

  return {
    adjustedScore,
    diagnostics,
    penaltyReasons: reasons,
  };
}

/**
 * Check if circuit breaker is open (too many recent errors)
 */
async function isCircuitBreakerOpen(): Promise<boolean> {
  if (!AI_SCORING_BREAKER_ENABLED || !redis) return false;
  try {
    const breakerState = await redis.get(BREAKER_KEY);
    return breakerState === "open";
  } catch (err) {
    console.warn("[aiScoring] breaker check failed", err);
    return false;
  }
}

/**
 * Record an error and potentially open the circuit breaker
 */
async function recordBreakerError(errorType: "rate_limit" | "timeout" | "other"): Promise<void> {
  if (!AI_SCORING_BREAKER_ENABLED || !redis) return;
  try {
    const errorKey = `ai:breaker:errors:v1`;
    const now = Date.now();
    const windowStart = now - BREAKER_WINDOW_SEC * 1000;
    
    // Add error with score = timestamp
    await redis.zadd(errorKey, { score: now, member: `${errorType}:${now}` });
    
    // Remove old errors outside window
    await redis.zremrangebyscore(errorKey, "-inf", windowStart);
    
    // Set TTL on error tracking key
    await redis.expire(errorKey, BREAKER_WINDOW_SEC + 60);
    
    // Count errors in window
    const errorCount = await redis.zcard(errorKey);
    
    // Open breaker if threshold exceeded
    if (errorCount >= BREAKER_ERROR_THRESHOLD) {
      await redis.set(BREAKER_KEY, "open", { ex: BREAKER_OPEN_TTL_SEC });
      console.warn(`[aiScoring] Circuit breaker OPENED (${errorCount} errors in ${BREAKER_WINDOW_SEC}s)`);
      await bumpTodayFunnel({ aiBreakerOpened: 1 }).catch(console.warn);
    }
  } catch (err) {
    console.warn("[aiScoring] breaker error recording failed", err);
  }
}

/**
 * Sleep for exponential backoff with jitter
 */
function sleepWithJitter(baseMs: number): Promise<void> {
  const jitter = Math.random() * 0.3; // 0-30% jitter
  const actualMs = baseMs * (1 + jitter);
  return new Promise(resolve => setTimeout(resolve, actualMs));
}

/**
 * Build structured quality tags from scoring factors.
 * Produces: setupQualityTags (positive), rejectionTags (negative), performanceBucket (primary bucket key).
 */
function buildSetupQualityTags(params: {
  direction: "LONG" | "SHORT" | "NONE";
  penaltyReasons: string[];
  trendBucket: "strong_up" | "weak_up" | "flat" | "weak_down" | "strong_down";
  vwapBucket: "well_above" | "above" | "near" | "below" | "well_below";
  relVolBucket: "strong" | "normal" | "mediocre" | "light";
  setupFrame: "continuation" | "mean_reversion" | "dip_buy" | "breakout" | "reversal" | "unknown";
  tier: string;
  score: number;
}): { setupQualityTags: string[]; rejectionTags: string[]; performanceBucket: string } {
  const { direction, penaltyReasons, trendBucket, vwapBucket, relVolBucket, setupFrame, tier, score } = params;
  const setupQualityTags: string[] = [];
  const rejectionTags: string[] = [];

  // Positive tags
  if (trendBucket === "strong_up" && direction === "LONG") setupQualityTags.push("strong_uptrend_long");
  if (trendBucket === "strong_down" && direction === "SHORT") setupQualityTags.push("strong_downtrend_short");
  if ((vwapBucket === "above" || vwapBucket === "well_above") && direction === "LONG") setupQualityTags.push("strong_vwap_reclaim");
  if ((vwapBucket === "below" || vwapBucket === "well_below") && direction === "SHORT") setupQualityTags.push("vwap_aligned_short");
  if (relVolBucket === "strong") setupQualityTags.push("high_relative_volume");
  if (setupFrame === "continuation") setupQualityTags.push("clean_continuation");
  if (setupFrame === "breakout") setupQualityTags.push("clean_breakout");
  if (score >= 8.5) setupQualityTags.push("high_liquidity_trend");

  // Rejection / penalty tags derived from penalty reasons
  const penaltySet = new Set(penaltyReasons);
  if (penaltySet.has("flat_trend_long")) rejectionTags.push("flat_trend_long");
  if (penaltySet.has("downtrend_long_contradiction")) rejectionTags.push("downtrend_long");
  if (
    penaltySet.has("entry_below_vwap_no_reclaim") ||
    penaltySet.has("below_vwap_non_uptrend_long") ||
    penaltySet.has("shallow_pullback_below_vwap")
  ) rejectionTags.push("below_vwap_long");
  if (
    penaltySet.has("light_volume_participation") ||
    penaltySet.has("mediocre_volume_participation") ||
    penaltySet.has("sub1_volume_no_trend_vwap_offset")
  ) rejectionTags.push("weak_volume");
  if (penaltySet.has("entry_above_vwap_short")) rejectionTags.push("poor_short_vwap");
  if (penaltySet.has("flat_trend_short")) rejectionTags.push("flat_trend_short");
  if (penaltySet.has("uptrend_short_contradiction")) rejectionTags.push("uptrend_short");
  if (penaltySet.has("weak_bearish_conviction")) rejectionTags.push("poor_short_structure");
  if (tier === "C" && (penaltySet.has("flat_trend_long") || penaltySet.has("below_vwap_non_uptrend_long") || penaltySet.has("light_volume_participation"))) {
    rejectionTags.push("low_quality_c_tier");
  }
  if (setupFrame === "mean_reversion" || setupFrame === "dip_buy") rejectionTags.push("counter_trend_setup");

  // Performance bucket: primary classification for analytics grouping
  let performanceBucket = `${tier.toLowerCase()}_${direction.toLowerCase()}`;
  if (rejectionTags.includes("flat_trend_long")) performanceBucket = "c_flat_trend_long";
  else if (rejectionTags.includes("below_vwap_long")) performanceBucket = `${tier.toLowerCase()}_below_vwap_long`;
  else if (rejectionTags.includes("counter_trend_setup")) performanceBucket = `${tier.toLowerCase()}_counter_trend`;
  else if (setupQualityTags.includes("clean_breakout") || setupQualityTags.includes("clean_continuation")) {
    performanceBucket = `${tier.toLowerCase()}_clean_${direction.toLowerCase()}`;
  }

  return { setupQualityTags, rejectionTags, performanceBucket };
}

export async function scoreSignalWithAI(rawSignal: RawSignal): Promise<AiScoreResult> {
  // Check circuit breaker first
  if (await isCircuitBreakerOpen()) {
    console.log("[aiScoring] Circuit breaker open, skipping scoring");
    return {
      ok: false,
      error: "breaker_open",
      reason: "AI scoring skipped because the circuit breaker is open",
      aiModel: "breaker_open",
      aiRequestId: null,
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Explicit operational error: do not masquerade as a valid low score.
    console.warn("[aiScoring] OPENAI_API_KEY not set; scoring disabled.");
    return {
      ok: false,
      error: "scoring_disabled",
      reason: "OPENAI_API_KEY missing",
      aiModel: "disabled",
      aiRequestId: null,
    };
  }

  const systemPrompt = `
You are a seasoned intraday equities trader with deep experience in both long and short setups.
You evaluate each trading setup from BOTH directions independently.

Rules:
- Score from 0 to 10 (decimals allowed) where:
  - 9-10 = elite, A-level, high-conviction setups with excellent structure and confirmation.
  - 7-8.9 = good but not elite. Solid but with some minor gaps.
  - 5-6.9 = marginal/weak. Possible but requires strong edge elsewhere.
  - 0-4.9 = avoid. Low conviction or contradictory signals.
- Evaluate BOTH:
  1. LONG hypothesis (buy, profit on upside)
  2. SHORT hypothesis (sell/short, profit on downside)
- For each direction, assess:
  - Trend quality and alignment
  - Entry quality relative to VWAP and recent price action
  - Risk/reward setup
  - Liquidity and volume support

** ENHANCED SHORT SCORING RUBRIC **
SHORT setups must meet HIGHER standards than LONG setups to score well. Apply these gates:

1. BEARISH TREND QUALITY (Required for scores >=7.0):
   - Trend MUST be explicitly DOWN, not FLAT. FLAT-trend shorts should score <=6.5.
   - Trend slope should show clear weakness (not just -0.001% per bar).
   - Confirmed by recent lower highs pattern (last 3-5 bars).
   - If trend is FLAT and relying on pullback, penalty of -1.0 from base score.

2. VWAP / ENTRY ALIGNMENT (Critical for quality):
   - Clean below-VWAP trading: reward, score boost +0.3 for high-confidence structure.
   - Clear rejection from above VWAP: reward, score boost +0.2 if well-defined candle.
   - Above-VWAP shorts: harsh penalty (-1.5). Require exceptional R:R or ultra-clear structure to overcome.
   - Ambiguous or contradictory VWAP context: penalty -0.8 to -1.2 depending on severity.
   - Check for mismatch between scan reasoning ("below VWAP") and actual context (price above VWAP): harsh penalty -1.2.

3. MARKET-RELATIVE WEAKNESS (For best SHORT scores):
   - Compare ticker weakness to SPY / QQQ / broad market proxy from context.
   - Mega-cap shorts (TSLA, NVDA, SPY, QQQ) MUST show meaningful relative weakness vs their sector/market.
   - Shorts without significant relative weakness: penalty -0.6 to -0.8.
   - Strong relative weakness (ticker down 2-3%+ while market flat): boost +0.3.

4. BEARISH STRUCTURE & CONFIRMATION (Required):
   - Lower highs, failed pops, rejection candles: reward.
   - Distribution or volume on downs: reward +0.2.
   - Light volume on bearish move: penalty -0.5.
   - No clear SHORT structure (just mean-reversion): score <=6.8 unless other factors exceptional.

5. QUALITY OF R:R (For scoring differentiation):
   - If R:R is poor for SHORT (tight target, wide stop): penalty -0.5.
   - If R:R is excellent (2:1+): boost +0.2 for short.
   - Stops too wide for size (>2% risk): discourage for intraday.

6. LIQUIDITY / PARTICIPATION:
   - Good volume participation on SHORT move: standard scoring.
   - Light/weak volume on SHORT move: penalty -0.4.
   - Hard gates (dollar volume) are separate; this is softer soft-gate.

** AVOID INFLATING MEDIOCRE SHORTS **
- Shorts with "reasonable" or "moderate" thesis (not "strong" or "clear"): max 6.8-7.0.
- Shorts with weak participation: max 7.0.
- Shorts with flat trend: max 6.5-6.8.
- Shorts without strong extension from recent range: max 6.8.

** LONG SCORING STANDARDS — TIGHTEN AGAINST WEAK SETUPS **
Strong LONG requires: UP trend + entry at or above VWAP + relVolume >= 1.0 + continuation or breakout structure.
Apply these gates when scoring LONGs:
- FLAT trend LONG: max score 7.0 unless the breakout structure is very clean and volume confirms. Most flat-trend longs should score 6.0-6.8.
- DOWN trend LONG (buying against the trend): max 6.5. Very unusual to score higher.
- LONG entry well below VWAP without clear reclaim thesis: max 6.8.
- Mean-reversion / dip-buy / bounce framing (oversold, "holding support", counter-trend): max 7.0. Require volume confirmation and uptrend for higher.
- relVolume < 0.9 (mediocre participation): cap at 7.2. relVolume < 0.7 (light): cap at 6.8.
- C-tier attempt (6.5-7.5) with flat trend AND relVolume < 1.0: absolute maximum 6.9.
These are firm floors/caps: override only if the structure is clearly exceptional.

- Return ONLY a compact JSON object with fields:
  {"longScore": number, "shortScore": number, "longSummary": string, "shortSummary": string, "chosenDirection": "LONG"|"SHORT"|"NONE", "confidence": number}.
  No extra text.
`.trim();

  // --- Context enrichment (A1) --------------------------------------------
  const timeframe = rawSignal.timeframe || "1Min";

  let context: SignalContext | null = null;
  try {
        context = await buildSignalContext({
      ticker: rawSignal.ticker,
      timeframe,
      limit: 90,
      endTimeIso: rawSignal.createdAt,
    });

    if (context && context.barsUsed < MIN_BARS_FOR_AI) {
      try {
        const retry = await buildSignalContext({
          ticker: rawSignal.ticker,
          timeframe,
          limit: 90,
        });
        if (retry && retry.barsUsed > (context?.barsUsed ?? 0)) {
          context = retry;
        }
      } catch (e: any) {
        console.log("[aiScoring] context retry failed (non-fatal):", e?.message ?? String(e));
      }
    }

  } catch (e: any) {
    console.log("[aiScoring] context build failed (non-fatal):", e?.message ?? String(e));
  }

  const signal = context
    ? {
        ...rawSignal,
        signalContext: context,
      }
    : rawSignal;

  if (context && context.barsUsed < MIN_BARS_FOR_AI) {
    const reason = `Insufficient recent bars (${context.barsUsed} < ${MIN_BARS_FOR_AI})`;
    await bumpTodayFunnel({ skipInsufficientBars: 1 }).catch(console.warn);
    return {
      ok: false,
      error: "insufficient_bars",
      reason: reason,
      aiModel: "skipped",
      aiRequestId: null,
    };
  }

  // Hard reject: liquidity (avg dollar volume)
  if (context && context.avgVolume && rawSignal.entryPrice) {
    const avgDollarVol = context.avgVolume * rawSignal.entryPrice;
    if (avgDollarVol < MIN_AVG_DOLLAR_VOL_HARD) {
      const reason = `Liquidity below threshold (avg dollar vol: $${Math.round(avgDollarVol).toLocaleString()} < $${MIN_AVG_DOLLAR_VOL_HARD.toLocaleString()})`;
      await bumpTodayFunnel({ errorLiquidityDollarVol: 1 }).catch(console.warn);
      return {
        ok: false,
        error: "insufficient_bars",
        reason: reason,
        aiModel: "skipped",
        aiRequestId: null,
      };
    }
  }

  const contextBlock =
    signal.signalContext
      ? JSON.stringify(signal.signalContext, null, 2)
      : "null";

  // Detect SHORT bias emphasis
  const shortBiasDetected = signal.signalContext?.shortBias === true;
  const directionGuidance = shortBiasDetected
    ? "\n⚠️ SHORT BIAS DETECTED: Market context shows bearish structure (below VWAP, lower highs, distribution). Evaluate SHORT hypothesis with extra scrutiny."
    : "";

  const prompt = `
You are evaluating an intraday trading candidate from BOTH directions.

Candidate JSON:
${JSON.stringify(signal, null, 2)}

ComputedContext JSON (from Alpaca bars):
${contextBlock}${directionGuidance}

Evaluate BOTH:
1. LONG hypothesis: Buy at entry, profit on upside to target
2. SHORT hypothesis: Sell/short at entry, profit on downside to stop of LONG (inverted bracket)

For each direction, score 0-10 based on:
- Trend alignment
- Entry quality (VWAP, pullback/rejection quality)
- Risk/reward
- Volume/liquidity support

Evaluate LONG and SHORT independently. Do not prefer either direction by default.
${shortBiasDetected ? "Given the SHORT bias context, ensure SHORT setup gets thorough analysis." : ""}
Set chosenDirection to the side you believe is stronger, or NONE if both are weak.
Set confidence from 0 to 1.

Return ONLY valid JSON:
{ "longScore": number, "shortScore": number, "longSummary": string, "shortSummary": string, "chosenDirection": "LONG"|"SHORT"|"NONE", "confidence": number }
`.trim();

  const BULK_MODEL = process.env.OPENAI_MODEL_BULK || "gpt-5-mini";
  const HEAVY_MODEL = process.env.OPENAI_MODEL_HEAVY || "gpt-5.1";
  const useHeavyModel = (signal.playbookScore ?? 0) >= 8;
  const model = useHeavyModel ? HEAVY_MODEL : BULK_MODEL;
  const { retryOnParseFail, maxParseRetry } = getParseRetryConfig();

  const openai = new OpenAI({ apiKey });
  const scoreOnce = async (promptText: string, retryAttempt: number = 0) => {
    await recordAiCall(model);
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model,
        ...(supportsCustomTemperature(model) ? { temperature: 0 } : {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "ai_score_bidirectional",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                longScore: { type: "number" },
                shortScore: { type: "number" },
                longSummary: { type: "string" },
                shortSummary: { type: "string" },
                chosenDirection: { type: "string", enum: ["LONG", "SHORT", "NONE"] },
                confidence: { type: "number" },
              },
              required: ["longScore", "shortScore", "longSummary", "shortSummary", "chosenDirection", "confidence"],
            },
          },
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: promptText },
        ],
      });
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      const errStatus = err?.status ?? err?.response?.status;
      const isRateLimit = errStatus === 429 || errMsg.includes("429") || errMsg.includes("rate_limit");
      const isTimeout = errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT") || errStatus === 503;
      
      await recordAiError(model, errMsg);
      
      // Record error for circuit breaker
      if (isRateLimit) {
        await recordBreakerError("rate_limit");
        await bumpTodayFunnel({ aiRateLimitErrors: 1 }).catch(console.warn);
      } else if (isTimeout) {
        await recordBreakerError("timeout");
        await bumpTodayFunnel({ aiTimeoutErrors: 1 }).catch(console.warn);
      } else {
        await recordBreakerError("other");
      }
      
      // Retry with exponential backoff for rate limits and timeouts
      if ((isRateLimit || isTimeout) && retryAttempt < AI_SCORING_RETRY_MAX) {
        const backoffMs = Math.pow(2, retryAttempt) * 1000; // 1s, 2s, 4s, 8s
        console.log(`[aiScoring] Retry ${retryAttempt + 1}/${AI_SCORING_RETRY_MAX} after ${backoffMs}ms (${isRateLimit ? 'rate limit' : 'timeout'})`);
        await sleepWithJitter(backoffMs);
        return scoreOnce(promptText, retryAttempt + 1);
      }
      
      throw err;
    }

    try {
      await recordSpend(model, estimateCost(model));
    } catch (e: any) {
      console.log("[aiScoring] recordSpend failed (non-fatal):", e?.message ?? String(e));
    }
    await bumpTodayFunnel({ gptScoredByModel: { [model]: 1 } });
    const requestId =
      (completion as any)?.request_id ??
      (completion as any)?.id ??
      (completion as any)?.response?.headers?.get?.("x-request-id") ??
      null;
    return { content: completion.choices[0]?.message?.content ?? "", requestId };
  };

  const retryPrompt =
    prompt +
    "\n\nIMPORTANT: Respond ONLY with a single JSON object: {\"longScore\":number,\"shortScore\":number,\"longSummary\":string,\"shortSummary\":string,\"chosenDirection\":\"LONG\"|\"SHORT\"|\"NONE\",\"confidence\":number}";

  let scoreResponse = await scoreOnce(prompt);
  let parsed = parseAiScoreOutput(scoreResponse.content);
  let parseAttempts = 0;

  while (!parsed.ok && retryOnParseFail && parseAttempts < maxParseRetry) {
    parseAttempts += 1;
    scoreResponse = await scoreOnce(retryPrompt);
    parsed = parseAiScoreOutput(scoreResponse.content);
  }

  if (!parsed.ok) {
    return {
      ok: false,
      error: "ai_parse_failed",
      reason: parsed.reason,
      rawHead: parsed.rawHead,
      aiModel: model,
      aiRequestId: scoreResponse.requestId,
      aiParseError: parsed.reason,
    };
  }

  const parsedScore = parsed.parsed;
  // Extract bidirectional fields from parsed response
  const rawObj = (parsedScore as any).rawJson || {};
  const longScore = normalizeDirectionalScore(rawObj.longScore ?? parsedScore.longScore ?? parsedScore.score);
  const shortScore = normalizeDirectionalScore(rawObj.shortScore ?? parsedScore.shortScore ?? parsedScore.score);
  const longSummary = String(rawObj.longSummary ?? "").trim();
  const shortSummary = String(rawObj.shortSummary ?? "").trim();
  const chosenDirectionRaw = String(rawObj.chosenDirection ?? "NONE").toUpperCase();
  const chosenDirection =
    chosenDirectionRaw === "LONG" || chosenDirectionRaw === "SHORT" || chosenDirectionRaw === "NONE"
      ? chosenDirectionRaw
      : "NONE";
  const confidence = typeof rawObj.confidence === "number" ? rawObj.confidence : Number(rawObj.confidence);
  
  const validationError = validateStructuredOutput({
    longScore,
    shortScore,
    longSummary,
    shortSummary,
    chosenDirection,
    confidence,
  });
  if (validationError) {
    return {
      ok: false,
      error: "invalid_model_output",
      reason: validationError,
      rawHead: (scoreResponse.content || "").slice(0, 800),
      aiModel: model,
      aiRequestId: scoreResponse.requestId,
      aiParseError: validationError,
    };
  }

  const edge = Math.abs(longScore - shortScore);
  const MIN_QUALIFY_SCORE = minScoreToQualify(); // Get the qualification threshold
  
  let bestDirection: "LONG" | "SHORT" | "NONE" = "NONE";
  let winnerScore = 0;
  let _summary = "";
  let isQualified = false;
  
  // Check if signal has explicit side (LONG or SHORT)
  const hasExplicitSide = signal.side === "LONG" || signal.side === "SHORT";
  
  if (hasExplicitSide) {
    // Mode 1: Explicit directional signal - force direction to match side
    bestDirection = signal.side as "LONG" | "SHORT";
    winnerScore = bestDirection === "LONG" ? longScore : shortScore;
    
    // Qualify based on score threshold only (not edge gate)
    isQualified = winnerScore >= MIN_QUALIFY_SCORE;
    
    // Build diagnostic summary showing both scores
    const oppositeScore = bestDirection === "LONG" ? shortScore : longScore;
    const oppositeDir = bestDirection === "LONG" ? "SHORT" : "LONG";
    
    if (isQualified) {
      // Use the directional summary from AI
      const baseSummary = bestDirection === "LONG" ? longSummary : shortSummary;
      _summary = `${baseSummary} [Diagnostic: ${bestDirection} ${winnerScore.toFixed(2)} vs ${oppositeDir} ${oppositeScore.toFixed(2)}, edge ${edge.toFixed(2)}]`;
    } else {
      // Failed qualification
      _summary = `${bestDirection} signal: score ${winnerScore.toFixed(2)} < min ${MIN_QUALIFY_SCORE.toFixed(2)}. [Diagnostic: ${oppositeDir} ${oppositeScore.toFixed(2)}, edge ${edge.toFixed(2)}]`;
    }
  } else {
    // Mode 2: Neutral signal - use directional edge competition gate
    if (longScore >= MIN_LONG_SCORE && longScore > shortScore && edge >= MIN_EDGE) {
      bestDirection = "LONG";
    } else if (shortScore >= MIN_SHORT_SCORE && shortScore > longScore && edge >= MIN_EDGE) {
      bestDirection = "SHORT";
    }
    
    winnerScore = bestDirection === "LONG" ? longScore :
                  bestDirection === "SHORT" ? shortScore :
                  0;
    
    isQualified = bestDirection !== "NONE";
    
    if (bestDirection === "LONG") {
      _summary = longSummary;
    } else if (bestDirection === "SHORT") {
      _summary = shortSummary;
    } else {
      // Failed edge gate - show detailed diagnostic
      const maxScore = Math.max(longScore, shortScore);
      const failReasons = [];
      if (longScore < MIN_LONG_SCORE && shortScore < MIN_SHORT_SCORE) {
        failReasons.push(`both scores below threshold (LONG ${longScore.toFixed(2)} < ${MIN_LONG_SCORE.toFixed(2)}, SHORT ${shortScore.toFixed(2)} < ${MIN_SHORT_SCORE.toFixed(2)})`);
      } else if (edge < MIN_EDGE) {
        failReasons.push(`edge ${edge.toFixed(2)} < min ${MIN_EDGE.toFixed(2)}`);
      }
      _summary = `No qualified directional edge. LONG ${longScore.toFixed(2)} vs SHORT ${shortScore.toFixed(2)}, edge ${edge.toFixed(2)}. Failed: ${failReasons.join(", ")}.`;
    }
  }
  
  // ===== APPLY LONG-SPECIFIC QUALITY PENALTIES =====
  let longDiagnostics: LongQualityDiagnostics | undefined;
  let shortPreferredByQuality = false;
  if (bestDirection === "LONG") {
    const longQualityResult = evaluateLongQuality({
      rawScore: winnerScore,
      rawShortScore: shortScore,
      summary: _summary,
      context: signal.signalContext || null,
      entryPrice: signal.entryPrice,
      stopPrice: signal.stopPrice,
      targetPrice: signal.targetPrice,
      reasoning: signal.reasoning,
      minQualifyScore: MIN_QUALIFY_SCORE,
    });

    winnerScore = longQualityResult.adjustedScore;
    longDiagnostics = longQualityResult.diagnostics;
    shortPreferredByQuality = longQualityResult.shortPreferred;

    if (longQualityResult.penaltyReasons.length > 0) {
      const penaltyNote = `(long-quality penalties: ${longQualityResult.penaltyReasons.join(", ")})`;
      _summary = `${_summary} ${penaltyNote}`;
    }

    // ===== SHORT PROMOTION =====
    // If LONG fell below threshold but SHORT is competitive, promote SHORT
    if (shortPreferredByQuality) {
      bestDirection = "SHORT";
      winnerScore = shortScore;
      _summary = `${shortSummary} [Promoted from LONG: long-quality made SHORT preferable]`;
    } else {
      // Always re-check qualification after LONG quality penalties.
      // BUG FIX: Mode 2 (neutral) signals previously kept isQualified=true even after
      // quality penalties dropped winnerScore below threshold.
      isQualified = winnerScore >= MIN_QUALIFY_SCORE;
    }
  }

  // ===== APPLY SHORT-SPECIFIC QUALITY PENALTIES =====
  let shortDiagnostics: ShortQualityDiagnostics | undefined;
  if (bestDirection === "SHORT") {
    const shortQualityResult = evaluateShortQuality({
      rawScore: winnerScore,
      summary: _summary,
      context: signal.signalContext || null,
      entryPrice: signal.entryPrice,
      stopPrice: signal.stopPrice,
      targetPrice: signal.targetPrice,
      reasoning: signal.reasoning,
    });
    
    winnerScore = shortQualityResult.adjustedScore;
    // Keep valid scored SHORT outcomes above zero after penalty-only adjustments.
    winnerScore = Math.max(1.0, winnerScore);
    shortDiagnostics = shortQualityResult.diagnostics;
    shortDiagnostics.shortPenaltyReasons = shortQualityResult.penaltyReasons;
    
    // Update summary to include penalty info if penalties were applied
    if (shortQualityResult.penaltyReasons.length > 0) {
      const penaltyNote = `(penalties: ${shortQualityResult.penaltyReasons.join(", ")})`;
      _summary = `${_summary} ${penaltyNote}`;
    }
    
    // Recalculate qualification after applying SHORT penalties
    if (hasExplicitSide || shortPreferredByQuality) {
      isQualified = winnerScore >= MIN_QUALIFY_SCORE;
    }
    // For neutral signals, bestDirection evaluation already handles qualification via MIN_SHORT_SCORE gate
  }

  // ===== APPLY MARKET POSTURE BIAS =====
  let postureBias = 0;
  let postureBiasApplied = false;
  if (bestDirection !== "NONE") {
    postureBias = getMarketPostureBias(bestDirection, winnerScore);
    if (postureBias !== 0) {
      winnerScore = Math.max(0, Math.min(10, winnerScore + postureBias));
      postureBiasApplied = true;
      if (hasExplicitSide) {
        isQualified = winnerScore >= MIN_QUALIFY_SCORE;
      }
    }
  }

  // ===== COMPUTE EXPLAINABILITY FIELDS =====
  const ctx = signal.signalContext || null;
  const vwapBucket = classifyVwapBucket(signal.entryPrice, ctx?.vwap);
  const trendBucket = classifyTrendBucket(ctx?.trend);
  const relVolBucket = classifyRelVolBucket(ctx?.relVolume);
  const liquidityBucket = classifyLiquidityBucket(ctx?.avgVolume, signal.entryPrice);
  const setupFrame = classifySetupFrame(bestDirection, ctx, _summary);
  const actionabilityRank =
    bestDirection !== "NONE"
      ? computeActionabilityRank(winnerScore, setupFrame, bestDirection, ctx, signal.entryPrice)
      : 1;

  const _grade: AiGrade = gradeFromScore(winnerScore);
  const _direction: "LONG" | "SHORT" | "NONE" = bestDirection;

  // ===== QUALIFY DIAGNOSTIC =====
  // Compact one-line diagnostic explaining final score, direction choice, and qualify outcome.
  // Surfaces in /api/signals/all as qualifyDiagnostic field for live debugging.
  const qualifyBand = winnerScore >= 8.5 ? "A" : winnerScore >= 7.5 ? "B" : winnerScore >= 6.5 ? "C" : "REJECT";
  const directionNote = shortPreferredByQuality
    ? `promoted→SHORT(rawShort:${shortScore.toFixed(2)})`
    : bestDirection === "LONG"
    ? `stayed→LONG(rawShort:${shortScore.toFixed(2)}<floor|noBearishEvidence)`
    : bestDirection === "SHORT"
    ? `edgeWon→SHORT`
    : `NONE`;
  const qualifyNote = isQualified ? "QUALIFIED" : `REJECT(score:${winnerScore.toFixed(2)}<threshold:${MIN_QUALIFY_SCORE.toFixed(2)})`;
  const qualifyDiagnostic = `${qualifyNote}|dir:${directionNote}|finalScore:${winnerScore.toFixed(2)}|rawLong:${longScore.toFixed(2)}|rawShort:${shortScore.toFixed(2)}|band:${qualifyBand}|trend:${ctx?.trend ?? "?"}|relVol:${ctx?.relVolume?.toFixed(2) ?? "?"}`;

  // Log qualify decision for live debugging
  console.log("[aiScoring:qualify]", {
    ticker: signal.ticker,
    direction: _direction,
    finalScore: winnerScore.toFixed(2),
    rawLong: longScore.toFixed(2),
    rawShort: shortScore.toFixed(2),
    qualified: isQualified,
    threshold: MIN_QUALIFY_SCORE,
    band: qualifyBand,
    shortPreferred: shortPreferredByQuality,
    trend: ctx?.trend,
    relVol: ctx?.relVolume,
    longPenalties: longDiagnostics?.longPenaltyReasons ?? [],
    shortPenalties: shortDiagnostics?.shortPenaltyReasons ?? [],
  });

  const result: ScoredSignal = {
    ...signal,
    aiScore: winnerScore,
    aiGrade: _grade,
    aiSummary: _summary,
    totalScore: winnerScore,
    qualified: isQualified,
    // Bidirectional scoring results
    aiDirection: _direction,
    longScore,
    shortScore,
    bestDirection,
    // Quality diagnostics
    shortDiagnostics,
    longDiagnostics,
    // Explainability fields
    actionabilityRank,
    setupFrame,
    vwapBucket,
    trendBucket,
    relVolBucket,
    liquidityBucket,
    // Market posture
    postureBiasApplied,
    postureBias: postureBiasApplied ? postureBias : undefined,
    // Direction competition
    longVsShortEdge: edge,
    shortPreferred: shortPreferredByQuality,
    // Qualify observability
    qualifyDiagnostic,
    // Smoke-test sentinel: confirms Patch 2 scorer path is active
    _scorerVersion: "patch2-v2",
    // Setup quality classification tags (v2 performance upgrade)
    ...buildSetupQualityTags({
      direction: _direction,
      penaltyReasons: [
        ...(longDiagnostics?.longPenaltyReasons ?? []),
        ...(shortDiagnostics?.shortPenaltyReasons ?? []),
      ],
      trendBucket,
      vwapBucket,
      relVolBucket,
      setupFrame,
      tier: qualifyBand,
      score: winnerScore,
    }),
  };

  if (bestDirection === "LONG") {
    await bumpTodayFunnel({ aiDirectionLong: 1 }).catch(console.warn);
  } else if (bestDirection === "SHORT") {
    await bumpTodayFunnel({ aiDirectionShort: 1 }).catch(console.warn);
  } else {
    await bumpTodayFunnel({ aiDirectionNone: 1 }).catch(console.warn);
  }

  // Log with quality diagnostics
  const logData: any = {
    ticker: result.ticker,
    score: winnerScore,
    grade: _grade,
    longScore,
    shortScore,
    chosenDirection,
    confidence,
    bestDirection,
    edge,
    setupFrame,
    actionabilityRank,
    vwapBucket,
    trendBucket,
    relVolBucket,
    postureBiasApplied,
    shortPreferred: shortPreferredByQuality,
  };
  
  if (shortDiagnostics) {
    logData.shortDiagnostics = shortDiagnostics;
  }
  if (longDiagnostics) {
    logData.longDiagnostics = longDiagnostics;
  }
  
  console.log("[aiScoring] Result:", logData);

  try {
    await writeAiHeartbeat();
  } catch (err) {
    console.warn("[aiScoring] heartbeat update failed", err);
  }

  return { ok: true, scored: result, aiModel: model, aiRequestId: scoreResponse.requestId };
}
