import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { readSignals } from "@/lib/jsonDb";

export async function GET(req: Request) {
  const url = new URL(req.url);

  const limitRaw = Number(url.searchParams.get("limit") || "50");
  const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));

  const envMin = Number(process.env.APPROVAL_MIN_AI_SCORE ?? "7.5");
  const minScoreParam = url.searchParams.get("minScore");
  const minScore = minScoreParam == null ? envMin : Number(minScoreParam);

  const safeMinScore = Number.isFinite(minScore) ? minScore : envMin;

  const raw = await readSignals();

  const scored = (raw || []).filter((s: any) => {
    const status = String(s?.status ?? "");
    const score = typeof s?.aiScore === "number" ? s.aiScore : 0;
    return status === "SCORED" && score >= safeMinScore;
  });

  scored.sort(
    (a: any, b: any) =>
      new Date(b?.createdAt ?? 0).getTime() - new Date(a?.createdAt ?? 0).getTime()
  );

  const signals = scored.slice(0, limit);

  return NextResponse.json({
    status: "ok",
    count: signals.length,
    signals,
    debug: {
      usedMinScore: safeMinScore,
      envApprovalMin: envMin,
      totalSignals: raw?.length ?? 0,
      scoredSignals: scored.length,
      limit,
    },
  });
}
