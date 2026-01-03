import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

type TradeStatus = "OPEN" | "CLOSED" | "PENDING" | "PARTIAL" | string;

type Trade = {
  status: TradeStatus;
  realizedPnL?: number | null;
  closedAt?: string;
  updatedAt?: string;
  createdAt?: string;
};

function startForRange(range: string): Date | null {
  const now = new Date();
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (range === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }
  if (range === "month") {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return d;
  }
  return null;
}

function isoDay(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function tsOf(t: Trade): number {
  const iso = t.closedAt || t.updatedAt || t.createdAt;
  const n = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const range = (url.searchParams.get("range") || "all").toLowerCase();
    const start = startForRange(range);

    const trades = await readTrades<Trade>();

    const closed = trades
      .filter((t) => (t.status || "").toUpperCase() === "CLOSED")
      .filter((t) => typeof t.realizedPnL === "number")
      .filter((t) => (start ? tsOf(t) >= start.getTime() : true));

    const m = new Map<string, number>();
    for (const t of closed) {
      const ts = t.closedAt || t.updatedAt || t.createdAt;
      if (!ts) continue;
      const day = isoDay(ts);
      const pnl = typeof t.realizedPnL === "number" ? t.realizedPnL : 0;
      m.set(day, (m.get(day) || 0) + pnl);
    }

    const daily = Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, pnl]) => ({ date, pnl }));

    return NextResponse.json({ ok: true, range, daily }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Failed to load daily PnL", detail: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
