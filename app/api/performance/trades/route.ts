import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

type TradeStatus = "OPEN" | "CLOSED" | "PENDING" | "PARTIAL" | string;

type Trade = {
  id: string;
  ticker: string;
  side: "LONG" | "SHORT" | string;
  status: TradeStatus;
  createdAt?: string;
  openedAt?: string;
  executedAt?: string;
  closedAt?: string;
  updatedAt?: string;
  entryPrice?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  quantity?: number;
  qty?: number;
  realizedPnL?: number | null;
  realizedR?: number | null;
  source?: string;
  paper?: boolean;
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

function tsOf(t: Trade): number {
  const iso = t.closedAt || t.updatedAt || t.executedAt || t.openedAt || t.createdAt;
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
      .filter((t) => (start ? tsOf(t) >= start.getTime() : true))
      .slice()
      .sort((a, b) => tsOf(b) - tsOf(a));

    const rows = closed.map((t) => ({
      id: t.id,
      ticker: t.ticker,
      side: t.side,
      status: t.status,
      source: (t as any).source ?? null,
      paper: (t as any).paper ?? null,
      closedAt: t.closedAt ?? null,
      entryPrice: t.entryPrice ?? null,
      realizedPnL: typeof t.realizedPnL === "number" ? t.realizedPnL : null,
      realizedR: typeof t.realizedR === "number" ? t.realizedR : null,
    }));

    return NextResponse.json({ ok: true, range, count: rows.length, trades: rows }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Failed to load trades", detail: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
