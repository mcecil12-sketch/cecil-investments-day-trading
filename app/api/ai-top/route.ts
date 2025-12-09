// CODEx: FILE: app/api/ai-top/route.ts
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

type SignalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | string;

interface StoredSignal {
  id: string;
  ticker: string;
  side: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  createdAt: string;
  status?: SignalStatus;
  aiScore?: number;
  aiGrade?: string;
  source?: string;
  [key: string]: any;
}

const DATA_DIR = path.join(process.cwd(), "data");
const SIGNALS_PATH = path.join(DATA_DIR, "signals.json");

async function readSignalsFile(): Promise<StoredSignal[]> {
  try {
    const raw = await fs.readFile(SIGNALS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray((parsed as any).signals)) return (parsed as any).signals;
    return [];
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const searchParams = url.searchParams;

  const minScore = Number(searchParams.get("minScore") ?? "9") || 9;
  const limit = Number(searchParams.get("limit") ?? "50") || 50;

  const signals = await readSignalsFile();

  const top = signals
    .filter((s) => {
      const status = (s.status ?? "PENDING") as SignalStatus;
      const score = s.aiScore ?? 0;
      const grade = (s.aiGrade ?? "").toUpperCase();

      if (status !== "PENDING") return false;

      const isAGrade = grade === "A";
      const isHighScore = score >= minScore;

      return isAGrade || isHighScore;
    })
    .sort((a, b) => {
      const as = a.aiScore ?? 0;
      const bs = b.aiScore ?? 0;
      if (bs !== as) return bs - as;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, limit);

  return NextResponse.json({
    status: "ok",
    count: top.length,
    signals: top,
  });
}
