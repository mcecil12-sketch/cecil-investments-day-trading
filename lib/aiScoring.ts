import { buildDefaultTradePlan, parseAiTradePlan, type TradePlan } from "@/lib/tradePlan";
import OpenAI from "openai";
import { recordSpend, recordAiCall, recordAiError, writeAiHeartbeat } from "./aiMetrics";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { buildSignalContext, SignalContext } from "@/lib/signalContext";
import { parseAiScoreOutput } from "@/lib/ai/scoreParse";
import { redis } from "@/lib/redis";

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
  aiDirection?: Side; // AI's chosen direction (LONG or SHORT)
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

function validateStructuredOutput(parsed: { score: number; grade: string; summary: string; qualified?: boolean; reasons?: string[] }) {
  if (!Number.isFinite(parsed.score) || parsed.score < 0 || parsed.score > 10) {
    return "invalid_score";
  }
  if (!["A", "B", "C", "D", "F"].includes(parsed.grade)) {
    return "invalid_grade";
  }
  if (!parsed.summary || !parsed.summary.trim()) {
    return "missing_summary";
  }
  if (typeof parsed.qualified !== "boolean") {
    return "missing_qualified";
  }
  if (!Array.isArray(parsed.reasons) || parsed.reasons.length === 0) {
    return "missing_reasons";
  }
  return null;
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
You evaluate trading setups from BOTH directions to find the highest-conviction trade.

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
- Direction alignment: if signal has a heuristic direction (LONG/SHORT based on VWAP/trend), strongly prefer setups aligned with it. Penalize significantly for wrong-way setups (e.g., SHORT with upward trend).
- Choose bestDirection: "LONG", "SHORT", or "NONE" (if both weak)
- Return finalScore = max(longScore, shortScore) when bestDirection chosen
- Respond ONLY as a compact JSON object with fields:
  {"longScore": number, "shortScore": number, "bestDirection": "LONG"|"SHORT"|"NONE", "finalScore": number, "aiGrade": "A"|"B"|"C"|"D"|"F", "qualified": boolean, "aiSummary": "short explanation", "reasons": string[]}.
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
    await bumpTodayFunnel({ errorInsufficientBars: 1 }).catch(console.warn);
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

  const prompt = `
You are evaluating an intraday trading candidate from BOTH directions.

Candidate JSON:
${JSON.stringify(signal, null, 2)}

ComputedContext JSON (from Alpaca bars):
${contextBlock}

Evaluate BOTH:
1. LONG hypothesis: Buy at entry, profit on upside to target
2. SHORT hypothesis: Sell/short at entry, profit on downside to stop of LONG (inverted bracket)

For each direction, score 0-10 based on:
- Trend alignment (strongly align the chosen direction with the dominant trend)
- Entry quality (VWAP, pullback/rejection quality)
- Risk/reward
- Volume/liquidity support
- Direction alignment: If the signal has a heuristic direction field, weight heavily toward it. Penalize setups opposite to the heuristic direction (e.g., if direction="LONG" but you score SHORT higher, apply -2 penalty to SHORT).

Choose bestDirection as the higher-conviction setup aligned with trend and heuristic direction. Set finalScore = max(longScore, shortScore).
If both are weak (<5), set bestDirection="NONE" and finalScore=max(longScore,shortScore).

Return ONLY valid JSON:
{ "longScore": number, "shortScore": number, "bestDirection": "LONG"|"SHORT"|"NONE", "finalScore": number, "aiGrade": "A"|"B"|"C"|"D"|"F", "qualified": boolean, "aiSummary": string, "reasons": string[] }
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
                bestDirection: { type: "string", enum: ["LONG", "SHORT", "NONE"] },
                finalScore: { type: "number" },
                aiGrade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
                qualified: { type: "boolean" },
                aiSummary: { type: "string" },
                reasons: { type: "array", items: { type: "string" } },
              },
              required: ["longScore", "shortScore", "bestDirection", "finalScore", "aiGrade", "qualified", "aiSummary", "reasons"],
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
      "\n\nIMPORTANT: Respond ONLY with a single JSON object: {\"longScore\":number,\"shortScore\":number,\"bestDirection\":\"LONG\"|\"SHORT\"|\"NONE\",\"finalScore\":number,\"aiGrade\":\"A|B|C|D|F\",\"qualified\":boolean,\"aiSummary\":string,\"reasons\":string[]}";
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
  const longScore = typeof rawObj.longScore === "number" ? rawObj.longScore : parsedScore.score;
  const shortScore = typeof rawObj.shortScore === "number" ? rawObj.shortScore : parsedScore.score;
  const bestDirection = rawObj.bestDirection || "LONG";
  const finalScore = typeof rawObj.finalScore === "number" ? rawObj.finalScore : parsedScore.score;
  
  const validationError = validateStructuredOutput({
    score: finalScore,
    grade: parsedScore.grade,
    summary: parsedScore.summary,
    qualified: parsedScore.qualified,
    reasons: parsedScore.reasons,
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
  const _scoreNum = finalScore;
  const gradeCandidate = String(parsedScore.grade || "").trim().toUpperCase();
  const _grade: AiGrade =
    ["A+", "A", "B", "C", "D", "F"].includes(gradeCandidate)
      ? (gradeCandidate as AiGrade)
      : gradeFromScore(_scoreNum);
  const _summary = parsedScore.summary.trim();
  
  // Determine final direction based on AI's evaluation
  const _direction: Side = bestDirection === "SHORT" ? "SHORT" : "LONG";

  const result: ScoredSignal = {
    ...signal,
    aiScore: _scoreNum,
    aiGrade: _grade,
    aiSummary: _summary,
    totalScore: _scoreNum,
    // Bidirectional scoring results
    aiDirection: _direction,
    longScore: clampScore(longScore),
    shortScore: clampScore(shortScore),
    bestDirection: bestDirection as "LONG" | "SHORT" | "NONE",
  };

  console.log("[aiScoring] Result:", {
    ticker: result.ticker,
    score: _scoreNum,
    grade: _grade,
  });

  try {
    await writeAiHeartbeat();
  } catch (err) {
    console.warn("[aiScoring] heartbeat update failed", err);
  }

  return { ok: true, scored: result, aiModel: model, aiRequestId: scoreResponse.requestId };
}
