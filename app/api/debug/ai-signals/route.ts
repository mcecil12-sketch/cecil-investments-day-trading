import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { ScoredSignal } from "@/lib/aiScoring";

const DATA_FILE = path.join(process.cwd(), "data", "signals.json");

async function readSignals(): Promise<ScoredSignal[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("[debug/ai-signals] read error", err);
    throw err;
  }
}

export async function GET() {
  const signals = await readSignals();

  // Most recent first
  signals.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Only return a small subset to keep it light
  const latest = signals.slice(0, 50).map((s) => ({
    id: s.id,
    ticker: s.ticker,
    side: s.side,
    createdAt: s.createdAt,
    aiScore: s.aiScore,
    aiGrade: s.aiGrade,
    aiSummary: s.aiSummary,
    entryPrice: s.entryPrice,
    stopPrice: s.stopPrice,
    targetPrice: s.targetPrice,
  }));

  return NextResponse.json({
    count: signals.length,
    latestCount: latest.length,
    latest,
  });
}
