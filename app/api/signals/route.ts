import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { scoreSignalWithAI, RawSignal, ScoredSignal } from "@/lib/aiScoring";
import { sendPullbackAlert } from "@/lib/notify";
import { bumpFunnel } from "@/lib/funnelMetrics";
import { readSignals, writeSignals, StoredSignal } from "@/lib/jsonDb";

async function appendSignal(signal: StoredSignal) {
  const signals = await readSignals();
  signals.push(signal);
  await writeSignals(signals);
}

async function replaceSignal(scored: StoredSignal) {
  const signals = await readSignals();
  const idx = signals.findIndex((s) => s.id === scored.id);
  if (idx >= 0) {
    signals[idx] = scored;
  } else {
    signals.push(scored);
  }
  await writeSignals(signals);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const minScoreParam = url.searchParams.get("minScore");
  const gradeParam = url.searchParams.get("grade");
  const statusParam = url.searchParams.get("status"); // e.g. PENDING, APPROVED, REJECTED
  const limitParam = url.searchParams.get("limit");

  const minScore = minScoreParam ? Number(minScoreParam) : undefined;
  const limit = limitParam ? Number(limitParam) : undefined;

  let signals = await readSignals();

  if (typeof minScore === "number" && !Number.isNaN(minScore)) {
    signals = signals.filter((s) => (s.aiScore ?? 0) >= minScore);
  }

  if (gradeParam) {
    signals = signals.filter((s) => s.aiGrade === gradeParam);
  }

  if (statusParam) {
    signals = signals.filter(
      (s: any) =>
        !s.status || // default to PENDING if missing
        (statusParam === "PENDING" && (s.status === "PENDING" || !s.status)) ||
        s.status === statusParam
    );
  }

  // Most recent first
  signals.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  if (limit && limit > 0) {
    signals = signals.slice(0, limit);
  }

  return NextResponse.json({ signals });
}

export async function POST(req: Request) {
  const body = await req.json();

  const {
    ticker,
    side,
    entryPrice,
    stopPrice,
    targetPrice,
    timeframe = "1Min",
    source = "VWAP_PULLBACK",
    rawMeta = {},
  } = body;

  if (!ticker || !side || !entryPrice || !stopPrice || !targetPrice) {
    return NextResponse.json(
      { error: "Missing required fields for signal." },
      { status: 400 }
    );
  }

  bumpFunnel({ signalsReceived: 1 });

  const now = new Date().toISOString();

  const rawSignal: RawSignal = {
    id: rawMeta.id ?? `${ticker}-${now}`,
    ticker,
    side,
    entryPrice: Number(entryPrice),
    stopPrice: Number(stopPrice),
    targetPrice: Number(targetPrice),
    timeframe,
    source,
    createdAt: now,
    vwap: rawMeta.vwap,
    pullbackPct: rawMeta.pullbackPct,
    trendScore: rawMeta.trendScore,
    liquidityScore: rawMeta.liquidityScore,
    playbookScore: rawMeta.playbookScore,
    volumeScore: rawMeta.volumeScore,
    catalystScore: rawMeta.catalystScore,
  };

  const placeholder: StoredSignal = {
    ...rawSignal,
    aiScore: 0,
    aiGrade: "F",
    aiSummary: "AI scoring pending",
    totalScore: 0,
    status: "PENDING",
  };

  await appendSignal(placeholder);

  const placeholderScored: ScoredSignal = {
    ...placeholder,
    timeframe: placeholder.timeframe ?? "1Min",
    source: placeholder.source ?? "unknown",
    aiScore: placeholder.aiScore ?? 0,
    aiGrade: (placeholder.aiGrade ?? "F") as ScoredSignal["aiGrade"],
    aiSummary: placeholder.aiSummary ?? "AI scoring pending",
    totalScore: placeholder.totalScore ?? 0,
    stopPrice: rawSignal.stopPrice,
    targetPrice: rawSignal.targetPrice,
  };

  let scored: ScoredSignal = placeholderScored;
  let finalSignal: StoredSignal = placeholder;

  try {
    scored = await scoreSignalWithAI(rawSignal);
    finalSignal = {
      ...placeholder,
      ...scored,
      status: "SCORED",
    };
    await replaceSignal(finalSignal);
  } catch (err: any) {
    console.error("AI scoring failed:", err);
  }

  console.log("[signals] New signal scored", {
    ticker: scored.ticker,
    score: scored.aiScore,
    grade: scored.aiGrade,
  });

  if (typeof scored.totalScore === "number" && scored.totalScore >= 8) {
    bumpFunnel({ qualified: 1 });
  }

  if (scored.aiGrade === "A" || scored.aiScore >= 9) {
    try {
      await sendPullbackAlert(scored);
    } catch (err) {
      console.error("[signals] sendPullbackAlert failed", err);
    }
  }

  return NextResponse.json({ signal: finalSignal });
}
