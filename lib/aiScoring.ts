import { buildDefaultTradePlan, parseAiTradePlan, type TradePlan } from "@/lib/tradePlan";
import OpenAI from "openai";
import { recordSpend, recordAiCall, recordAiError, writeAiHeartbeat } from "./aiMetrics";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { buildSignalContext, SignalContext } from "@/lib/signalContext";
import { parseAiScoreOutput } from "@/lib/ai/scoreParse";
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
      error: "ai_parse_failed" | "invalid_model_output" | "insufficient_bars";
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

function clampScore(x: any) {
  const n = typeof x === "number" ? x : Number(x)
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
const MIN_LONG_SCORE = Number(process.env.MIN_LONG_SCORE ?? 7.5);
const MIN_SHORT_SCORE = Number(process.env.MIN_SHORT_SCORE ?? 7.5);
const MIN_EDGE = Number(process.env.MIN_EDGE ?? 0.7);
const AI_SCORING_RETRY_MAX = Number(process.env.AI_SCORING_RETRY_MAX ?? 4);
const AI_SCORING_BREAKER_ENABLED = String(process.env.AI_SCORING_BREAKER_ENABLED ?? "1") === "1";

// Circuit breaker constants
const BREAKER_KEY = "ai:breaker:v1";
const BREAKER_ERROR_THRESHOLD = 10; // errors in window
const BREAKER_WINDOW_SEC = 120; // 2 minutes
const BREAKER_OPEN_TTL_SEC = 120; // 2 minutes

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

export async function scoreSignalWithAI(rawSignal: RawSignal): Promise<AiScoreResult> {
  // Check circuit breaker first
  if (await isCircuitBreakerOpen()) {
    console.log("[aiScoring] Circuit breaker open, skipping scoring");
    return {
      ok: true,
      aiModel: "breaker_open",
      aiRequestId: null,
      scored: {
        ...rawSignal,
        aiScore: 0,
        aiGrade: "F",
        aiSummary: "AI scoring skipped (circuit breaker open due to rate limits)",
        totalScore: 0,
        status: "SKIPPED",
        skipReason: "breaker_open",
      },
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fail-safe: if key missing, treat as low-quality
    console.warn("[aiScoring] OPENAI_API_KEY not set; returning default low score.");
    return {
      ok: true,
      aiModel: "disabled",
      aiRequestId: null,
      scored: {
      ...rawSignal,
      aiScore: 0,
      aiGrade: "F",
      aiSummary: "AI scoring disabled (no API key).",
      totalScore: 0,
      },
    };
  }

  const systemPrompt = `
You are a seasoned intraday equities trader.
You evaluate each trading setup from BOTH directions independently.

Rules:
- Score from 0 to 10 (decimals allowed) where:
  - 9-10 = elite, A-level, high-conviction setups.
  - 7-8.9 = good but not elite.
  - 5-6.9 = marginal/meh.
  - 0-4.9 = avoid.
- Evaluate BOTH:
  1. LONG hypothesis (buy, profit on upside)
  2. SHORT hypothesis (sell/short, profit on downside)
- For each direction, assess:
  - Trend quality and alignment
  - Entry quality relative to VWAP and recent price action
  - Risk/reward setup
  - Liquidity and volume support
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
  const retryOnParseFail = process.env.AI_SCORE_RETRY_ON_PARSE_FAIL === "1";

  const openai = new OpenAI({ apiKey });
  const scoreOnce = async (promptText: string, retryAttempt: number = 0) => {
    await recordAiCall(model);
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model,
        ...(supportsCustomTemperature(model) ? { temperature: 0.3 } : {}),
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

  let scoreResponse = await scoreOnce(prompt);
  let parsed = parseAiScoreOutput(scoreResponse.content);
  if (!parsed.ok && retryOnParseFail) {
    const retryPrompt =
      prompt +
      "\n\nIMPORTANT: Respond ONLY with a single JSON object: {\"longScore\":number,\"shortScore\":number,\"longSummary\":string,\"shortSummary\":string,\"chosenDirection\":\"LONG\"|\"SHORT\"|\"NONE\",\"confidence\":number}";
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
  
  const _grade: AiGrade = gradeFromScore(winnerScore);
  const _direction: "LONG" | "SHORT" | "NONE" = bestDirection;

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
  };

  if (bestDirection === "LONG") {
    await bumpTodayFunnel({ aiDirectionLong: 1 }).catch(console.warn);
  } else if (bestDirection === "SHORT") {
    await bumpTodayFunnel({ aiDirectionShort: 1 }).catch(console.warn);
  } else {
    await bumpTodayFunnel({ aiDirectionNone: 1 }).catch(console.warn);
  }

  console.log("[aiScoring] Result:", {
    ticker: result.ticker,
    score: winnerScore,
    grade: _grade,
    longScore,
    shortScore,
    chosenDirection,
    confidence,
    bestDirection,
    edge,
  });

  try {
    await writeAiHeartbeat();
  } catch (err) {
    console.warn("[aiScoring] heartbeat update failed", err);
  }

  return { ok: true, scored: result, aiModel: model, aiRequestId: scoreResponse.requestId };
}
