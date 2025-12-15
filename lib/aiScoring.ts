import OpenAI from "openai";
import { recordSpend, recordAiCall, recordAiError } from "./aiMetrics";
import { bumpFunnel } from "./funnelMetrics";
import { buildSignalContext, SignalContext } from "@/lib/signalContext";

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

export type ScoredSignal = RawSignal & {
  aiScore: number; // 0–10, numeric
  aiGrade: "A" | "B" | "C" | "D" | "F";
  aiSummary: string; // short explanation
  totalScore: number;
};

type ModelResponse = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
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

function gradeFromScore(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 9) return "A";
  if (score >= 7.5) return "B";
  if (score >= 6) return "C";
  if (score >= 4) return "D";
  return "F";
}

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
  const needsContext =
    rawSignal.vwap == null ||
    rawSignal.trendScore == null ||
    rawSignal.volumeScore == null ||
    rawSignal.liquidityScore == null;

  let ctx: any = null;
  if (needsContext) {
    try {
      ctx = await buildSignalContext({
        ticker: rawSignal.ticker,
        timeframe,
        limit: 90,
        endTimeIso: rawSignal.createdAt || (rawSignal as any).timestamp || undefined,
      });
    } catch (e: any) {
      console.log("[aiScoring] context build failed (non-fatal):", e?.message ?? String(e));
      ctx = null;
    }
  }

  const signal = ctx
    ? {
        ...rawSignal,
        signalContext: ctx,
      }
    : rawSignal;

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
  bumpFunnel({ gptScored: 1, gptScoredByModel: { [model]: 1 } });

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

  const grade = parsed.grade ?? gradeFromScore(normalizedScore);
  const summary = parsed.summary ?? "No summary provided by AI.";

  const result: ScoredSignal = {
    ...signal,
    aiScore: normalizedScore,
    aiGrade: grade,
    aiSummary: summary,
    totalScore: normalizedScore,
  };

  console.log("[aiScoring] Result:", {
    ticker: result.ticker,
    score: result.aiScore,
    grade: result.aiGrade,
  });

  return result;
}
