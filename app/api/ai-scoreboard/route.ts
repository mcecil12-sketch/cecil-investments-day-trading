import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

type Signal = {
  id?: string;
  ticker: string;
  createdAt?: string;
  status?: string;
  score?: number;
  grade?: string;
  ai?: { score?: number; grade?: string };
};

function toNum(x: any) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: Request) {
  const authed = await requireAuth(req);
  if (!authed.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const key = "signals:all:v1";
  const raw = await redis?.get<Signal[]>(key);
  const list: Signal[] = Array.isArray(raw) ? raw : [];

  const scored = list
    .filter((s) => (s.ai?.score ?? s.score) !== undefined || (s.ai?.grade ?? s.grade))
    .map((s) => ({
      ticker: s.ticker,
      createdAt: s.createdAt,
      status: s.status,
      score: toNum(s.ai?.score ?? s.score),
      grade: (s.ai?.grade ?? s.grade ?? null) as string | null,
    }));

  const gradeCounts: Record<string, number> = {};
  let sum = 0;
  let n = 0;

  for (const s of scored) {
    if (s.grade) gradeCounts[s.grade] = (gradeCounts[s.grade] || 0) + 1;
    if (typeof s.score === "number") {
      sum += s.score;
      n++;
    }
  }

  const qualified = scored.filter((s) => (s.status ?? "").toUpperCase().includes("QUAL")).length;
  const total = scored.length;

  return NextResponse.json({
    ok: true,
    totalScored: total,
    qualified,
    qualifiedRate: total ? qualified / total : 0,
    avgScore: n ? sum / n : null,
    gradeCounts,
    recent: scored.slice(-20).reverse(),
    keyUsed: key,
  });
}
