import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";
import { extractClosedTrades, buildAnalytics } from "@/lib/performance/tradeStats";

export const dynamic = "force-dynamic";

function rangeFilter(range: string | null, ts: string | undefined): boolean {
  if (!ts) return true;
  const r = String(range || "all").toLowerCase();
  if (r === "all") return true;

  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return true;

  const now = new Date();
  const ms = now.getTime() - d.getTime();
  const day = 24 * 60 * 60 * 1000;

  if (r === "today") return ms <= day;
  if (r === "week") return ms <= 7 * day;
  if (r === "month") return ms <= 31 * day;

  return true;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const range = url.searchParams.get("range") || "all";

  const all = await readTrades();
  const closed = extractClosedTrades(all || []).filter((t) => rangeFilter(range, t.closedAt || t.updatedAt || t.createdAt));

  const analytics = buildAnalytics(closed);

  return NextResponse.json({
    ok: true,
    range,
    meta: { closedTrades: closed.length },
    ...analytics,
  });
}
