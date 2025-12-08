import OpenAI from "openai";

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
};

export type ScoredSignal = RawSignal & {
  aiScore: number; // 0–10, numeric
  aiGrade: "A" | "B" | "C" | "D" | "F";
  aiSummary: string; // short explanation
};

type ModelResponse = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
};

function gradeFromScore(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 9) return "A";
  if (score >= 7.5) return "B";
  if (score >= 6) return "C";
  if (score >= 4) return "D";
  return "F";
}

export async function scoreSignalWithAI(signal: RawSignal): Promise<ScoredSignal> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fail-safe: if key missing, treat as low-quality
    console.warn("[aiScoring] OPENAI_API_KEY not set; returning default low score.");
    return {
      ...signal,
      aiScore: 0,
      aiGrade: "F",
      aiSummary: "AI scoring disabled (no API key).",
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

  const userPrompt = `
Evaluate this VWAP pullback setup:

Ticker: ${signal.ticker}
Side: ${signal.side}
Entry: ${signal.entryPrice}
Stop: ${signal.stopPrice}
Target: ${signal.targetPrice}
Timeframe: ${signal.timeframe}
Source: ${signal.source}
Created at: ${signal.createdAt}

Optional metrics:
VWAP: ${signal.vwap ?? "n/a"}
Pullback %: ${signal.pullbackPct ?? "n/a"}
Trend score: ${signal.trendScore ?? "n/a"}
Liquidity score: ${signal.liquidityScore ?? "n/a"}
Playbook score: ${signal.playbookScore ?? "n/a"}
Volume score: ${signal.volumeScore ?? "n/a"}
Catalyst score: ${signal.catalystScore ?? "n/a"}

Return ONLY JSON.
`.trim();

  const openai = new OpenAI({ apiKey });
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

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
  };

  console.log("[aiScoring] Result:", {
    ticker: result.ticker,
    score: result.aiScore,
    grade: result.aiGrade,
  });

  return result;
}
