import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { minScoreToQualify } from "@/lib/aiQualify";

export const dynamic = "force-dynamic";

type Signal = {
  id?: string;
  ticker: string;
  createdAt?: string;
  status?: string;
  // canonical fields (aiScore/grade/score)
  aiScore?: number;
  score?: number;
  grade?: string;
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

  const url = new URL(req.url);
  const base = `${url.protocol}//${url.host}`;
  const resp = await fetch(`${base}/api/signals/all?since=48h&onlyActive=1&order=desc&limit=500`, {
    headers: {
      cookie: req.headers.get("cookie") || "",
    },
    cache: "no-store",
  });

  if (!resp.ok) {
    return NextResponse.json(
      { ok: false, error: "failed_to_load_signals", status: resp.status },
      { status: 500 }
    );
  }

  const raw = await resp.json();
  const list: Signal[] = Array.isArray(raw) ? raw : raw?.signals ?? [];

  const scored = list
    .filter((s) => s && (s.aiScore != null || s.grade != null || s.score != null))
    .map((s) => ({
      ticker: s.ticker,
      createdAt: s.createdAt,
      status: s.status,
      score: toNum(s.aiScore ?? s.score),
      grade: (s.grade ?? null) as string | null,
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

  const min = minScoreToQualify();

  const qualifiedByThreshold = scored.filter(
    (s) =>
      (s.status || "").toUpperCase() === "SCORED" &&
      typeof s.score === "number" &&
      s.score >= min
  ).length;

  const qualifiedByStatus = scored.filter(
    (s) => (s.status || "").toUpperCase() === "QUALIFIED"
  ).length;

  const total = scored.length;

  const recent = scored
    .filter((s) => (s.status ?? "").toUpperCase() !== "ARCHIVED")
    .slice(0, 20);

  return NextResponse.json({
    ok: true,
    totalScored: total,
    qualified: qualifiedByThreshold,
    qualifiedRate: total ? qualifiedByThreshold / total : 0,
    qualifiedByThreshold,
    qualifiedByStatus,
    minScoreToQualify: min,
    avgScore: n ? sum / n : null,
    gradeCounts,
    recent,
    source: "api/signals/all",
  });
}
