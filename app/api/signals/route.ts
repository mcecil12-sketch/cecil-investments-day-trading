import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { scoreSignalWithAI, RawSignal, ScoredSignal } from "@/lib/aiScoring";
import { sendPullbackAlert } from "@/lib/notify";

const DATA_FILE = path.join(process.cwd(), "data", "signals.json");

async function readSignals(): Promise<ScoredSignal[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return [];
    }
    console.error("[signals] readSignals error", err);
    throw err;
  }
}

async function writeSignals(signals: ScoredSignal[]): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(signals, null, 2), "utf8");
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
    signals = signals.filter((s) => s.aiScore >= minScore);
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

  // AI agent scoring step
  const scored = await scoreSignalWithAI(rawSignal);

  const signals = await readSignals();
  signals.push(scored);
  await writeSignals(signals);

  console.log("[signals] New signal scored", {
    ticker: scored.ticker,
    score: scored.aiScore,
    grade: scored.aiGrade,
  });

  // Only alert on A / 9+ scores
  if (scored.aiGrade === "A" || scored.aiScore >= 9) {
    try {
      await sendPullbackAlert(scored);
    } catch (err) {
      console.error("[signals] sendPullbackAlert failed", err);
    }
  }

  return NextResponse.json({ signal: scored });
}
