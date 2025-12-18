import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { readSignals } from "@/lib/jsonDb";

// Today feed: only scored signals at/above approval threshold
export async function GET(req: Request) {
  const url = new URL(req.url);

  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || "50")));
  const minScore = Number(process.env.APPROVAL_MIN_AI_SCORE ?? "7.5");

  let signals = await readSignals();

  signals = (signals || [])
    .filter((s: any) => {
      const status = String(s.status ?? "");
      const score = typeof s.aiScore === "number" ? s.aiScore : 0;
      return status === "SCORED" && score >= minScore;
    })
    .sort(
      (a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    .slice(0, limit);

  return NextResponse.json({ status: "ok", count: signals.length, signals });
}
