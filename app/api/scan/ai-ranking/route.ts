import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { scoreSignalWithAI, ScoredSignal, RawSignal } from "@/lib/aiScoring";

const DATA_FILE = path.join(process.cwd(), "data", "signals.json");

async function readSignals(): Promise<ScoredSignal[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ScoredSignal[];
    if (parsed && Array.isArray(parsed.signals)) return parsed.signals as ScoredSignal[];
    return [];
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("[ai-ranking] read error", err);
    throw err;
  }
}

async function writeSignals(signals: ScoredSignal[]): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(signals, null, 2), "utf8");
}

function toRawSignal(s: any): RawSignal {
  return {
    id: s.id,
    ticker: s.ticker,
    side: s.side,
    entryPrice: s.entryPrice,
    stopPrice: s.stopPrice,
    targetPrice: s.targetPrice,
    timeframe: s.timeframe ?? "1Min",
    source: s.source ?? "UNKNOWN",
    createdAt: s.createdAt ?? new Date().toISOString(),
    vwap: s.vwap,
    pullbackPct: s.pullbackPct,
    trendScore: s.trendScore,
    liquidityScore: s.liquidityScore,
    playbookScore: s.playbookScore,
    volumeScore: s.volumeScore,
    catalystScore: s.catalystScore,
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const forceRescore =
      (url.searchParams.get("forceRescore") ?? "false").toLowerCase() === "true";
    const cutoffDays = parseInt(url.searchParams.get("days") ?? "2", 10);
    const cutoffTime = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;

    let signals = await readSignals();
    let rescoredCount = 0;

    // Filter to recent pending
    signals = signals.filter((s: any) => {
      const created = s.createdAt ? Date.parse(s.createdAt) : 0;
      const isRecent = created >= cutoffTime;
      const status = (s.status ?? "PENDING").toUpperCase();
      return isRecent && (status === "PENDING" || !s.status);
    });

    // Rescore as needed
    const rescoredSignals: ScoredSignal[] = [];
    for (const s of signals) {
      const needsScore =
        forceRescore ||
        s.aiScore == null ||
        Number.isNaN(s.aiScore) ||
        s.aiGrade == null;

      if (needsScore) {
        const raw = toRawSignal(s);
        const scored = await scoreSignalWithAI(raw);
        rescoredSignals.push(scored);
        rescoredCount += 1;
      } else {
        rescoredSignals.push(s);
      }
    }

    // Sort by score desc, then grade
    rescoredSignals.sort((a, b) => {
      const scoreDiff = (b.aiScore ?? 0) - (a.aiScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (b.aiGrade ?? "").localeCompare(a.aiGrade ?? "");
    });

    // Source breakdown
    const sourceCounts: Record<string, number> = {};
    for (const s of rescoredSignals) {
      const src = s.source ?? "UNKNOWN";
      sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
    }

    // Persist rescored signals back to file (optional, but keeps cache fresh)
    // Merge with any non-filtered signals (older or non-pending)
    // For simplicity, overwrite with rescored subset merged into full list
    const fullSignals = await readSignals();
    const byId: Record<string, ScoredSignal> = {};
    for (const s of fullSignals) {
      byId[s.id] = s as ScoredSignal;
    }
    for (const s of rescoredSignals) {
      byId[s.id] = s;
    }
    await writeSignals(Object.values(byId));

    return NextResponse.json({
      status: "ok",
      count: rescoredSignals.length,
      rescoredCount,
      topSignals: rescoredSignals,
      sourceCounts,
    });
  } catch (err) {
    console.error("[ai-ranking] GET error", err);
    return NextResponse.json(
      { status: "error", message: "Failed to rank signals" },
      { status: 500 }
    );
  }
}
