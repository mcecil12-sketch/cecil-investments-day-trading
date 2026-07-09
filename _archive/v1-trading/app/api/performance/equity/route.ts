import { NextResponse } from "next/server";
import { nowETDate } from "@/lib/performance/time";
import { readEquityPoints, readEquityLatest } from "@/lib/performance/equityRedis";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dateET = url.searchParams.get("dateET") || nowETDate();
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 200)));

  const [points, latest] = await Promise.all([readEquityPoints(dateET, limit), readEquityLatest(dateET)]);

  const debug = url.searchParams.get("debug") === "1";
  let debugInfo: any = null;

  if (debug) {
    try {
      const mod: any = await import("@/lib/performance/equityRedis");
      const keyPoints = (mod as any).__keyPointsForDebug?.(dateET) || `perf:equity:${dateET}:points`;
      const redisMod: any = await import("@/lib/redis");
      const r: any = (redisMod as any).redis;
      const rawAny: any = await (r as any)?.lrange?.(keyPoints, 0, Math.max(0, limit - 1));
      const rawArr = Array.isArray(rawAny) ? rawAny : Array.isArray(rawAny?.result) ? rawAny.result : null;

      debugInfo = {
        dateET,
        keyPoints,
        rawType: rawAny == null ? "null" : typeof rawAny,
        rawIsArray: Array.isArray(rawAny),
        rawKeys: rawAny && typeof rawAny === "object" ? Object.keys(rawAny) : null,
        rawLenGuess: rawArr != null ? rawArr.length : null,
        sample0: rawArr && rawArr.length ? rawArr[0] : null,
      };
    } catch (e: any) {
      debugInfo = { error: String(e?.message || e) };
    }
  }

  return NextResponse.json({
    debug: debugInfo,
    version: "equity_v2_lrange_shape",
    ok: true,
    dateET,
    points: points.points || [],
    latest: latest.latest || null,
    redis: Boolean(points.redis || latest.redis),
    degraded: Boolean(points.degraded || latest.degraded),
  });
}
