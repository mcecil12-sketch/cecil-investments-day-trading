import { buildDefaultTradePlan, parseAiTradePlan, type TradePlan } from "@/lib/tradePlan";
import OpenAI from "openai";
import { recordSpend, recordAiCall, recordAiError, writeAiHeartbeat } from "./aiMetrics";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { buildSignalContext, SignalContext } from "@/lib/signalContext";

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
  aiScore: number | null; // 0–10, numeric
  aiGrade: AiGrade | null;
  aiSummary: string; // short explanation
  totalScore: number | null;
  status?: string;
  skipReason?: string;
  tradePlan?: TradePlan | null;
  qualified?: boolean;
  shownInApp?: boolean;
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

export async function scoreSignalWithAI(rawSignal: RawSignal): Promise<ScoredSignal> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fail-safe: if key missing, treat as low-quality
    console.warn("[aiScoring] OPENAI_API_KEY not set; returning default low score.");
    return {
      ...rawSignal,
      aiScore: 0,
      aiGrade: "F",
      aiSummary: "AI scoring disabled (no API key).",
      totalScore: 0,
    };
  }

  const systemPrompt = `
You are a seasoned intraday equities trader.
You are scoring VWAP pullback setups for quality.

Rules:
- Score from 0 to 10 (decimals allowed) where:
  - 9-10 = elite, A-level, high-conviction setups.
  - 7-8.9 = good but not elite.
  - 5-6.9 = marginal/meh.
  - 0-4.9 = avoid.
- Consider:
  - Trend quality and direction.
  - Pullback quality relative to VWAP and recent range.
  - Liquidity and volume.
  - How clean/low-noise the setup seems.
- Respond ONLY as a compact JSON object: 
  {"score": number, "grade": "A"|"B"|"C"|"D"|"F", "summary": "short explanation"}.
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
    return {
      ...signal,
      aiScore: null,
      aiGrade: null,
      aiSummary: reason,
      totalScore: null,
      status: "SKIPPED",
      skipReason: reason,
      qualified: false,
      shownInApp: false,
    };
  }

  const contextBlock =
    signal.signalContext
      ? JSON.stringify(signal.signalContext, null, 2)
      : "null";

  const prompt = `
You are scoring an intraday trading signal.

Signal JSON:
${JSON.stringify(signal, null, 2)}

ComputedContext JSON (from Alpaca bars):
${contextBlock}

Return ONLY valid JSON with:
{ "aiScore": number, "aiSummary": string, "aiGrade": string, "totalScore": number }
`.trim();

  const BULK_MODEL = process.env.OPENAI_MODEL_BULK || "gpt-5-mini";
  const HEAVY_MODEL = process.env.OPENAI_MODEL_HEAVY || "gpt-5.1";
  const useHeavyModel = (signal.playbookScore ?? 0) >= 8;
  const model = useHeavyModel ? HEAVY_MODEL : BULK_MODEL;

  const openai = new OpenAI({ apiKey });
  await recordAiCall(model);

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model,
      ...(supportsCustomTemperature(model) ? { temperature: 0.3 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    });
  } catch (err: any) {
    await recordAiError(model, err?.message ?? String(err));
    throw err;
  }

  try {
    await recordSpend(model, estimateCost(model));
  } catch (e: any) {
    console.log("[aiScoring] recordSpend failed (non-fatal):", e?.message ?? String(e));
  }
  await bumpTodayFunnel({ gptScoredByModel: { [model]: 1 } });

  const content = completion.choices[0]?.message?.content ?? "{}";

  let parsed: Partial<ModelResponse>;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.error("[aiScoring] Failed to parse JSON response:", err, content);
    parsed = {};
  }

  const normalizedScore =
    typeof parsed.score === "number" && isFinite(parsed.score)
      ? Math.min(10, Math.max(0, parsed.score))
      : 0;

  const rawGrade = typeof parsed.grade === "string" && parsed.grade.trim()
    ? (parsed.grade.trim() as AiGrade)
    : gradeFromScore(normalizedScore);
  const rawSummary = typeof parsed.summary === "string" ? parsed.summary : "";

  const _scoreNum = Number.isFinite(Number(normalizedScore)) ? Number(normalizedScore) : 0;
  const _grade: AiGrade =
    rawGrade && rawGrade.trim()
      ? (rawGrade as AiGrade)
      : _scoreNum >= 9
      ? "A+"
      : _scoreNum >= 8
      ? "A"
      : _scoreNum >= 7
      ? "B"
      : _scoreNum >= 6
      ? "C"
      : _scoreNum >= 5
      ? "D"
      : "F";
  const _summary =
    typeof rawSummary === "string" && rawSummary.trim().length
      ? rawSummary.trim()
      : formatAiSummary(_grade, _scoreNum);

  const result: ScoredSignal = {
    ...signal,
    aiScore: _scoreNum,
    aiGrade: _grade,
    aiSummary: _summary,
    totalScore: _scoreNum,
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

  return result;
}
