import { NextResponse } from "next/server";
import { nowETDate } from "@/lib/performance/time";
import { readEquityPoints, readEquityLatest } from "@/lib/performance/equityRedis";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dateET = url.searchParams.get("dateET") || nowETDate();
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 200)));

  const [points, latest] = await Promise.all([readEquityPoints(dateET, limit), readEquityLatest(dateET)]);

  return NextResponse.json({
    ok: true,
    dateET,
    points: points.points || [],
    latest: latest.latest || null,
    redis: Boolean(points.redis || latest.redis),
    degraded: Boolean(points.degraded || latest.degraded),
  });
}
