import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";

type TradeStatus = "OPEN" | "CLOSED" | string;

type Trade = {
  id: string;
  ticker: string;
  side: string;
  size: number;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;
  openedAt: string;
  closedAt?: string;
  createdAt?: string;
  executedAt?: string;
  updatedAt?: string;
  status: TradeStatus;
  realizedPnL?: number;
  realizedR?: number;
  lastStopAppliedAt?: string;
};

function isToday(iso?: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function computeMaxDrawdown(pnls: number[]): number {
  let maxPeak = 0;
  let maxDd = 0;
  let cum = 0;
  for (const pnl of pnls) {
    cum += pnl;
    if (cum > maxPeak) {
      maxPeak = cum;
    }
    const dd = maxPeak - cum;
    if (dd > maxDd) {
      maxDd = dd;
    }
  }
  return maxDd;
}

export async function GET() {
  try {
    const trades = await readTrades<Trade>();
    const todaysTrades = trades.filter((t) =>
  isToday(t.openedAt ?? t.createdAt ?? (t as any).executedAt ?? (t as any).updatedAt)
);
const closedToday = todaysTrades.filter(
      (t) => t.status === "CLOSED" && typeof t.realizedPnL === "number"
    );

    const wins = closedToday.filter((t) => (t.realizedPnL ?? 0) > 0).length;
    const losses = closedToday.filter((t) => (t.realizedPnL ?? 0) < 0).length;
    const breakeven = closedToday.filter(
      (t) => Math.abs(t.realizedPnL ?? 0) < 1e-6
    ).length;

    const totalRealizedPnL = closedToday.reduce(
      (sum, t) => sum + (t.realizedPnL ?? 0),
      0
    );

    const pnls = closedToday.map((t) => t.realizedPnL ?? 0);
    const maxDrawdown = computeMaxDrawdown(pnls);

    const realizedRs = closedToday
      .map((t) => t.realizedR)
      .filter((v): v is number => typeof v === "number");
    const avgRealizedR =
      realizedRs.length > 0
        ? realizedRs.reduce((sum, v) => sum + v, 0) / realizedRs.length
        : null;
    const bestR = realizedRs.length ? Math.max(...realizedRs) : null;
    const worstR = realizedRs.length ? Math.min(...realizedRs) : null;

    const autoStopsAppliedToday = trades.filter((t) =>
      isToday(t.lastStopAppliedAt)
    ).length;

    console.log("[summary] today", {
      totalTrades: todaysTrades.length,
      wins,
      losses,
      breakeven,
      totalRealizedPnL,
      avgRealizedR,
      bestR,
      worstR,
      autoStopsAppliedToday,
    });

    return NextResponse.json(
      {
        stats: {
          totalTrades: todaysTrades.length,
          wins,
          losses,
          breakeven,
          totalRealizedPnL,
          maxDrawdown,
          avgRealizedR,
          bestR,
          worstR,
          autoStopsAppliedToday,
        },
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("GET /api/trades/summary error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to compute trade stats",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}
